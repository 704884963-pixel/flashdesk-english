// Crash-recoverable coordinator for full backup restore. It does not claim a
// cross-localStorage/IndexedDB transaction; it keeps a validated old snapshot
// until every target domain has been replaced and the journal is committed.

((global) => {
  const JOURNAL_KEY = 'flashdesk-restore-journal-v1';
  const RECOVERY_KEY = 'flashdesk-restore-recovery-v1';
  const VERSION = 1;
  const PHASES = ['prepared', 'learning', 'articles', 'ai', 'usage', 'committed'];
  const MODES = ['restore_target', 'rollback_original'];
  const PROTECTION_ERROR = '无法创建恢复保护副本，备份恢复已取消。现有学习数据没有改变。';
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function fingerprintRaw(raw) {
    let hash = 2166136261;
    for (let index = 0; index < raw.length; index += 1) {
      hash ^= raw.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${raw.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function createProtocol({
    storage = global.localStorage,
    validate = global.FlashBackup?.validate,
    now = () => new Date().toISOString(),
    random = () => Math.random().toString(16).slice(2),
  } = {}) {
    if (!storage || typeof validate !== 'function') throw new Error('恢复保护不可用');

    function readJournal() {
      const raw = storage.getItem(JOURNAL_KEY);
      if (raw === null) return null;
      let value;
      try { value = JSON.parse(raw); } catch { throw new Error('恢复日志损坏'); }
      if (!value || value.version !== VERSION || typeof value.operationId !== 'string'
          || typeof value.startedAt !== 'string' || !MODES.includes(value.mode)
          || !PHASES.includes(value.phase) || typeof value.recoveryFingerprint !== 'string'
          || typeof value.targetFingerprint !== 'string') {
        throw new Error('恢复日志损坏');
      }
      return value;
    }

    function writeJournal(journal) {
      storage.setItem(JOURNAL_KEY, JSON.stringify(journal));
      return journal;
    }

    function readRecovery(journal = readJournal()) {
      if (!journal) throw new Error('没有可用的恢复日志');
      const raw = storage.getItem(RECOVERY_KEY);
      if (raw === null || fingerprintRaw(raw) !== journal.recoveryFingerprint) {
        throw new Error('恢复保护副本损坏，请不要继续修改学习数据。');
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        throw new Error('恢复保护副本损坏，请不要继续修改学习数据。');
      }
      try { return validate(parsed); } catch {
        throw new Error('恢复保护副本损坏，请不要继续修改学习数据。');
      }
    }

    function prepare(recoverySnapshot, targetBackup) {
      const recovery = validate(recoverySnapshot);
      const target = validate(targetBackup);
      const recoveryRaw = JSON.stringify(recovery);
      const targetRaw = JSON.stringify(target);
      const journal = {
        version: VERSION,
        operationId: `${Date.now()}-${random()}`,
        startedAt: now(),
        mode: 'restore_target',
        phase: 'prepared',
        recoveryFingerprint: fingerprintRaw(recoveryRaw),
        targetFingerprint: fingerprintRaw(targetRaw),
      };
      // Recovery material is durable and verified before applying can begin.
      try {
        storage.setItem(RECOVERY_KEY, recoveryRaw);
        if (storage.getItem(RECOVERY_KEY) !== recoveryRaw) throw new Error('recovery snapshot verification failed');
        readRecovery(journal);
      } catch {
        try { storage.removeItem(RECOVERY_KEY); } catch { /* No journal is published, so this cannot block startup. */ }
        throw new Error(PROTECTION_ERROR);
      }
      try {
        writeJournal(journal);
      } catch {
        // A failed journal publication must not leave a recoverable operation
        // or start applying the target. The snapshot is now only an orphan.
        try { storage.removeItem(JOURNAL_KEY); } catch { /* setItem failure is atomic in Web Storage. */ }
        try { storage.removeItem(RECOVERY_KEY); } catch { /* inspect() safely ignores an orphan. */ }
        throw new Error(PROTECTION_ERROR);
      }
      return { journal: clone(journal), recovery, target };
    }

    function markPhase(phase) {
      if (!PHASES.includes(phase)) throw new Error('恢复阶段无效');
      const journal = readJournal();
      if (!journal) throw new Error('恢复日志不存在');
      journal.phase = phase;
      writeJournal(journal);
      return clone(journal);
    }

    function beginRollback() {
      const journal = readJournal();
      if (!journal) throw new Error('恢复日志不存在');
      journal.mode = 'rollback_original';
      journal.phase = 'prepared';
      writeJournal(journal);
      return readRecovery(journal);
    }

    function cleanupCommitted() {
      // committed is persisted before either artifact is removed. A crash after
      // this point can only leave harmless cleanup work, never trigger rollback.
      storage.removeItem(RECOVERY_KEY);
      storage.removeItem(JOURNAL_KEY);
    }

    function commitAndCleanup() {
      markPhase('committed');
      try {
        cleanupCommitted();
        return { cleaned: true };
      } catch (error) {
        // The restore is already committed. Cleanup failure must never make the
        // caller roll NEW data back; the next startup only retries cleanup.
        return { cleaned: false, error: error.message };
      }
    }

    async function apply(backup, adapters) {
      const validated = validate(backup);
      await adapters.replaceLearning(validated.learning);
      markPhase('learning');
      await adapters.replaceArticles(validated.articles);
      markPhase('articles');
      await adapters.replaceAi(validated.aiLearning);
      markPhase('ai');
      await adapters.replaceUsage(validated.usageStats);
      markPhase('usage');
      return validated;
    }

    function inspect() {
      let journal;
      try { journal = readJournal(); } catch (error) {
        return { status: 'corrupt', error: error.message };
      }
      if (!journal) {
        // A crash or journal write failure may leave recovery material without
        // an operation. It is not evidence of an incomplete restore.
        if (storage.getItem(RECOVERY_KEY) !== null) {
          try {
            storage.removeItem(RECOVERY_KEY);
            return { status: 'idle', cleanedOrphan: true };
          } catch {
            return { status: 'idle', ignoredOrphan: true };
          }
        }
        return { status: 'idle' };
      }
      if (journal.phase === 'committed') {
        try {
          cleanupCommitted();
          return { status: 'idle', cleanedCommitted: true };
        } catch (error) {
          return { status: 'committed_cleanup', journal: clone(journal), error: error.message };
        }
      }
      try {
        const recovery = readRecovery(journal);
        return { status: 'recovery_required', journal: clone(journal), recovery };
      } catch (error) {
        return { status: 'corrupt', journal: clone(journal), error: error.message };
      }
    }

    return {
      prepare, inspect, readJournal, readRecovery, markPhase, beginRollback,
      apply, commitAndCleanup, cleanupCommitted,
    };
  }

  const api = { JOURNAL_KEY, RECOVERY_KEY, VERSION, PHASES, MODES, PROTECTION_ERROR, fingerprintRaw, createProtocol };
  global.FlashRestoreProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

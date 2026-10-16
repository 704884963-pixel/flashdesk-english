const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Backup = require('../public/backup.js');
const Restore = require('../public/restore-protocol.js');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

function backup(label) {
  return Backup.create({
    exportedAt: label === 'OLD' ? '2026-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z',
    learning: {
      cards: [{ id: `card-${label}`, deck: 'Words', front: label, back: label, due: 1, streak: 0, lapses: 0, created: 1 }],
      history: [{ date: '2026-01-01', label }], meta: { nextWordNumber: 2 },
    },
    articles: { articles: [{ id: `article-${label}`, title: label, content: `${label}.` }], unknownWords: [label] },
    aiLearning: { generations: [{ type: 'sentences', targetWords: [label], primary: label }] },
    usageStats: { version: 1, days: { '2026-01-01': { activeSeconds: 300, sessionCount: 1, areas: { review: 300, words: 0, aiLearning: 0, reading: 0, other: 0 } } } },
  });
}

function memoryStorage() {
  const values = new Map();
  let failRemove = false;
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem(key) { if (failRemove) throw new Error('cleanup crash'); values.delete(key); },
    value: (key) => values.get(key),
    failRemove: (value) => { failRemove = value; },
  };
}

function domainState(snapshot) {
  return {
    learning: clone(snapshot.learning), articles: clone(snapshot.articles),
    aiLearning: clone(snapshot.aiLearning), usageStats: clone(snapshot.usageStats),
  };
}

function adapters(domains, failBefore = '') {
  const replace = (name, value) => {
    if (failBefore === name) throw new Error(`crash-before-${name}`);
    domains[name] = clone(value);
  };
  return {
    replaceLearning: (value) => replace('learning', value),
    replaceArticles: (value) => replace('articles', value),
    replaceAi: (value) => replace('aiLearning', value),
    replaceUsage: (value) => replace('usageStats', value),
  };
}

function countedAdapters(domains) {
  const counts = { learning: 0, articles: 0, aiLearning: 0, usageStats: 0 };
  const replace = (name, value) => {
    counts[name] += 1;
    domains[name] = clone(value);
  };
  return {
    counts,
    adapters: {
      replaceLearning: (value) => replace('learning', value),
      replaceArticles: (value) => replace('articles', value),
      replaceAi: (value) => replace('aiLearning', value),
      replaceUsage: (value) => replace('usageStats', value),
    },
  };
}

async function recoverAfterRestart(storage, domains) {
  const restarted = Restore.createProtocol({ storage, validate: Backup.validate });
  const inspection = restarted.inspect();
  assert.equal(inspection.status, 'recovery_required');
  const recovery = restarted.beginRollback();
  await restarted.apply(recovery, adapters(domains));
  restarted.commitAndCleanup();
  return restarted.inspect();
}

test('prepare validates target and recovery before making a journal', () => {
  const storage = memoryStorage();
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  const invalid = backup('NEW'); invalid.learning.cards.push(clone(invalid.learning.cards[0]));
  assert.throws(() => protocol.prepare(backup('OLD'), invalid), /重复卡片/);
  assert.equal(storage.getItem(Restore.JOURNAL_KEY), null);
  assert.equal(storage.getItem(Restore.RECOVERY_KEY), null);
});

test('recovery snapshot quota failure cancels before every business-store mutation', async () => {
  const old = backup('OLD'); const target = backup('NEW');
  const domains = domainState(old); const writes = countedAdapters(domains);
  const base = memoryStorage();
  const storage = {
    ...base,
    setItem(key, value) {
      if (key === Restore.RECOVERY_KEY) {
        const error = new Error('secret quota details');
        error.name = 'QuotaExceededError';
        throw error;
      }
      base.setItem(key, value);
    },
  };
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  await assert.rejects(async () => {
    protocol.prepare(old, target);
    await protocol.apply(target, writes.adapters);
  }, new RegExp(Restore.PROTECTION_ERROR));
  assert.deepEqual(writes.counts, { learning: 0, articles: 0, aiLearning: 0, usageStats: 0 });
  assert.deepEqual(domains, domainState(old));
  assert.equal(storage.getItem(Restore.JOURNAL_KEY), null);
  assert.equal(storage.getItem(Restore.RECOVERY_KEY), null);
});

test('journal write failure cancels restore and cleans the durable orphan snapshot', async () => {
  const old = backup('OLD'); const target = backup('NEW');
  const domains = domainState(old); const writes = countedAdapters(domains);
  const base = memoryStorage();
  const storage = {
    ...base,
    setItem(key, value) {
      if (key === Restore.JOURNAL_KEY) throw new Error('journal storage failure');
      base.setItem(key, value);
    },
  };
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  await assert.rejects(async () => {
    protocol.prepare(old, target);
    await protocol.apply(target, writes.adapters);
  }, new RegExp(Restore.PROTECTION_ERROR));
  assert.deepEqual(writes.counts, { learning: 0, articles: 0, aiLearning: 0, usageStats: 0 });
  assert.deepEqual(domains, domainState(old));
  assert.equal(storage.getItem(Restore.JOURNAL_KEY), null);
  assert.equal(storage.getItem(Restore.RECOVERY_KEY), null);
});

test('orphan recovery snapshot without a journal is cleaned and never blocks startup', () => {
  const storage = memoryStorage();
  storage.setItem(Restore.RECOVERY_KEY, JSON.stringify(backup('OLD')));
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  assert.deepEqual(protocol.inspect(), { status: 'idle', cleanedOrphan: true });
  assert.equal(storage.getItem(Restore.RECOVERY_KEY), null);
  assert.equal(protocol.inspect().status, 'idle');
});

test('journal carries durable phase, mode, operation identity and both fingerprints', () => {
  const storage = memoryStorage();
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate, random: () => 'fixed' });
  protocol.prepare(backup('OLD'), backup('NEW'));
  const journal = JSON.parse(storage.getItem(Restore.JOURNAL_KEY));
  assert.deepEqual(Object.keys(journal).sort(), [
    'mode', 'operationId', 'phase', 'recoveryFingerprint', 'startedAt', 'targetFingerprint', 'version',
  ]);
  assert.equal(journal.mode, 'restore_target');
  assert.equal(journal.phase, 'prepared');
  assert.match(journal.recoveryFingerprint, /^\d+:[0-9a-f]{8}$/);
});

for (const [label, failBefore, expectedPhase] of [
  ['prepared', 'learning', 'prepared'],
  ['FlashStore', 'articles', 'learning'],
  ['ArticleStore', 'aiLearning', 'articles'],
  ['AI history', 'usageStats', 'ai'],
]) {
  test(`${label} interruption is detected after restart and fully rolls back all four domains`, async () => {
    const old = backup('OLD'); const target = backup('NEW');
    const storage = memoryStorage(); const domains = domainState(old);
    const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
    protocol.prepare(old, target);
    await assert.rejects(protocol.apply(target, adapters(domains, failBefore)), /crash-before/);
    assert.equal(JSON.parse(storage.getItem(Restore.JOURNAL_KEY)).phase, expectedPhase);

    const inspection = Restore.createProtocol({ storage, validate: Backup.validate }).inspect();
    assert.equal(inspection.status, 'recovery_required');
    assert.equal((await recoverAfterRestart(storage, domains)).status, 'idle');
    assert.deepEqual(domains, domainState(old));
  });
}

test('an interruption after usage write remains recoverable', async () => {
  const old = backup('OLD'); const target = backup('NEW');
  const storage = memoryStorage(); const domains = domainState(old);
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  protocol.prepare(old, target);
  await protocol.apply(target, adapters(domains));
  assert.equal(JSON.parse(storage.getItem(Restore.JOURNAL_KEY)).phase, 'usage');
  assert.equal((await recoverAfterRestart(storage, domains)).status, 'idle');
  assert.deepEqual(domains, domainState(old));
});

test('rollback interruption keeps rollback_original journal and can retry the same old snapshot', async () => {
  const old = backup('OLD'); const target = backup('NEW');
  const storage = memoryStorage(); const domains = domainState(old);
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  protocol.prepare(old, target);
  await assert.rejects(protocol.apply(target, adapters(domains, 'articles')), /crash/);
  const recovery = protocol.beginRollback();
  await assert.rejects(protocol.apply(recovery, adapters(domains, 'articles')), /crash/);
  const journal = JSON.parse(storage.getItem(Restore.JOURNAL_KEY));
  assert.equal(journal.mode, 'rollback_original');
  assert.equal(journal.phase, 'learning');
  assert.equal((await recoverAfterRestart(storage, domains)).status, 'idle');
  assert.deepEqual(domains, domainState(old));
});

test('committed journal left before artifact cleanup keeps NEW and only cleans remnants', async () => {
  const old = backup('OLD'); const target = backup('NEW');
  const storage = memoryStorage(); const domains = domainState(old);
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  protocol.prepare(old, target);
  await protocol.apply(target, adapters(domains));
  protocol.markPhase('committed'); // crash before cleanupCommitted()
  const restarted = Restore.createProtocol({ storage, validate: Backup.validate });
  assert.deepEqual(restarted.inspect(), { status: 'idle', cleanedCommitted: true });
  assert.deepEqual(domains, domainState(target));
  assert.equal(storage.getItem(Restore.JOURNAL_KEY), null);
  assert.equal(storage.getItem(Restore.RECOVERY_KEY), null);
});

test('cleanup failure after committed never rolls NEW back', async () => {
  const old = backup('OLD'); const target = backup('NEW');
  const storage = memoryStorage(); const domains = domainState(old);
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  protocol.prepare(old, target);
  await protocol.apply(target, adapters(domains));
  storage.failRemove(true);
  assert.deepEqual(protocol.commitAndCleanup(), { cleaned: false, error: 'cleanup crash' });
  assert.equal(JSON.parse(storage.getItem(Restore.JOURNAL_KEY)).phase, 'committed');
  assert.deepEqual(domains, domainState(target));
  storage.failRemove(false);
  assert.deepEqual(Restore.createProtocol({ storage, validate: Backup.validate }).inspect(), { status: 'idle', cleanedCommitted: true });
  assert.deepEqual(domains, domainState(target));
});

test('corrupt recovery snapshot blocks recovery and is never deleted or guessed', () => {
  const storage = memoryStorage();
  const protocol = Restore.createProtocol({ storage, validate: Backup.validate });
  protocol.prepare(backup('OLD'), backup('NEW'));
  storage.setItem(Restore.RECOVERY_KEY, '{broken');
  const result = Restore.createProtocol({ storage, validate: Backup.validate }).inspect();
  assert.equal(result.status, 'corrupt');
  assert.match(result.error, /保护副本损坏/);
  assert.notEqual(storage.getItem(Restore.JOURNAL_KEY), null);
  assert.equal(storage.getItem(Restore.RECOVERY_KEY), '{broken');
});

test('recovery UI blocks mutations, offers rollback or defer, and never auto reloads on detection', () => {
  assert.match(htmlSource, /id="restore-recovery-dialog"/);
  assert.match(htmlSource, /恢复到操作前状态/);
  assert.match(htmlSource, /暂不处理/);
  assert.match(appSource, /function assertRestoreResolved\(\)/);
  for (const operation of ['gradeCard', 'addCard', 'updateCard', 'deleteCard', 'logSession', 'importBatch', 'importData']) {
    assert.match(appSource, new RegExp(`FlashStore\\.${operation}`));
  }
  assert.ok((appSource.match(/assertRestoreResolved\(\)/g) || []).length >= 12);
  const detection = appSource.slice(appSource.indexOf('function detectRestoreRecovery'), appSource.indexOf('async function recoverInterruptedRestore'));
  assert.doesNotMatch(detection, /location\.reload/);
  assert.match(appSource, /if \(!state\.backup\.restoreBlocked\) usageTracker\.start\(\)/);
});

test('restore orchestration keeps FD-01 and FD-03 boundaries', () => {
  const restore = appSource.slice(appSource.indexOf('async function restoreFullBackup'), appSource.indexOf('function renderRestoreRecoveryPrompt'));
  assert.match(restore, /assertRestoreResolved\(\)/);
  assert.match(restore, /FlashBackup\.validate\(backup\)/);
  assert.match(restore, /FlashBackup\.validate\(await collectFullBackup\(\)\)/);
  assert.match(restore, /STORE_CONFLICT/);
  assert.match(appSource, /replaceLearning: \(learning\) => FlashStore\.replaceSnapshot\(learning\)/);
});

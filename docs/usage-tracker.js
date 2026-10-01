// FlashDesk effective-learning usage tracker.
//
// This module deliberately stores device-local usage separately from cards,
// review history, Articles, and AI history. Its clock, storage, and browser
// surfaces are injectable so all timing behavior can be tested without sleeps.

((global) => {
  const STORAGE_KEY = 'flashdesk-usage-stats-v1';
  const GOAL_KEY = 'flashdesk-daily-goal-minutes-v1';
  const VERSION = 1;
  const DEFAULT_GOAL_MINUTES = 20;
  const VALID_DAY_SECONDS = 300;
  const IDLE_MS = 120000;
  const HEARTBEAT_MS = 20000;
  const MAX_TICK_MS = 60000;
  const FLUSH_MS = 60000;
  const AREAS = ['review', 'words', 'aiLearning', 'reading', 'other'];

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const finiteNonnegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;

  function emptyAreas() {
    return Object.fromEntries(AREAS.map((area) => [area, 0]));
  }

  function emptyDay() {
    return { activeSeconds: 0, sessionCount: 0, areas: emptyAreas() };
  }

  function emptyStats() {
    return { version: VERSION, days: {} };
  }

  function normalizeArea(area) {
    return AREAS.includes(area) ? area : 'other';
  }

  function normalizeStats(value) {
    const result = emptyStats();
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value.version !== undefined && value.version !== VERSION)) return result;
    const days = value.days && typeof value.days === 'object' && !Array.isArray(value.days) ? value.days : {};
    for (const [date, source] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !source || typeof source !== 'object') continue;
      const day = emptyDay();
      day.activeSeconds = finiteNonnegative(source.activeSeconds) ? Number(source.activeSeconds) : 0;
      day.sessionCount = Number.isSafeInteger(source.sessionCount) && source.sessionCount >= 0 ? source.sessionCount : 0;
      let areaTotal = 0;
      for (const area of AREAS) {
        const seconds = finiteNonnegative(source.areas?.[area]) ? Number(source.areas[area]) : 0;
        day.areas[area] = seconds;
        areaTotal += seconds;
      }
      // Corrupt/old values must never claim more per-area time than total time.
      if (areaTotal > day.activeSeconds && areaTotal > 0) {
        const scale = day.activeSeconds / areaTotal;
        for (const area of AREAS) day.areas[area] *= scale;
      }
      result.days[date] = day;
    }
    return result;
  }

  function localDateKey(timestamp) {
    const date = new Date(timestamp);
    const two = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  }

  function addLocalDays(timestamp, offset) {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
  }

  function nextLocalMidnight(timestamp) {
    return addLocalDays(timestamp, 1);
  }

  function dayFrom(stats, date) {
    return stats.days[date] ? clone(stats.days[date]) : emptyDay();
  }

  function currentStreak(statsValue, timestamp = Date.now()) {
    const stats = normalizeStats(statsValue);
    let cursor = new Date(timestamp);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    if (dayFrom(stats, localDateKey(cursor.getTime())).activeSeconds < VALID_DAY_SECONDS) {
      cursor = new Date(addLocalDays(cursor.getTime(), -1));
    }
    let count = 0;
    while (dayFrom(stats, localDateKey(cursor.getTime())).activeSeconds >= VALID_DAY_SECONDS) {
      count += 1;
      cursor = new Date(addLocalDays(cursor.getTime(), -1));
    }
    return count;
  }

  function recentDaysStats(statsValue, count, timestamp = Date.now()) {
    const stats = normalizeStats(statsValue);
    const length = Math.max(1, Math.min(366, Math.trunc(Number(count) || 0)));
    const today = new Date(timestamp);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const days = [];
    for (let offset = length - 1; offset >= 0; offset -= 1) {
      const date = localDateKey(addLocalDays(todayStart, -offset));
      days.push({ date, ...dayFrom(stats, date) });
    }
    const totalSeconds = days.reduce((sum, day) => sum + day.activeSeconds, 0);
    return {
      days,
      totalSeconds,
      averageSeconds: totalSeconds / length,
      validLearningDays: days.filter((day) => day.activeSeconds >= VALID_DAY_SECONDS).length,
    };
  }

  function localDateOrdinal(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const value = new Date(timestamp);
    if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
    return Math.floor(timestamp / 86400000);
  }

  function allTimeStats(statsValue, timestamp = Date.now()) {
    const stats = normalizeStats(statsValue);
    const todayOrdinal = localDateOrdinal(localDateKey(timestamp));
    const days = Object.entries(stats.days)
      .map(([date, value]) => ({ date, ordinal: localDateOrdinal(date), activeSeconds: value.activeSeconds }))
      .filter((day) => day.ordinal !== null && day.ordinal <= todayOrdinal)
      .sort((a, b) => a.ordinal - b.ordinal);
    const totalSeconds = days.reduce((sum, day) => sum + day.activeSeconds, 0);
    const activeDays = days.filter((day) => day.activeSeconds >= VALID_DAY_SECONDS).length;
    const first = days.find((day) => day.activeSeconds > 0) || null;
    const calendarDays = first ? Math.max(1, todayOrdinal - first.ordinal + 1) : 0;
    let longestStreak = 0;
    let streak = 0;
    let previousOrdinal = null;
    for (const day of days) {
      if (day.activeSeconds >= VALID_DAY_SECONDS) {
        streak = previousOrdinal !== null && day.ordinal === previousOrdinal + 1 ? streak + 1 : 1;
        longestStreak = Math.max(longestStreak, streak);
      } else {
        streak = 0;
      }
      previousOrdinal = day.ordinal;
    }
    return {
      totalSeconds,
      activeDays,
      calendarDays,
      averageSecondsPerActiveDay: activeDays ? totalSeconds / activeDays : 0,
      averageSecondsPerCalendarDay: calendarDays ? totalSeconds / calendarDays : 0,
      longestStreak,
      firstLearningDate: first?.date || null,
    };
  }

  function normalizeGoal(value) {
    const minutes = Math.round(Number(value));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw new Error('每日目标须为 1～240 分钟');
    return minutes;
  }

  function createTracker(options = {}) {
    const storage = options.storage || global.localStorage;
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const documentRef = options.document || global.document;
    const windowRef = options.window || global.window;
    const getArea = typeof options.getArea === 'function' ? options.getArea : () => 'other';
    const idleMs = Number(options.idleMs) || IDLE_MS;
    const heartbeatMs = Number(options.heartbeatMs) || HEARTBEAT_MS;
    const maxTickMs = Number(options.maxTickMs) || MAX_TICK_MS;
    const flushMs = Number(options.flushMs) || FLUSH_MS;
    const intervalSet = options.setInterval || global.setInterval;
    const intervalClear = options.clearInterval || global.clearInterval;

    let stats = emptyStats();
    try { stats = normalizeStats(JSON.parse(storage?.getItem(STORAGE_KEY) || 'null')); } catch { stats = emptyStats(); }
    let goalMinutes = DEFAULT_GOAL_MINUTES;
    try {
      const saved = Number(storage?.getItem(GOAL_KEY));
      if (Number.isFinite(saved) && saved >= 1 && saved <= 240) goalMinutes = Math.round(saved);
    } catch { /* unavailable storage */ }

    let visible = options.visible === undefined
      ? (!documentRef || documentRef.visibilityState === 'visible')
      : Boolean(options.visible);
    let area = normalizeArea(getArea());
    let lastActivityAt = null;
    let lastTickAt = clock();
    let sessionActive = false;
    let dirty = false;
    let lastFlushAt = lastTickAt;
    let timer = null;
    let started = false;

    function ensureDay(date) {
      if (!stats.days[date]) stats.days[date] = emptyDay();
      return stats.days[date];
    }

    function addInterval(start, end, targetArea) {
      let cursor = start;
      while (cursor < end) {
        const boundary = nextLocalMidnight(cursor);
        const partEnd = Math.min(end, boundary);
        const seconds = (partEnd - cursor) / 1000;
        const day = ensureDay(localDateKey(cursor));
        day.activeSeconds += seconds;
        day.areas[targetArea] += seconds;
        cursor = partEnd;
      }
      dirty = true;
    }

    function persist(at = clock(), force = false) {
      if (!dirty || (!force && at - lastFlushAt < flushMs)) return false;
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(stats));
        dirty = false;
        lastFlushAt = at;
        return true;
      } catch {
        return false;
      }
    }

    function heartbeat(at = clock()) {
      const time = Number(at);
      if (!Number.isFinite(time)) return 0;
      if (!visible || !sessionActive || lastActivityAt === null) {
        lastTickAt = time;
        return 0;
      }
      const effectiveEnd = Math.min(time, lastActivityAt + idleMs);
      const elapsed = Math.max(0, effectiveEnd - lastTickAt);
      const counted = Math.min(elapsed, maxTickMs);
      if (counted > 0) addInterval(lastTickAt, lastTickAt + counted, area);
      // Always move the baseline to now: repeated immediate ticks cannot catch
      // up a long browser suspension that was intentionally capped.
      lastTickAt = time;
      if (time - lastActivityAt >= idleMs) sessionActive = false;
      persist(time, false);
      return counted / 1000;
    }

    function recordActivity(at = clock()) {
      const time = Number(at);
      if (!visible || !Number.isFinite(time)) return false;
      const wasSessionActive = sessionActive && lastActivityAt !== null && time - lastActivityAt < idleMs;
      heartbeat(time);
      lastActivityAt = time;
      lastTickAt = time;
      if (!wasSessionActive) {
        sessionActive = true;
        ensureDay(localDateKey(time)).sessionCount += 1;
        dirty = true;
      } else {
        sessionActive = true;
      }
      return true;
    }

    function setArea(nextArea, at = clock()) {
      const normalized = normalizeArea(nextArea);
      if (normalized === area) return area;
      heartbeat(at);
      area = normalized;
      return area;
    }

    function setVisibility(nextVisible, at = clock()) {
      const time = Number(at);
      if (!nextVisible) {
        heartbeat(time);
        visible = false;
        sessionActive = false;
        lastActivityAt = null;
        lastTickAt = time;
        persist(time, true);
      } else {
        visible = true;
        sessionActive = false;
        lastActivityAt = null;
        lastTickAt = time;
      }
    }

    function handleVisibility() {
      setVisibility(documentRef?.visibilityState === 'visible', clock());
    }

    function handlePageHide() {
      setVisibility(false, clock());
    }

    function handleActivity() {
      recordActivity(clock());
    }

    const activityEvents = ['pointerdown', 'touchstart', 'click', 'keydown', 'scroll'];

    function start() {
      if (started) return;
      started = true;
      area = normalizeArea(getArea());
      lastTickAt = clock();
      for (const event of activityEvents) {
        documentRef?.addEventListener?.(event, handleActivity, { passive: true, capture: event === 'scroll' });
      }
      documentRef?.addEventListener?.('visibilitychange', handleVisibility);
      windowRef?.addEventListener?.('pagehide', handlePageHide);
      if (typeof intervalSet === 'function') timer = intervalSet(() => heartbeat(clock()), heartbeatMs);
    }

    function stop() {
      if (!started) return;
      heartbeat(clock());
      persist(clock(), true);
      for (const event of activityEvents) documentRef?.removeEventListener?.(event, handleActivity, event === 'scroll');
      documentRef?.removeEventListener?.('visibilitychange', handleVisibility);
      windowRef?.removeEventListener?.('pagehide', handlePageHide);
      if (timer !== null && typeof intervalClear === 'function') intervalClear(timer);
      timer = null;
      started = false;
    }

    function snapshot(at = clock()) {
      heartbeat(at);
      return clone(stats);
    }

    function replaceStats(value) {
      const previousStats = stats;
      const previousDirty = dirty;
      const nextStats = normalizeStats(value);
      stats = nextStats;
      dirty = true;
      if (!persist(clock(), true)) {
        stats = previousStats;
        dirty = previousDirty;
        throw new Error('学习统计无法写入本地存储');
      }
      // A restored snapshot must not inherit the runtime session/baseline from
      // the data it replaced. The next real interaction starts a fresh session.
      sessionActive = false;
      lastActivityAt = null;
      lastTickAt = clock();
      return clone(stats);
    }

    function getTodayStats(at = clock()) {
      const value = snapshot(at);
      return { date: localDateKey(at), ...dayFrom(value, localDateKey(at)) };
    }

    function getRecentDaysStats(count, at = clock()) {
      return recentDaysStats(snapshot(at), count, at);
    }

    function getCurrentStreak(at = clock()) {
      return currentStreak(snapshot(at), at);
    }

    function getAllTimeStats(at = clock()) {
      return allTimeStats(snapshot(at), at);
    }

    function getAreaBreakdown(date = localDateKey(clock())) {
      heartbeat(clock());
      return clone(dayFrom(stats, date).areas);
    }

    function getDailyGoal() {
      return goalMinutes;
    }

    function setDailyGoal(value) {
      goalMinutes = normalizeGoal(value);
      try { storage?.setItem(GOAL_KEY, String(goalMinutes)); } catch { /* unavailable storage */ }
      return goalMinutes;
    }

    function getDailyGoalProgress(at = clock()) {
      const today = getTodayStats(at);
      const goalSeconds = goalMinutes * 60;
      return {
        goalMinutes,
        goalSeconds,
        activeSeconds: today.activeSeconds,
        remainingSeconds: Math.max(0, goalSeconds - today.activeSeconds),
        percent: Math.min(100, (today.activeSeconds / goalSeconds) * 100),
        complete: today.activeSeconds >= goalSeconds,
      };
    }

    return {
      start, stop, heartbeat, recordActivity, setArea, setVisibility, persist,
      exportStats: snapshot, replaceStats, getTodayStats, getRecentDaysStats,
      getCurrentStreak, getAllTimeStats, getAreaBreakdown, getDailyGoal, setDailyGoal,
      getDailyGoalProgress,
      debugState: () => ({ visible, area, lastActivityAt, lastTickAt, sessionActive, dirty }),
    };
  }

  const api = {
    STORAGE_KEY, GOAL_KEY, VERSION, DEFAULT_GOAL_MINUTES, VALID_DAY_SECONDS,
    IDLE_MS, HEARTBEAT_MS, MAX_TICK_MS, FLUSH_MS, AREAS,
    emptyStats, emptyDay, normalizeStats, normalizeArea, normalizeGoal,
    localDateKey, currentStreak, recentDaysStats, allTimeStats, createTracker,
  };
  global.FlashUsageTracker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

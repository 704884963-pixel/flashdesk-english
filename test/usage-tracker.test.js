const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Usage = require('../public/usage-tracker.js');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); writes.push([key, String(value)]); },
    removeItem(key) { values.delete(key); },
    value(key) { return values.get(key); },
  };
}

function trackerAt(start, options = {}) {
  let now = start;
  const storage = options.storage || memoryStorage();
  const tracker = Usage.createTracker({
    storage,
    now: () => now,
    visible: options.visible ?? true,
    getArea: options.getArea || (() => 'review'),
    setInterval: () => 1,
    clearInterval: () => {},
    ...options,
  });
  return {
    tracker, storage,
    setNow(value) { now = value; },
    advance(ms) { now += ms; return now; },
    now() { return now; },
  };
}

const noon = (day = 1) => new Date(2026, 9, day, 12, 0, 0).getTime();

test('usage storage is independent and versioned', () => {
  assert.equal(Usage.STORAGE_KEY, 'flashdesk-usage-stats-v1');
  assert.deepEqual(Usage.emptyStats(), { version: 1, days: {} });
});

test('visible active time accumulates after real activity', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.heartbeat(h.advance(20000));
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 20);
});

test('opening a visible page without activity does not count', () => {
  const h = trackerAt(noon()); h.tracker.heartbeat(h.advance(60000));
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 0);
});

test('hidden page does not accumulate', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.setVisibility(false, h.advance(10000));
  h.tracker.heartbeat(h.advance(60000));
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 10);
});

test('hidden to visible never backfills background time', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.setVisibility(false, h.advance(10000));
  h.advance(30 * 60000); h.tracker.setVisibility(true, h.now());
  h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(10000));
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 20);
});

test('two minutes of idle ends effective accumulation', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  for (let i = 0; i < 7; i += 1) h.tracker.heartbeat(h.advance(20000));
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 120);
  assert.equal(h.tracker.debugState().sessionActive, false);
});

test('activity after idle resumes with a new session', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.heartbeat(h.advance(120000));
  h.tracker.recordActivity(h.advance(1000)); h.tracker.heartbeat(h.advance(20000));
  const today = h.tracker.getTodayStats(h.now());
  assert.equal(today.sessionCount, 2); assert.equal(today.activeSeconds, 80);
});

test('one frozen-tab jump counts at most 60 seconds', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.heartbeat(h.advance(10 * 60000));
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 60);
});

test('repeated immediate ticks cannot catch up a frozen-tab jump', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.heartbeat(h.advance(10 * 60000)); h.tracker.heartbeat(h.now()); h.tracker.heartbeat(h.now());
  assert.equal(h.tracker.getTodayStats(h.now()).activeSeconds, 60);
});

test('active interval crossing local midnight is split by natural day', () => {
  const start = new Date(2026, 8, 30, 23, 59, 50).getTime();
  const h = trackerAt(start); h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(20000));
  const stats = h.tracker.exportStats(h.now());
  assert.equal(stats.days['2026-09-30'].activeSeconds, 10);
  assert.equal(stats.days['2026-10-01'].activeSeconds, 10);
});

test('thirty seconds across midnight splits active and area seconds 10 plus 20', () => {
  const start = new Date(2026, 8, 30, 23, 59, 50).getTime();
  const h = trackerAt(start); h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(30000));
  const stats = h.tracker.exportStats(h.now());
  assert.equal(stats.days['2026-09-30'].activeSeconds, 10);
  assert.equal(stats.days['2026-09-30'].areas.review, 10);
  assert.equal(stats.days['2026-10-01'].activeSeconds, 20);
  assert.equal(stats.days['2026-10-01'].areas.review, 20);
});

for (const [area, expected] of [['review', 'review'], ['words', 'words'], ['aiLearning', 'aiLearning'], ['reading', 'reading'], ['unknown', 'other']]) {
  test(`${area} activity is attributed to ${expected}`, () => {
    const h = trackerAt(noon(), { getArea: () => area });
    h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(10000));
    assert.equal(h.tracker.getAreaBreakdown()[expected], 10);
  });
}

test('changing area settles old view then counts the actually displayed view', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.setArea('words', h.advance(10000)); h.tracker.heartbeat(h.advance(15000));
  const areas = h.tracker.getAreaBreakdown();
  assert.equal(areas.review, 10); assert.equal(areas.words, 15);
});

test('area total never exceeds active total', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(30000));
  const day = h.tracker.getTodayStats(h.now());
  assert.equal(Object.values(day.areas).reduce((sum, value) => sum + value, 0), day.activeSeconds);
});

test('continuous clicks stay in one session', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity();
  h.tracker.recordActivity(h.advance(10000)); h.tracker.recordActivity(h.advance(10000));
  assert.equal(h.tracker.getTodayStats(h.now()).sessionCount, 1);
});

test('hidden ends a session and next visible activity starts another', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity(); h.tracker.setVisibility(false, h.advance(5000));
  h.tracker.setVisibility(true, h.advance(5000)); h.tracker.recordActivity();
  assert.equal(h.tracker.getTodayStats(h.now()).sessionCount, 2);
});

test('less than five minutes is not a valid learning day', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 299, sessionCount: 1, areas: {} } } };
  assert.equal(Usage.currentStreak(stats, noon()), 0);
});

test('five minutes is a valid learning day', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 300, sessionCount: 1, areas: {} } } };
  assert.equal(Usage.currentStreak(stats, noon()), 1);
});

test('current streak counts consecutive qualifying days', () => {
  const stats = { version: 1, days: {
    '2026-09-29': { activeSeconds: 300 }, '2026-09-30': { activeSeconds: 600 }, '2026-10-01': { activeSeconds: 301 },
  } };
  assert.equal(Usage.currentStreak(stats, noon()), 3);
});

test('an incomplete today does not erase yesterday streak', () => {
  const stats = { version: 1, days: {
    '2026-09-29': { activeSeconds: 300 }, '2026-09-30': { activeSeconds: 300 }, '2026-10-01': { activeSeconds: 25 },
  } };
  assert.equal(Usage.currentStreak(stats, noon()), 2);
});

test('a gap before yesterday stops the streak', () => {
  const stats = { version: 1, days: {
    '2026-09-28': { activeSeconds: 300 }, '2026-09-30': { activeSeconds: 300 },
  } };
  assert.equal(Usage.currentStreak(stats, noon()), 1);
});

test('recent seven days fills dates with zero values', () => {
  const result = Usage.recentDaysStats(Usage.emptyStats(), 7, noon());
  assert.equal(result.days.length, 7); assert.ok(result.days.every((day) => day.activeSeconds === 0));
});

test('recent thirty days fills dates with zero values', () => {
  const result = Usage.recentDaysStats(Usage.emptyStats(), 30, noon());
  assert.equal(result.days.length, 30); assert.equal(result.days[0].sessionCount, 0);
});

test('recent seven-day total and average are correct', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 700 }, '2026-09-30': { activeSeconds: 140 } } };
  const result = Usage.recentDaysStats(stats, 7, noon());
  assert.equal(result.totalSeconds, 840); assert.equal(result.averageSeconds, 120);
});

test('recent stats count valid learning days', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 300 }, '2026-09-30': { activeSeconds: 299 } } };
  assert.equal(Usage.recentDaysStats(stats, 30, noon()).validLearningDays, 1);
});

test('all-time stats are safe when there is no history', () => {
  assert.deepEqual(Usage.allTimeStats(Usage.emptyStats(), noon()), {
    totalSeconds: 0, activeDays: 0, calendarDays: 0,
    averageSecondsPerActiveDay: 0, averageSecondsPerCalendarDay: 0,
    longestStreak: 0, firstLearningDate: null,
  });
});

test('all-time stats summarize one learning day', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 600 } } };
  assert.deepEqual(Usage.allTimeStats(stats, noon()), {
    totalSeconds: 600, activeDays: 1, calendarDays: 1,
    averageSecondsPerActiveDay: 600, averageSecondsPerCalendarDay: 600,
    longestStreak: 1, firstLearningDate: '2026-10-01',
  });
});

test('all-time totalSeconds includes every recorded historical day', () => {
  const stats = { version: 1, days: {
    '2026-09-29': { activeSeconds: 100 }, '2026-09-30': { activeSeconds: 200 }, '2026-10-01': { activeSeconds: 300 },
  } };
  assert.equal(Usage.allTimeStats(stats, noon()).totalSeconds, 600);
});

test('299 seconds is not an all-time active day', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 299 } } };
  const result = Usage.allTimeStats(stats, noon());
  assert.equal(result.activeDays, 0); assert.equal(result.longestStreak, 0);
});

test('300 seconds is an all-time active day', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 300 } } };
  const result = Usage.allTimeStats(stats, noon());
  assert.equal(result.activeDays, 1); assert.equal(result.longestStreak, 1);
});

test('all-time longestStreak counts consecutive valid learning days', () => {
  const stats = { version: 1, days: {
    '2026-09-28': { activeSeconds: 300 }, '2026-09-29': { activeSeconds: 301 },
    '2026-09-30': { activeSeconds: 900 }, '2026-10-01': { activeSeconds: 10 },
  } };
  assert.equal(Usage.allTimeStats(stats, noon()).longestStreak, 3);
});

test('a missing or short day interrupts the all-time longest streak', () => {
  const stats = { version: 1, days: {
    '2026-09-27': { activeSeconds: 300 }, '2026-09-28': { activeSeconds: 300 },
    '2026-09-29': { activeSeconds: 299 }, '2026-10-01': { activeSeconds: 300 },
  } };
  assert.equal(Usage.allTimeStats(stats, noon()).longestStreak, 2);
});

test('firstLearningDate ignores earlier zero-time records', () => {
  const stats = { version: 1, days: {
    '2026-09-01': { activeSeconds: 0 }, '2026-09-20': { activeSeconds: 1 }, '2026-10-01': { activeSeconds: 300 },
  } };
  assert.equal(Usage.allTimeStats(stats, noon()).firstLearningDate, '2026-09-20');
});

test('all-time average per active day uses total time divided by valid days', () => {
  const stats = { version: 1, days: {
    '2026-09-29': { activeSeconds: 300 }, '2026-09-30': { activeSeconds: 150 }, '2026-10-01': { activeSeconds: 450 },
  } };
  const result = Usage.allTimeStats(stats, noon());
  assert.equal(result.activeDays, 2); assert.equal(result.averageSecondsPerActiveDay, 450);
});

test('all-time calendar average includes missing days since first learning', () => {
  const stats = { version: 1, days: {
    '2026-09-29': { activeSeconds: 300 }, '2026-10-01': { activeSeconds: 300 },
  } };
  const result = Usage.allTimeStats(stats, noon());
  assert.equal(result.calendarDays, 3); assert.equal(result.averageSecondsPerCalendarDay, 200);
});

test('all-time consecutive dates work across a month boundary', () => {
  const stats = { version: 1, days: {
    '2026-09-30': { activeSeconds: 300 }, '2026-10-01': { activeSeconds: 300 },
  } };
  assert.equal(Usage.allTimeStats(stats, noon()).longestStreak, 2);
});

test('all-time consecutive dates and calendar days work across a year boundary', () => {
  const now = new Date(2027, 0, 1, 12, 0, 0).getTime();
  const stats = { version: 1, days: {
    '2026-12-31': { activeSeconds: 300 }, '2027-01-01': { activeSeconds: 600 },
  } };
  const result = Usage.allTimeStats(stats, now);
  assert.equal(result.longestStreak, 2); assert.equal(result.calendarDays, 2);
});

test('all-time stats are not limited to the most recent thirty days', () => {
  const stats = { version: 1, days: {
    '2026-01-01': { activeSeconds: 600 }, '2026-10-01': { activeSeconds: 300 },
  } };
  const result = Usage.allTimeStats(stats, noon());
  assert.equal(result.totalSeconds, 900); assert.equal(result.activeDays, 2);
  assert.equal(result.firstLearningDate, '2026-01-01');
});

test('all-time calculations do not mutate or add derived fields to usageStats', () => {
  const stats = { version: 1, days: { '2026-10-01': { activeSeconds: 300, sessionCount: 1, areas: {} } } };
  const before = structuredClone(stats);
  Usage.allTimeStats(stats, noon());
  assert.deepEqual(stats, before);
  const h = trackerAt(noon()); h.tracker.replaceStats(stats); h.tracker.getAllTimeStats(noon());
  assert.deepEqual(Object.keys(h.tracker.exportStats(noon())).sort(), ['days', 'version']);
});

test('daily goal defaults to twenty minutes', () => {
  const h = trackerAt(noon()); assert.equal(h.tracker.getDailyGoal(), 20);
});

test('daily goal accepts presets and custom values', () => {
  const h = trackerAt(noon());
  for (const goal of [10, 20, 30, 45, 60, 37]) assert.equal(h.tracker.setDailyGoal(goal), goal);
});

test('daily goal rejects unreasonable values', () => {
  const h = trackerAt(noon());
  assert.throws(() => h.tracker.setDailyGoal(0), /1～240/); assert.throws(() => h.tracker.setDailyGoal(241), /1～240/);
});

test('daily goal persists separately from usage stats', () => {
  const storage = memoryStorage(); const h = trackerAt(noon(), { storage }); h.tracker.setDailyGoal(45);
  assert.equal(storage.value(Usage.GOAL_KEY), '45'); assert.equal(storage.value(Usage.STORAGE_KEY), undefined);
});

test('daily goal progress reports capped percent and remaining time', () => {
  const h = trackerAt(noon()); h.tracker.setDailyGoal(10); h.tracker.recordActivity();
  h.tracker.heartbeat(h.advance(60000));
  const progress = h.tracker.getDailyGoalProgress(h.now());
  assert.equal(progress.percent, 10); assert.equal(progress.remainingSeconds, 540); assert.equal(progress.complete, false);
});

test('heartbeat does not write storage every tick', () => {
  const storage = memoryStorage(); const h = trackerAt(noon(), { storage }); h.tracker.recordActivity();
  h.tracker.heartbeat(h.advance(20000)); h.tracker.heartbeat(h.advance(20000));
  assert.equal(storage.writes.filter(([key]) => key === Usage.STORAGE_KEY).length, 0);
  h.tracker.heartbeat(h.advance(20000));
  assert.equal(storage.writes.filter(([key]) => key === Usage.STORAGE_KEY).length, 1);
});

test('hidden immediately flushes dirty usage', () => {
  const storage = memoryStorage(); const h = trackerAt(noon(), { storage }); h.tracker.recordActivity();
  h.tracker.setVisibility(false, h.advance(10000));
  assert.equal(storage.writes.filter(([key]) => key === Usage.STORAGE_KEY).length, 1);
});

test('replaceStats persists a normalized snapshot', () => {
  const storage = memoryStorage(); const h = trackerAt(noon(), { storage });
  h.tracker.replaceStats({ version: 1, days: { '2026-10-01': { activeSeconds: 12, sessionCount: 1, areas: { words: 12 } } } });
  assert.equal(JSON.parse(storage.value(Usage.STORAGE_KEY)).days['2026-10-01'].areas.words, 12);
});

test('replaceStats rejects a failed storage write and retains the previous snapshot', () => {
  const storage = memoryStorage(); const h = trackerAt(noon(), { storage });
  h.tracker.replaceStats({ version: 1, days: { '2026-10-01': { activeSeconds: 12, sessionCount: 1, areas: { words: 12 } } } });
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => h.tracker.replaceStats({ version: 1, days: {} }), /无法写入/);
  assert.equal(h.tracker.exportStats(h.now()).days['2026-10-01'].activeSeconds, 12);
});

test('replaceStats clears the old runtime session so restored data cannot inherit it', () => {
  const h = trackerAt(noon()); h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(10000));
  h.tracker.replaceStats({ version: 1, days: {} });
  assert.equal(h.tracker.debugState().sessionActive, false);
  h.tracker.heartbeat(h.advance(20000));
  assert.deepEqual(h.tracker.exportStats(h.now()), { version: 1, days: {} });
  h.tracker.recordActivity();
  assert.equal(h.tracker.getTodayStats(h.now()).sessionCount, 1);
});

test('normalization treats missing areas and malformed old values safely', () => {
  const stats = Usage.normalizeStats({ days: { '2026-10-01': { activeSeconds: 10, sessionCount: -1 } } });
  assert.deepEqual(stats.days['2026-10-01'], { activeSeconds: 10, sessionCount: 0, areas: Usage.emptyDay().areas });
});

test('normalization prevents area totals from exceeding active seconds', () => {
  const stats = Usage.normalizeStats({ days: { '2026-10-01': { activeSeconds: 10, areas: { review: 10, words: 10 } } } });
  assert.equal(stats.days['2026-10-01'].areas.review, 5); assert.equal(stats.days['2026-10-01'].areas.words, 5);
});

test('usage APIs never mutate cards or review history', () => {
  const cards = [{ id: 'c1', due: 1, streak: 2, lapses: 3 }]; const history = [{ reviewed: 4 }];
  const before = structuredClone({ cards, history }); const h = trackerAt(noon());
  h.tracker.recordActivity(); h.tracker.heartbeat(h.advance(20000)); h.tracker.getRecentDaysStats(7); h.tracker.getCurrentStreak();
  assert.deepEqual({ cards, history }, before);
});

test('persisted usage survives tracker recreation', () => {
  const storage = memoryStorage(); const first = trackerAt(noon(), { storage });
  first.tracker.recordActivity(); first.tracker.setVisibility(false, first.advance(15000));
  const second = trackerAt(noon(), { storage });
  assert.equal(second.tracker.getTodayStats(noon()).activeSeconds, 15);
});

test('browser activity listeners include pointer touch click key and scroll', () => {
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener() {},
  };
  const window = { addEventListener() {}, removeEventListener() {} };
  const h = trackerAt(noon(), { document, window }); h.tracker.start();
  for (const name of ['pointerdown', 'touchstart', 'click', 'keydown', 'scroll']) assert.equal(typeof listeners.get(name), 'function');
});

test('pagehide listener flushes and ends the session', () => {
  let pagehide;
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const window = { addEventListener(name, handler) { if (name === 'pagehide') pagehide = handler; }, removeEventListener() {} };
  const storage = memoryStorage(); const h = trackerAt(noon(), { storage, document, window }); h.tracker.start();
  h.tracker.recordActivity(); h.advance(12000); pagehide();
  assert.equal(JSON.parse(storage.value(Usage.STORAGE_KEY)).days['2026-10-01'].activeSeconds, 12);
  assert.equal(h.tracker.debugState().visible, false);
});

test('app maps actual displayed views to the five usage areas', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const section = app.slice(app.indexOf('function usageAreaForView'), app.indexOf('const usageTracker'));
  assert.match(section, /review: 'review'/); assert.match(section, /words: 'words'/);
  assert.match(section, /ai: 'aiLearning'/); assert.match(section, /reading: 'reading'/);
  assert.match(app, /usageTracker\.setArea\(usageAreaForView\(name\)\)/);
});

test('minimal Learning Statistics view exposes today areas sessions streak summaries and goal', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const id of ['usage-today-time', 'usage-session-count', 'usage-streak', 'usage-goal-progress', 'usage-area-list', 'usage-recent-summary']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('usage tracker loads before backup and app scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('usage-tracker.js') < html.indexOf('backup.js'));
  assert.ok(html.indexOf('usage-tracker.js') < html.indexOf('app.js'));
});

test('PWA precaches usage and backup modules for offline startup', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../pwa/sw.js'), 'utf8');
  assert.match(sw, /'usage-tracker\.js'/); assert.match(sw, /'backup\.js'/);
});

test('daily goal setting is not part of the full backup', () => {
  const backup = fs.readFileSync(path.join(__dirname, '../public/backup.js'), 'utf8');
  assert.doesNotMatch(backup, /dailyGoalMinutes|flashdesk-daily-goal-minutes-v1/);
});

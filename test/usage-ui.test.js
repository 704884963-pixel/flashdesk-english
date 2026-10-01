const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Usage = require('../public/usage-tracker.js');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const appSource = source('public/app.js');
const html = source('public/index.html');
const css = source('public/styles.css');

/* ---------- executable harness: real tracker + real renderUsageView ---------- */

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _store: store,
  };
}

function dayKey(timestamp, offset = 0) {
  const base = new Date(timestamp);
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Builds a tracker seeded with explicit per-day data and evaluates the shipped
// renderUsageView against a DOM stand-in that records every write.
function usageHarness({ days = {}, goal = 20, now = new Date('2026-10-01T21:45:00').getTime() } = {}) {
  const storage = memoryStorage();
  storage.setItem(Usage.STORAGE_KEY, JSON.stringify({ version: 1, days }));
  storage.setItem(Usage.GOAL_KEY, String(goal));
  const tracker = Usage.createTracker({ storage, now: () => now, document: null, window: null, getArea: () => 'other', visible: false });
  const write = {};
  const renderSource = appSource.slice(appSource.indexOf('/* ---------- effective learning usage'), appSource.indexOf('/* ---------- views ----------'));
  const sandbox = {
    usageTracker: tracker,
    FlashUsageTracker: Usage,
    state: { view: 'usage' },
    window: {},
    document: { querySelector: () => null },
  };
  sandbox.$ = (selector) => ({
    set textContent(value) { write[`${selector}:text`] = value; },
    get textContent() { return write[`${selector}:text`]; },
    set innerHTML(value) { write[`${selector}:html`] = value; },
    set hidden(value) { write[`${selector}:hidden`] = value; },
    setAttribute(name, value) { write[`${selector}:${name}`] = value; },
    style: {},
    get value() { return write[`${selector}:value`]; },
    set value(value) { write[`${selector}:value`] = value; },
  });
  vm.runInNewContext(`${renderSource}\nrenderUsageView();`, sandbox);
  return { tracker, storage, write, now, render: () => vm.runInNewContext('renderUsageView();', sandbox) };
}

// Six of the last seven days have records; day -3 is intentionally absent so
// the "missing day reads 0分钟" behaviour is exercised.
const sampleDays = (now) => ({
  [dayKey(now, 0)]: { activeSeconds: 26 * 60, sessionCount: 3, areas: { review: 11 * 60, reading: 8 * 60, aiLearning: 4 * 60, words: 3 * 60, other: 0 } },
  [dayKey(now, -1)]: { activeSeconds: 31 * 60, sessionCount: 2, areas: { review: 31 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } },
  [dayKey(now, -2)]: { activeSeconds: 24 * 60, sessionCount: 2, areas: { review: 24 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } },
  [dayKey(now, -4)]: { activeSeconds: 45 * 60, sessionCount: 2, areas: { review: 45 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } },
  [dayKey(now, -5)]: { activeSeconds: 12 * 60, sessionCount: 1, areas: { review: 12 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } },
  [dayKey(now, -6)]: { activeSeconds: 8 * 60, sessionCount: 1, areas: { review: 8 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } },
});

/* ---------- 1. navigation entry ---------- */

test('More menu offers Learning Statistics right before Data Backup', () => {
  const menu = html.slice(html.indexOf('<div class="nav-more-menu"'), html.indexOf('</nav>'));
  assert.match(menu, /data-view="usage"[^>]*>学习统计</);
  assert.match(menu, /data-view="usage"[\s\S]*data-view="backup"/);
});

test('Learning Statistics is reachable as a view without a new primary tab', () => {
  const beforeMenu = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('<div class="nav-more">'));
  assert.doesNotMatch(beforeMenu, /data-view="usage"/);
  assert.match(appSource, /MORE_VIEWS = new Set\(\['reading', 'add', 'quiz', 'browse', 'usage', 'backup'\]\)/);
});

/* ---------- 2. the page opens and renders ---------- */

test('opening Learning Statistics renders the page from live tracker data', () => {
  const section = appSource.slice(appSource.indexOf("} else if (name === 'usage')"), appSource.indexOf('/* ---------- events'));
  assert.match(section, /renderUsageView\(\)/);
  const { write } = usageHarness({ days: sampleDays(Date.now()) });
  assert.ok(write['#usage-today-time:text']);
});

/* ---------- 3–7. headline numbers ---------- */

test('today effective time shows friendly minutes, never raw seconds', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.equal(write['#usage-today-time:text'], '26分钟');
});

test('the daily goal is shown as progress against the configured target', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()), goal: 45 });
  assert.equal(write['#usage-goal-progress:text'], '26分钟 / 45分钟');
  assert.equal(write['#usage-goal-progress-bar:aria-valuenow'], '58');
});

test('a completed goal is announced without celebration', () => {
  const now = new Date('2026-10-01T21:45:00').getTime();
  const days = sampleDays(now);
  days[dayKey(now, 0)] = { activeSeconds: 50 * 60, sessionCount: 1, areas: { review: 50 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } };
  const { write } = usageHarness({ days, goal: 45, now });
  assert.equal(write['#usage-goal-done:hidden'], false);
  assert.equal(write['#usage-goal-fill:text'], undefined); // fill width is set via style, not text
});

test('the streak is shown from the tracker', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.equal(write['#usage-streak:text'], '3 天');
});

test('an incomplete day never reads as already finished', () => {
  const now = new Date('2026-10-01T21:45:00').getTime();
  const days = sampleDays(now);
  days[dayKey(now, 0)] = { activeSeconds: 2 * 60, sessionCount: 1, areas: { review: 2 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } };
  const { write } = usageHarness({ days, now });
  assert.equal(write['#usage-streak-note:hidden'], false);
  assert.match(write['#usage-streak-note:text'], /今天还差 3分钟 达到有效学习日/);
  // The streak still reports the run through yesterday, which the note qualifies.
  assert.equal(write['#usage-streak:text'], '2 天');
});

test('a finished day hides the remaining-time note', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.equal(write['#usage-streak-note:hidden'], true);
});

test('today session count is read from the tracker, not a second counter', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.equal(write['#usage-session-count:text'], '3 次');
  assert.doesNotMatch(appSource, /sessionCount\s*\+\+|sessionCount\s*\+=/);
});

/* ---------- 8. area breakdown ---------- */

test('today area breakdown lists the four study areas in order', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  const block = write['#usage-area-list:html'];
  assert.ok(block.indexOf('复习') < block.indexOf('阅读'));
  assert.ok(block.indexOf('阅读') < block.indexOf('AI学习'));
  assert.ok(block.indexOf('AI学习') < block.indexOf('单词库'));
  assert.match(block, /usage-area-bar/);
  assert.match(block, /11分钟/);
  assert.match(block, /3分钟/);
});

test('a zero area still shows 0分钟 while an empty other area is hidden', () => {
  const now = new Date('2026-10-01T21:45:00').getTime();
  const days = sampleDays(now);
  days[dayKey(now, 0)] = { activeSeconds: 10 * 60, sessionCount: 1, areas: { review: 10 * 60, reading: 0, aiLearning: 0, words: 0, other: 0 } };
  const { write } = usageHarness({ days, now });
  const block = write['#usage-area-list:html'];
  assert.match(block, /单词库[\s\S]*?0分钟/);
  assert.doesNotMatch(block, /其他/);
});

test('a meaningful other bucket appears as 其他', () => {
  const now = new Date('2026-10-01T21:45:00').getTime();
  const days = sampleDays(now);
  days[dayKey(now, 0)] = { activeSeconds: 10 * 60, sessionCount: 1, areas: { review: 5 * 60, reading: 0, aiLearning: 0, words: 0, other: 5 * 60 } };
  const { write } = usageHarness({ days, now });
  assert.match(write['#usage-area-list:html'], /其他/);
});

/* ---------- 9–12. recent days ---------- */

test('seven day bars always render seven calendar days', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.equal((write['#usage-week-bars:html'].match(/usage-day-row/g) || []).length, 7);
});

test('a day without records shows 0分钟 instead of disappearing', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.match(write['#usage-week-bars:html'], /0分钟/);
});

test('seven day bars are labelled today, yesterday and dated days', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  const block = write['#usage-week-bars:html'];
  assert.match(block, /今天/);
  assert.match(block, /昨天/);
  assert.match(block, /09\/28/);
});

test('the seven day summary reports total, daily average and valid days', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  const block = write['#usage-week-summary:html'];
  assert.match(block, /总计 2小时26分钟/);
  assert.match(block, /日均 20分钟/);
  assert.match(block, /有效学习 6 天/);
});

test('the thirty day summary reports total, daily average and valid days', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  const block = write['#usage-recent-summary:html'];
  assert.match(block, /近 30 天/);
  assert.match(block, /总计 2小时26分钟/);
  assert.match(block, /日均 4分钟/);
  assert.match(block, /有效学习 6 天/);
});

test('thirty day view is three summaries rather than thirty bars', () => {
  const { write } = usageHarness({ days: sampleDays(new Date('2026-10-01T21:45:00').getTime()) });
  assert.equal((write['#usage-recent-summary:html'].match(/usage-day-row/g) || []).length, 0);
  assert.equal((write['#usage-recent-summary:html'].match(/class="usage-period"/g) || []).length, 1);
});

test('the all-time panel displays totals, valid days, longest streak, active-day average and first date', () => {
  const now = new Date('2026-10-01T21:45:00').getTime();
  const { write } = usageHarness({ days: sampleDays(now), now });
  const block = write['#usage-all-time:html'];
  assert.match(block, /总学习[\s\S]*2小时26分钟/);
  assert.match(block, /有效学习[\s\S]*6 天/);
  assert.match(block, /最长连续[\s\S]*3 天/);
  assert.match(block, /有效学习日日均[\s\S]*24分钟/);
  assert.match(block, /开始记录[\s\S]*2026-09-25/);
});

test('the all-time panel handles a completely new learner', () => {
  const { write } = usageHarness({ days: {}, now: new Date('2026-10-01T12:00:00').getTime() });
  const block = write['#usage-all-time:html'];
  assert.match(block, /总学习[\s\S]*0分钟/);
  assert.match(block, /有效学习[\s\S]*0 天/);
  assert.match(block, /最长连续[\s\S]*0 天/);
  assert.match(block, /开始记录[\s\S]*—/);
});

test('all-time duration remains hours and minutes beyond one hundred hours', () => {
  const now = new Date('2026-10-01T12:00:00').getTime();
  const days = { [dayKey(now)]: { activeSeconds: (126 * 60 + 18) * 60, sessionCount: 1, areas: {} } };
  const { write } = usageHarness({ days, now });
  assert.match(write['#usage-all-time:html'], /总学习<\/span><strong>126小时18分钟/);
  assert.doesNotMatch(write['#usage-all-time:html'], /总学习<\/span><strong>\d+天/);
});

/* ---------- time formatting ---------- */

test('durations use friendly units and never raw seconds', () => {
  const { write } = usageHarness({ days: {}, now: Date.now() });
  const duration = (seconds) => {
    const days = { [dayKey(Date.now(), 0)]: { activeSeconds: seconds, sessionCount: 1, areas: { review: seconds, reading: 0, aiLearning: 0, words: 0, other: 0 } } };
    return usageHarness({ days, now: Date.now() }).write['#usage-today-time:text'];
  };
  assert.equal(duration(0), '0分钟');
  assert.equal(duration(30), '<1分钟');
  assert.equal(duration(59), '<1分钟');
  assert.equal(duration(60), '1分钟');
  assert.equal(duration(38 * 60), '38分钟');
  assert.equal(duration(60 * 60), '1小时');
  assert.equal(duration(85 * 60), '1小时25分钟');
  assert.doesNotMatch(duration(5100), /秒/);
  assert.equal(duration(5100), '1小时25分钟');
});

/* ---------- 13–14. daily goal ---------- */

test('the goal presets cover 10 20 30 45 60 plus a custom value', () => {
  const block = html.slice(html.indexOf('id="usage-goal-preset"'), html.indexOf('id="usage-goal-status"'));
  for (const minutes of [10, 20, 30, 45, 60]) assert.match(block, new RegExp(`<option value="${minutes}"`));
  assert.match(block, /<option value="custom"/);
  assert.match(block, /id="usage-goal-custom"[^>]*type="number"[^>]*min="1"[^>]*max="240"/);
});

test('saving a goal refreshes today progress immediately', () => {
  const events = appSource.slice(appSource.indexOf("$('#usage-goal-save')"));
  assert.match(events, /usageTracker\.setDailyGoal\(/);
  assert.match(events, /renderUsageView\(\)/);
  const { tracker } = usageHarness({ days: {}, goal: 20 });
  tracker.setDailyGoal(45);
  assert.equal(tracker.getDailyGoal(), 45);
});

test('changing the daily goal never rewrites usage history', () => {
  const now = new Date('2026-10-01T21:45:00').getTime();
  const { tracker } = usageHarness({ days: sampleDays(now), goal: 20, now });
  const before = JSON.stringify(tracker.exportStats());
  tracker.setDailyGoal(60);
  tracker.setDailyGoal(10);
  assert.equal(JSON.stringify(tracker.exportStats()), before);
});

test('the daily goal stays a device setting outside the backup schema', () => {
  assert.doesNotMatch(source('public/backup.js'), /dailyGoalMinutes|flashdesk-daily-goal-minutes-v1/);
  assert.match(source('public/usage-tracker.js'), /GOAL_KEY = 'flashdesk-daily-goal-minutes-v1'/);
});

/* ---------- 15. mobile layout ---------- */

test('the usage page is a single non-overflowing column on phones', () => {
  const page = css.slice(css.indexOf('.usage-page {'), css.indexOf('.ai-helper-panel'));
  assert.match(page, /width: min\(100%, 760px\)/);
  assert.match(page, /grid-template-columns: 4\.5em minmax\(0, 1fr\) auto/);
  assert.match(page, /minmax\(0, 1fr\)/);
  // Numbers must never wrap into a second line.
  assert.match(page, /\.usage-hero-time \{[^}]*white-space: nowrap/);
  assert.match(page, /\.usage-area-value \{[^}]*white-space: nowrap/);
  assert.match(page, /\.usage-day-value \{[^}]*white-space: nowrap/);
});

test('no usage rule pins a fixed pixel width that would overflow 375px', () => {
  const page = css.slice(css.indexOf('.usage-page {'), css.indexOf('.ai-helper-panel'));
  const fixed = [...page.matchAll(/width:\s*(\d+)px/g)].map((m) => Number(m[1])).filter((n) => n > 375);
  assert.deepEqual(fixed, []);
});

test('the all-time grid collapses to one min-width-safe column on phones', () => {
  assert.match(html, /id="usage-all-time" class="usage-all-time"/);
  const page = css.slice(css.indexOf('.usage-page {'), css.indexOf('.ai-helper-panel'));
  assert.match(page, /\.usage-all-time \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(page, /\.usage-all-time > div \{[^}]*min-width: 0/);
  const mobile = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(mobile, /\.usage-all-time \{ grid-template-columns: 1fr; \}/);
});

/* ---------- 16. no duplicate timers ---------- */

test('the tracker is created once and started once', () => {
  assert.equal((appSource.match(/FlashUsageTracker\.createTracker\(/g) || []).length, 1);
  assert.equal((appSource.match(/usageTracker\.start\(\)/g) || []).length, 1);
});

/* ---------- 17. view switching drives the area ---------- */

test('switching views updates the tracked area for every study surface', () => {
  const mapping = appSource.slice(appSource.indexOf('function usageAreaForView'), appSource.indexOf('const usageTracker'));
  assert.match(mapping, /review: 'review'/);
  assert.match(mapping, /words: 'words'/);
  assert.match(mapping, /ai: 'aiLearning'/);
  assert.match(mapping, /reading: 'reading'/);
  assert.match(appSource, /usageTracker\.setArea\(usageAreaForView\(name\)\)/);
  // setArea must run after state.view changes so the new area wins.
  const switchBlock = appSource.slice(appSource.indexOf('function switchView'), appSource.indexOf('/* ---------- events'));
  assert.ok(switchBlock.indexOf('state.view = name') < switchBlock.indexOf('usageTracker.setArea'));
});

test('the usage area never receives an unknown bucket from the view map', () => {
  const sandbox = { state: { view: 'review' } };
  const mapping = appSource.slice(appSource.indexOf('function usageAreaForView'), appSource.indexOf('const usageTracker'));
  vm.runInNewContext(`${mapping}\n__result = ['review','words','ai','reading','browse','quiz','add','usage','backup'].map(usageAreaForView);`, sandbox);
  assert.deepEqual([...sandbox.__result], ['review', 'words', 'aiLearning', 'reading', 'other', 'other', 'other', 'other', 'other']);
  for (const area of sandbox.__result) assert.ok(Usage.AREAS.includes(area));
});

/* ---------- 18. backup is intact ---------- */

test('full backup still carries usage stats and the restore summary mentions it', () => {
  const backup = source('public/backup.js');
  assert.match(backup, /usageStats/);
  assert.match(backup, /normalizeUsageStats/);
  assert.match(appSource, /usageStats: usageTracker\.exportStats\(\)/);
  assert.match(appSource, /usageTracker\.replaceStats\(backup\.usageStats\)/);
  const summary = appSource.slice(appSource.indexOf('function backupSummaryHtml'), appSource.indexOf('function renderBackupView'));
  assert.match(summary, /学习统计[\s\S]*已包含/);
});

test('all-time derived totals do not change the backup schema', () => {
  const backup = source('public/backup.js');
  for (const field of ['totalSeconds', 'activeDays', 'calendarDays', 'longestStreak', 'firstLearningDate']) {
    assert.doesNotMatch(backup, new RegExp(field));
  }
  assert.match(backup, /return \{ version: 1, days \}/);
});

/* ---------- core constants untouched ---------- */

test('the tracker keeps its original timing constants', () => {
  assert.equal(Usage.IDLE_MS, 120000);
  assert.equal(Usage.HEARTBEAT_MS, 20000);
  assert.equal(Usage.MAX_TICK_MS, 60000);
  assert.equal(Usage.VALID_DAY_SECONDS, 300);
  assert.equal(Usage.DEFAULT_GOAL_MINUTES, 20);
  assert.equal(Usage.STORAGE_KEY, 'flashdesk-usage-stats-v1');
  assert.deepEqual(Usage.AREAS, ['review', 'words', 'aiLearning', 'reading', 'other']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createReadingProgressCoordinator } = require('../public/reading-progress.js');
const { createPwaUpdateCoordinator } = require('../public/pwa-update.js');
const ArticleUtils = require('../public/article-utils.js');
const { resolveHost } = require('../server-config.js');

const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('Reading A save may persist after opening B without replacing current B', async () => {
  const gate = deferred(); let current = null; const writes = [];
  const coordinator = createReadingProgressCoordinator({
    save: async (id, progress) => { writes.push({ id, progress }); await gate.promise; return { id, ...progress }; },
    onApplied: (article) => { current = article; },
  });
  coordinator.open('A'); const pending = coordinator.capture({ progressSentenceIndex: 2, progressPercent: 30 });
  const saving = coordinator.persist(pending); coordinator.open('B'); current = { id: 'B' };
  gate.resolve(); await saving;
  assert.equal(writes[0].id, 'A'); assert.equal(current.id, 'B');
});

test('Reading A generation 1 cannot replace a later A generation 3', async () => {
  const gate = deferred(); let current = null;
  const coordinator = createReadingProgressCoordinator({ save: async (id, progress) => { await gate.promise; return { id, ...progress }; }, onApplied: (value) => { current = value; } });
  coordinator.open('A'); const old = coordinator.capture({ progressSentenceIndex: 1, progressPercent: 20 });
  const saving = coordinator.persist(old); coordinator.open('B'); coordinator.open('A'); current = { id: 'A', progressPercent: 80 };
  gate.resolve(); await saving; assert.equal(current.progressPercent, 80);
});

test('same-Article progress writes are serialized and finish at the newest 70 percent', async () => {
  const first = deferred(); const second = deferred(); const calls = []; let persistent = 0; let current = 0;
  const coordinator = createReadingProgressCoordinator({
    save: async (_id, progress) => { calls.push(progress.progressPercent); await (calls.length === 1 ? first.promise : second.promise); persistent = progress.progressPercent; return { id: 'A', ...progress }; },
    onApplied: (value) => { current = value.progressPercent; },
  });
  coordinator.open('A');
  const one = coordinator.persist(coordinator.capture({ progressSentenceIndex: 2, progressPercent: 30 }));
  const two = coordinator.persist(coordinator.capture({ progressSentenceIndex: 6, progressPercent: 70 }));
  await new Promise(setImmediate); assert.deepEqual(calls, [30]);
  first.resolve(); await one; await new Promise(setImmediate); assert.deepEqual(calls, [30, 70]);
  second.resolve(); await two; assert.equal(persistent, 70); assert.equal(current, 70);
});

test('stale Reading save failure is silent for the newly opened article', async () => {
  const gate = deferred(); let errors = 0;
  const coordinator = createReadingProgressCoordinator({ save: async () => gate.promise, onError: () => { errors += 1; } });
  coordinator.open('A'); const saving = coordinator.persist(coordinator.capture({ progressPercent: 10 })); coordinator.open('B');
  gate.reject(new Error('offline')); await saving; assert.equal(errors, 0);
});

function updateHarness({ risks = [], blocked = false, confirmed = true } = {}) {
  const values = new Map(); let reloads = 0; let shown = 0; let message = '';
  const coordinator = createPwaUpdateCoordinator({
    build: 'abc', sessionStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    reload: () => { reloads += 1; }, confirm: () => confirmed, getRisks: () => risks,
    isRestoreBlocked: () => blocked, onAvailable: () => { shown += 1; }, onBlocked: (value) => { message = value; },
  });
  return { coordinator, reloads: () => reloads, shown: () => shown, message: () => message };
}

test('controllerchange only exposes the update prompt and never reloads automatically', () => {
  const h = updateHarness(); h.coordinator.controllerChanged(); assert.equal(h.shown(), 1); assert.equal(h.reloads(), 0);
});
test('idle user can explicitly reload once without a loop', () => {
  const h = updateHarness(); h.coordinator.controllerChanged(); assert.equal(h.coordinator.apply(), true); assert.equal(h.coordinator.apply(), false); assert.equal(h.reloads(), 1);
});
test('active Review or AI preview requires confirmation before reload', () => {
  const h = updateHarness({ risks: ['active-review', 'ai-preview'], confirmed: false }); h.coordinator.controllerChanged(); assert.equal(h.coordinator.apply(), false); assert.equal(h.reloads(), 0);
});
test('unresolved restore blocks PWA reload', () => {
  const h = updateHarness({ blocked: true }); h.coordinator.controllerChanged(); assert.equal(h.coordinator.apply(), false); assert.match(h.message(), /备份恢复/);
});

test('Article AI provenance is minimal and strips credential-shaped extra fields', () => {
  const article = ArticleUtils.normalizeArticleInput({ title: 't', content: 'c', aiProvenance: {
    provider: 'zhipu', model: 'glm', task: 'generate_article', generatedAt: '2026-01-01', requestId: 'r1',
    attemptCount: 2, usageKnown: true, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, generationVersion: 'v1',
    apiKey: 'secret', token: 'secret', prompt: 'hidden',
  } });
  assert.deepEqual(Object.keys(article.aiProvenance).sort(), ['attemptCount', 'generatedAt', 'generationVersion', 'model', 'provider', 'requestId', 'source', 'task', 'usage', 'usageKnown'].sort());
  assert.doesNotMatch(JSON.stringify(article.aiProvenance), /secret|hidden/);
});

test('Node host defaults to loopback and permits explicit override', () => {
  assert.equal(resolveHost({}), '127.0.0.1');
  assert.equal(resolveHost({ FLASHDESK_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveHost({ FLASHDESK_HOST: ' 192.168.1.8 ' }), '192.168.1.8');
});

test('recognition wording explains that the metric is not long-term mastery', () => {
  const app = source('public/app.js'); assert.doesNotMatch(app, /当前认识率/); assert.match(app, /阅读自报熟悉度/); assert.match(app, /不代表长期掌握/);
});

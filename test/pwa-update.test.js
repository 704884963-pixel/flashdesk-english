const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function swHarness({ fetchImpl } = {}) {
  const listeners = {};
  const deleted = [];
  const added = [];
  const puts = [];
  let skipped = 0;
  let claimed = 0;
  const fallback = { name: 'cached-index' };
  const cache = {
    async addAll(items) { added.push(...items); },
    async put(request, response) { puts.push({ request, response }); },
    async match(request) {
      return String(request).includes('index.html') ? fallback : undefined;
    },
  };
  const context = {
    URL,
    caches: {
      async open() { return cache; },
      async keys() { return ['flashdesk-old', 'flashdesk-test-version', 'unrelated']; },
      async delete(key) { deleted.push(key); return true; },
      async match() { return undefined; },
    },
    fetch: fetchImpl || (async () => { throw new Error('offline'); }),
    self: {
      location: { origin: 'https://example.test' },
      clients: { async claim() { claimed += 1; } },
      skipWaiting() { skipped += 1; return Promise.resolve(); },
      addEventListener(type, handler) { listeners[type] = handler; },
    },
  };
  vm.runInNewContext(source('pwa/sw.js').replace('__CACHE_VERSION__', 'test-version'), context);
  return { listeners, deleted, added, puts, fallback, skipped: () => skipped, claimed: () => claimed };
}

async function runWaitEvent(handler, extra = {}) {
  let promise;
  handler({ ...extra, waitUntil(value) { promise = value; } });
  await promise;
}

test('new service worker installs its precache and calls skipWaiting', async () => {
  const h = swHarness();
  await runWaitEvent(h.listeners.install);
  assert.ok(h.added.includes('index.html'));
  assert.ok(h.added.includes('app.js'));
  assert.equal(h.skipped(), 1);
});

test('activate removes only old FlashDesk caches and claims clients', async () => {
  const h = swHarness();
  await runWaitEvent(h.listeners.activate);
  assert.deepEqual(h.deleted, ['flashdesk-old']);
  assert.equal(h.claimed(), 1);
});

test('SKIP_WAITING message activates an already waiting worker', () => {
  const h = swHarness();
  h.listeners.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(h.skipped(), 1);
});

test('navigation is network-first and updates the current cache', async () => {
  const response = { ok: true, clone: () => ({ copy: true }) };
  const h = swHarness({ fetchImpl: async () => response });
  let result;
  h.listeners.fetch({
    request: { method: 'GET', url: 'https://example.test/', mode: 'navigate', toString: () => 'https://example.test/' },
    respondWith(value) { result = value; },
  });
  assert.equal(await result, response);
  assert.equal(h.puts.length, 1);
});

test('offline navigation falls back to cached index.html', async () => {
  const h = swHarness();
  let result;
  h.listeners.fetch({
    request: { method: 'GET', url: 'https://example.test/missing', mode: 'navigate', toString: () => 'https://example.test/missing' },
    respondWith(value) { result = value; },
  });
  assert.equal(await result, h.fallback);
});

test('registration actively updates, activates waiting worker and reloads only once', () => {
  const app = source('public/app.js');
  const registration = app.slice(app.indexOf('function registerServiceWorker()'), app.indexOf('\nconst state'));
  assert.match(registration, /register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/);
  assert.match(registration, /await registration\.update\(\)/);
  assert.match(registration, /registration\.waiting\?\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(registration, /controllerchange/);
  assert.match(registration, /reloadRequested \|\| sessionStorage\.getItem\(reloadKey\) === '1'/);
  assert.equal((registration.match(/window\.location\.reload\(\)/g) || []).length, 1);
});

test('PWA update code never clears localStorage or deletes IndexedDB databases', () => {
  const combined = [source('pwa/sw.js'), source('public/app.js'), source('build.js')].join('\n');
  assert.doesNotMatch(combined, /localStorage\.clear\s*\(/);
  assert.doesNotMatch(combined, /indexedDB\.deleteDatabase\s*\(/);
});

test('build version marker is injected and shown in the compact More menu', () => {
  const html = source('public/index.html');
  const head = source('pwa/head-snippet.html');
  const build = source('build.js');
  const css = source('public/styles.css');
  assert.match(html, /id="build-version">开发版<\/span>/);
  assert.match(head, /window\.FLASHDESK_BUILD = '__FLASHDESK_BUILD__'/);
  assert.match(build, /builtIndex\.replaceAll\(BUILD_MARKER, version\)/);
  assert.match(css, /\.nav-build-version \{[\s\S]*?overflow-wrap: anywhere/);
});

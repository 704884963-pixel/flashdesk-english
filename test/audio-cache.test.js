const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
  .replace(/init\(\);\s*$/, '');
const audioCacheSource = fs.readFileSync(path.join(__dirname, '../public/audio-cache.js'), 'utf8');

const ENDPOINT = 'https://worker.example';
const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const keyFor = (text, endpoint = ENDPOINT) => JSON.stringify(['audio-v1', endpoint, normalize(text)]);

function node(overrides = {}) {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, max: 1,
    dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    ...overrides,
  };
}

function audioRecord(text, bytes = [1, 2, 3], endpoint = ENDPOINT) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' });
  return {
    key: keyFor(text, endpoint), text: normalize(text), blob, mimeType: blob.type,
    endpoint, createdAt: 1, size: blob.size,
  };
}

function cacheApi(records) {
  return {
    normalizeText: normalize,
    cacheKey: (endpoint, text) => keyFor(text, endpoint),
    async get(key) { return records.get(key) || null; },
    async put(record) { records.set(record.key, { ...record }); return record; },
    async getAll() { return [...records.values()]; },
    async clear() { records.clear(); },
  };
}

function cacheClient({
  records = new Map(), online = true, configured = true, status = 200,
  contentType = 'audio/mpeg', fetchDelay = 0, persistent = true, confirmResult = true,
} = {}) {
  const storage = new Map();
  if (configured) storage.set('flashdesk-tts-settings', JSON.stringify({ endpoint: ENDPOINT, token: 'test-token' }));
  const nodes = new Map([
    ['#tts-endpoint', node()], ['#tts-token', node()], ['#tts-status', node()],
    ['#speech-voice', node()], ['#speech-status', node()], ['#speech-rate', node()], ['#speech-test', node()],
    ['#audio-cache-word-count', node()], ['#audio-cache-total', node()], ['#audio-cache-size', node()],
    ['#audio-cache-download', node()], ['#audio-cache-clear', node()], ['#audio-cache-status', node()],
    ['#audio-cache-progress-wrap', node({ hidden: true })], ['#audio-cache-progress', node()],
    ['#audio-cache-progress-text', node()],
  ]);
  const fetchCalls = [];
  const audioInstances = [];
  const spoken = [];
  const revokedUrls = [];
  let objectUrlCount = 0;
  class FakeURL extends URL {}
  FakeURL.createObjectURL = () => `blob:audio-${++objectUrlCount}`;
  FakeURL.revokeObjectURL = (url) => revokedUrls.push(url);
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.paused = false;
      this.onended = null;
      this.onerror = null;
      audioInstances.push(this);
    }
    async play() { return undefined; }
    pause() { this.paused = true; }
  }
  class Utterance { constructor(text) { this.text = text; } }
  const synthesis = {
    getVoices: () => [], cancel() {}, resume() {},
    speak(utterance) { spoken.push(utterance); },
  };
  const fetchMock = async (url, init) => {
    fetchCalls.push({ url, init });
    if (fetchDelay) await new Promise((resolve) => setTimeout(resolve, fetchDelay));
    if (status !== 200) return new Response('error', { status });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  };
  const windowObject = { speechSynthesis: synthesis, FlashAudioCache: cacheApi(records) };
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { querySelector: (selector) => nodes.get(selector) || null },
    window: windowObject,
    navigator: { onLine: online, storage: { persist: async () => persistent } },
    SpeechSynthesisUtterance: Utterance,
    Audio: FakeAudio,
    URL: FakeURL,
    fetch: fetchMock,
    Response,
    Blob,
    confirm: () => confirmResult,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(appSource, context);
  return {
    run: (code) => vm.runInContext(code, context), records, nodes, fetchCalls,
    audioInstances, spoken, revokedUrls, storage,
  };
}

test('cache key is stable after trimming and whitespace normalization', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(audioCacheSource, context);
  assert.equal(
    context.window.FlashAudioCache.cacheKey(ENDPOINT, '  The   agent\nreceives  '),
    context.window.FlashAudioCache.cacheKey(ENDPOINT, 'The agent receives'),
  );
});

test('cache key includes endpoint but never includes the token', () => {
  const h = cacheClient();
  const first = h.run("ttsCacheKey('approach')");
  h.run("ttsSettings.token = 'another-secret-token'");
  assert.equal(h.run("ttsCacheKey('approach')"), first);
  assert.doesNotMatch(first, /token|secret/);
  assert.notEqual(h.run("ttsCacheKey('approach', 'https://other.example')"), first);
});

test('IndexedDB cache hit plays without calling Worker', async () => {
  const records = new Map([[keyFor('approach'), audioRecord('approach')]]);
  const h = cacheClient({ records, online: false });
  assert.equal(await h.run("playEnglish('approach')"), 'elevenlabs');
  assert.equal(h.fetchCalls.length, 0);
});

test('cache miss fetches Worker audio and persists the Blob', async () => {
  const h = cacheClient();
  await h.run("playEnglish('approach')");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.records.size, 1);
  assert.equal(h.records.get(keyFor('approach')).blob.size, 4);
});

test('normal and slow playback share one persistent MP3', async () => {
  const h = cacheClient();
  await h.run("playEnglish('approach', { rate: 1 })");
  await h.run("playEnglish('approach', { rate: 0.75 })");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.records.size, 1);
  assert.deepEqual(h.audioInstances.map((audio) => audio.playbackRate), [1, 0.75]);
});

test('offline cache hit still uses high-quality local audio', async () => {
  const records = new Map([[keyFor('strategy'), audioRecord('strategy')]]);
  const h = cacheClient({ records, online: false });
  assert.equal(await h.run("playEnglish('strategy', { rate: 0.75 })"), 'elevenlabs');
  assert.equal(h.audioInstances[0].playbackRate, 0.75);
});

test('offline cache miss falls back to system speech without fetch', async () => {
  const h = cacheClient({ online: false });
  assert.equal(await h.run("playEnglish('missing')"), 'system');
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spoken[0].text, 'missing');
});

test('concurrent requests for one text share one Worker request', async () => {
  const h = cacheClient({ fetchDelay: 10 });
  await Promise.all([
    h.run("playEnglish('approach', { rate: 1 })"),
    h.run("playEnglish('approach', { rate: 0.75 })"),
  ]);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.records.size, 1);
});

test('bulk download skips Words already in persistent cache', async () => {
  const records = new Map([[keyFor('approach'), audioRecord('approach')]]);
  const h = cacheClient({ records });
  h.run("state.cards = [{ deck: 'Words', front: 'approach' }]");
  await h.run('downloadMissingWordAudio()');
  assert.equal(h.fetchCalls.length, 0);
  assert.match(h.nodes.get('#audio-cache-status').textContent, /全部保存/);
});

test('bulk download deduplicates repeated Word fronts', async () => {
  const h = cacheClient();
  h.run("state.cards = [{ deck: 'Words', front: 'approach' }, { deck: 'Words', front: ' approach ' }]");
  await h.run('downloadMissingWordAudio()');
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.records.size, 1);
});

test('invalid Worker payload is never saved as audio', async () => {
  const h = cacheClient({ contentType: 'text/plain' });
  assert.equal(await h.run("playEnglish('approach')"), 'system');
  assert.equal(h.records.size, 0);
});

test('401 stops bulk download and reports a configuration problem', async () => {
  const h = cacheClient({ status: 401 });
  h.run("state.cards = ['one','two','three','four'].map(front => ({ deck: 'Words', front }))");
  await h.run('downloadMissingWordAudio()');
  assert.ok(h.fetchCalls.length <= 2);
  assert.equal(h.records.size, 0);
  assert.match(h.nodes.get('#audio-cache-status').textContent, /Token|Worker/);
});

test('clearing audio cache leaves learning data untouched', async () => {
  const records = new Map([[keyFor('approach'), audioRecord('approach')]]);
  const h = cacheClient({ records });
  h.run("state.cards = [{ id: '1', deck: 'Words', front: 'approach', streak: 3 }]; state.history = [{ reviewed: 1 }]");
  const before = h.run('JSON.stringify({ cards: state.cards, history: state.history })');
  await h.run('clearAudioCache()');
  assert.equal(h.records.size, 0);
  assert.equal(h.run('JSON.stringify({ cards: state.cards, history: state.history })'), before);
});

test('Sentence whole text uses the same persistent cache', async () => {
  const sentence = 'The agent receives the query.';
  const h = cacheClient();
  await h.run(`playEnglish(${JSON.stringify(sentence)})`);
  await h.run(`playEnglish(${JSON.stringify(sentence)}, { rate: 0.75 })`);
  assert.equal(h.fetchCalls.length, 1);
  assert.ok(h.records.has(keyFor(sentence)));
});

test('Sentence word playback reuses the same text cache as Words', async () => {
  const h = cacheClient();
  await h.run("playEnglish('receives')");
  await h.run("playEnglish('receives')");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.records.size, 1);
});

test('a fresh app session reads audio persisted by the previous session', async () => {
  const records = new Map();
  const first = cacheClient({ records });
  await first.run("playEnglish('approach')");
  const reopened = cacheClient({ records, online: false });
  assert.equal(await reopened.run("playEnglish('approach')"), 'elevenlabs');
  assert.equal(reopened.fetchCalls.length, 0);
});

test('cache statistics use actual Blob sizes and current Word keys', async () => {
  const records = new Map([
    [keyFor('approach'), audioRecord('approach', [1, 2, 3])],
    [keyFor('A sentence.'), audioRecord('A sentence.', [1, 2, 3, 4, 5])],
  ]);
  const h = cacheClient({ records });
  h.run("state.cards = [{ deck: 'Words', front: 'approach' }, { deck: 'Sentences', front: 'A sentence.' }]");
  const stats = await h.run('refreshAudioCacheStats()');
  assert.equal(stats.cachedWords, 1);
  assert.equal(stats.total, 2);
  assert.equal(stats.size, 8);
  assert.equal(h.nodes.get('#audio-cache-size').textContent, '8 B');
});

test('switching endpoint does not reuse another Worker cache', async () => {
  const records = new Map([[keyFor('approach'), audioRecord('approach')]]);
  const h = cacheClient({ records });
  h.run("ttsSettings.endpoint = 'https://other.example'");
  await h.run("playEnglish('approach')");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.records.size, 2);
});

test('temporary Object URLs are revoked on switch and playback end', async () => {
  const h = cacheClient();
  await h.run("playEnglish('approach')");
  await h.run("playEnglish('strategy')");
  assert.deepEqual(h.revokedUrls, ['blob:audio-1']);
  h.audioInstances[1].onended();
  assert.deepEqual(h.revokedUrls, ['blob:audio-1', 'blob:audio-2']);
});

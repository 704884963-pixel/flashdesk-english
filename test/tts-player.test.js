const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
  .replace(/init\(\);\s*$/, '');

function node(overrides = {}) {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    ...overrides,
  };
}

function playerClient({ configured = false, upstreamStatus = 200 } = {}) {
  const storage = new Map();
  if (configured) {
    storage.set('flashdesk-tts-settings', JSON.stringify({
      endpoint: 'https://worker.example',
      token: 'personal-token',
    }));
  }
  const nodes = new Map([
    ['#tts-endpoint', node()], ['#tts-token', node()], ['#tts-status', node()],
    ['#speech-voice', node()], ['#speech-status', node()], ['#speech-rate', node()], ['#speech-test', node()],
  ]);
  const fetchCalls = [];
  const audioInstances = [];
  const spoken = [];
  let objectUrlCount = 0;
  class FakeURL extends URL {}
  FakeURL.createObjectURL = () => `blob:audio-${++objectUrlCount}`;
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.paused = false;
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
    if (upstreamStatus !== 200) {
      return new Response(JSON.stringify({ error: 'unavailable' }), {
        status: upstreamStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { querySelector: (selector) => nodes.get(selector) || null },
    window: { speechSynthesis: synthesis },
    navigator: { onLine: true },
    SpeechSynthesisUtterance: Utterance,
    Audio: FakeAudio,
    URL: FakeURL,
    fetch: fetchMock,
    Response,
    Blob,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(appSource, context);
  return {
    run: (code) => vm.runInContext(code, context),
    storage, nodes, fetchCalls, audioInstances, spoken,
  };
}

test('unconfigured ElevenLabs falls back to system speech', async () => {
  const h = playerClient();
  assert.equal(await h.run("playEnglish('approach', { rate: 1 })"), 'system');
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spoken[0].text, 'approach');
});

test('Worker endpoint and token save only in flashdesk-tts-settings', () => {
  const h = playerClient();
  h.nodes.get('#tts-endpoint').value = 'https://worker.example/tts/';
  h.nodes.get('#tts-token').value = 'personal-token';
  assert.equal(h.run('saveTtsSettingsFromForm()'), true);
  assert.deepEqual(JSON.parse(h.storage.get('flashdesk-tts-settings')), {
    endpoint: 'https://worker.example',
    token: 'personal-token',
  });
  assert.equal(h.storage.has('flashdesk-data'), false);
});

test('normal and slow playback use rates 1 and 0.75', async () => {
  const h = playerClient({ configured: true });
  await h.run("playEnglish('approach', { rate: 1 })");
  await h.run("playEnglish('approach', { rate: 0.75 })");
  assert.deepEqual(h.audioInstances.map((audio) => audio.playbackRate), [1, 0.75]);
});

test('normal and slow playback share one cached MP3 and one fetch', async () => {
  const h = playerClient({ configured: true });
  await h.run("playEnglish('approach', { rate: 1 })");
  await h.run("playEnglish('approach', { rate: 0.75 })");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.audioInstances[0].src, h.audioInstances[1].src);
});

test('concurrent requests for the same text share one pending fetch', async () => {
  const h = playerClient({ configured: true });
  await Promise.all([
    h.run("playEnglish('approach', { rate: 1 })"),
    h.run("playEnglish('approach', { rate: 0.75 })"),
  ]);
  assert.equal(h.fetchCalls.length, 1);
});

test('starting a new pronunciation stops the current audio', async () => {
  const h = playerClient({ configured: true });
  await h.run("playEnglish('approach')");
  await h.run("playEnglish('transformer')");
  assert.equal(h.audioInstances[0].paused, true);
  assert.equal(h.audioInstances[0].currentTime, 0);
});

test('loading feedback disables and restores the pressed button', () => {
  const h = playerClient({ configured: true });
  const button = node({ textContent: '🔊 正常' });
  h.run('setSpeechButtonLoading').call(null, button, true);
  assert.equal(button.textContent, '加载中…');
  assert.equal(button.disabled, true);
  h.run('setSpeechButtonLoading').call(null, button, false);
  assert.equal(button.textContent, '🔊 正常');
  assert.equal(button.disabled, false);
});

test('a new text makes a new Worker request', async () => {
  const h = playerClient({ configured: true });
  await h.run("playEnglish('approach')");
  await h.run("playEnglish('transformer')");
  assert.equal(h.fetchCalls.length, 2);
});

test('Worker errors safely fall back to system speech', async () => {
  const h = playerClient({ configured: true, upstreamStatus: 502 });
  assert.equal(await h.run("playEnglish('approach')"), 'system');
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.spoken[0].text, 'approach');
});

test('playing audio does not reveal the Review card or mutate learning data', async () => {
  const h = playerClient({ configured: true });
  h.run("state.cards = [{ id: '1', front: 'approach', streak: 4 }]; state.history = [{ reviewed: 1 }]; state.session.revealed = false;");
  const before = h.run('JSON.stringify({ cards: state.cards, history: state.history, revealed: state.session.revealed })');
  await h.run("playEnglish('approach')");
  const after = h.run('JSON.stringify({ cards: state.cards, history: state.history, revealed: state.session.revealed })');
  assert.equal(after, before);
});

test('Sentence whole playback sends the complete front unchanged', async () => {
  const h = playerClient({ configured: true });
  const sentence = 'The agent receives the query and decides which tool to use.';
  await h.run(`playEnglish(${JSON.stringify(sentence)}, { rate: 1 })`);
  assert.equal(JSON.parse(h.fetchCalls[0].init.body).text, sentence);
});

test('Sentence word playback sends only the selected word', async () => {
  const h = playerClient({ configured: true });
  await h.run("playEnglish('receives', { rate: 1 })");
  assert.equal(JSON.parse(h.fetchCalls[0].init.body).text, 'receives');
});

test('Sentence tokenizer excludes punctuation and preserves contractions and hyphens', () => {
  const h = playerClient();
  const html = h.run(`sentenceFrontHtml(${JSON.stringify('Query, don\'t use state-of-the-art?')})`);
  assert.match(html, /data-speak-word="Query"/);
  assert.doesNotMatch(html, /data-speak-word="Query,"/);
  assert.match(html, /data-speak-word="don&#39;t"/);
  assert.match(html, /data-speak-word="state-of-the-art"/);
});

test('TTS token is not included in PWA card exports', async () => {
  const values = new Map([
    ['flashdesk-data', JSON.stringify({ cards: [], history: [], meta: { nextWordNumber: 138 } })],
    ['flashdesk-tts-settings', JSON.stringify({ endpoint: 'https://worker.example', token: 'personal-token' })],
  ]);
  const windowObject = {};
  const context = vm.createContext({
    window: windowObject,
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, value),
    },
    fetch: async () => { throw new Error('default data must not be fetched'); },
    crypto: { randomUUID: () => 'id' },
    structuredClone,
    navigator: {},
    Date,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../pwa/store-local.js'), 'utf8'), context);
  await windowObject.FlashStore.load();
  const exported = windowObject.FlashStore.exportData();
  assert.doesNotMatch(exported, /personal-token|worker\.example|flashdesk-tts-settings/);
});

test('mobile CSS keeps sentence words wrapping and speech controls responsive', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /\.sentence-front\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.speech-actions \{ position: static;/);
  assert.match(css, /\.speech-settings-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

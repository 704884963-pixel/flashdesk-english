const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
  .replace(/init\(\);\s*$/, '');

function speechClient({ saved = null, voices = [], supported = true } = {}) {
  const values = new Map();
  if (saved !== null) values.set('flashdesk-speech-settings', JSON.stringify(saved));
  const nodes = new Map([
    ['#speech-voice', { innerHTML: '', value: '', disabled: false }],
    ['#speech-status', { hidden: true, textContent: '' }],
    ['#speech-rate', { value: '', disabled: false }],
    ['#speech-test', { disabled: false }],
  ]);
  let availableVoices = voices;
  let voicesChanged;
  const spoken = [];
  const synthesis = {
    cancelCalls: 0,
    resumeCalls: 0,
    getVoices: () => availableVoices,
    cancel() { this.cancelCalls += 1; },
    resume() { this.resumeCalls += 1; },
    speak(utterance) { spoken.push(utterance); },
    addEventListener(name, callback) {
      if (name === 'voiceschanged') voicesChanged = callback;
    },
  };
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, value),
    },
    document: { querySelector: (selector) => nodes.get(selector) || null },
    window: supported ? { speechSynthesis: synthesis } : {},
    SpeechSynthesisUtterance: supported ? Utterance : undefined,
  });
  vm.runInContext(source, context);
  return {
    run: (code) => vm.runInContext(code, context),
    nodes,
    spoken,
    synthesis,
    values,
    setVoices(next) { availableVoices = next; },
    fireVoicesChanged() { voicesChanged(); },
  };
}

const googleUS = { name: 'Google US English', lang: 'en-US', voiceURI: 'google-us' };
const systemUS = { name: 'English United States', lang: 'en-US', voiceURI: 'system-us' };
const british = { name: 'English UK', lang: 'en-GB', voiceURI: 'en-gb' };

test('speech rate defaults to 0.9', () => {
  const h = speechClient();
  assert.equal(h.run('speechSettings.rate'), 0.9);
});

test('saved speech rate is restored', () => {
  const h = speechClient({ saved: { voiceURI: '', rate: 0.85 } });
  assert.equal(h.run('speechSettings.rate'), 0.85);
});

test('voiceURI and rate save separately from card data', () => {
  const h = speechClient();
  h.run("speechSettings.voiceURI = 'google-us'; speechSettings.rate = 1; saveSpeechSettings();");
  assert.deepEqual(JSON.parse(h.values.get('flashdesk-speech-settings')), { voiceURI: 'google-us', rate: 1 });
  assert.equal(h.values.has('flashdesk-data'), false);
});

test('missing saved voice safely falls back to best available English voice', () => {
  const h = speechClient({ saved: { voiceURI: 'missing', rate: 0.9 }, voices: [british, systemUS, googleUS] });
  h.run('refreshSpeechVoices();');
  assert.equal(h.run('selectedSpeechVoice().voiceURI'), 'google-us');
});

test('English voices rank en-US first and preferred names within each language group', () => {
  const h = speechClient();
  const ranked = h.run(`rankEnglishVoices(${JSON.stringify([
    { name: 'Chinese', lang: 'zh-CN', voiceURI: 'zh' },
    british,
    systemUS,
    googleUS,
    { name: 'Plain US', lang: 'en-US', voiceURI: 'plain-us' },
  ])}).map(v => v.voiceURI).join(',')`);
  assert.equal(ranked, 'google-us,system-us,plain-us,en-gb');
});

test('an initially empty voice list is safe and keeps en-US fallback available', () => {
  const h = speechClient({ voices: [] });
  assert.doesNotThrow(() => h.run('initSpeechSettings();'));
  assert.equal(h.run('speechVoices.length'), 0);
  assert.match(h.nodes.get('#speech-status').textContent, /系统默认美式发音/);
  h.run("speakEnglish(' hello ');");
  assert.equal(h.spoken[0].lang, 'en-US');
  assert.equal(h.spoken[0].voice, undefined);
});

test('voiceschanged refreshes the selector after delayed voice loading', () => {
  const h = speechClient({ voices: [] });
  h.run('initSpeechSettings();');
  h.setVoices([british, googleUS]);
  h.fireVoicesChanged();
  assert.equal(h.run('speechVoices.length'), 2);
  assert.match(h.nodes.get('#speech-voice').innerHTML, /Google US English · en-US/);
  assert.equal(h.nodes.get('#speech-voice').value, 'google-us');
});

test('speaking uses selected voice, rate and pitch without flipping the Review card', () => {
  const h = speechClient({ saved: { voiceURI: 'system-us', rate: 0.75 }, voices: [googleUS, systemUS] });
  h.run('state.session.revealed = false; refreshSpeechVoices(); speakEnglish(" approach ");');
  assert.equal(h.run('state.session.revealed'), false);
  assert.equal(h.spoken[0].text, 'approach');
  assert.equal(h.spoken[0].voice.voiceURI, 'system-us');
  assert.equal(h.spoken[0].rate, 0.75);
  assert.equal(h.spoken[0].pitch, 1);
  assert.equal(h.synthesis.cancelCalls, 1);
  assert.equal(h.synthesis.resumeCalls, 1);
});

test('preview uses the current speech settings without modifying learning data', () => {
  const h = speechClient({ voices: [googleUS] });
  h.run("state.cards = [{ id: '1', streak: 3 }]; state.history = [{ date: 'today' }]; refreshSpeechVoices();");
  const before = h.run('JSON.stringify({ cards: state.cards, history: state.history, session: state.session })');
  h.run('previewSpeech();');
  const after = h.run('JSON.stringify({ cards: state.cards, history: state.history, session: state.session })');
  assert.equal(after, before);
  assert.equal(h.spoken[0].text, 'Hello, this is a pronunciation test.');
});

test('unsupported browsers show the requested Chinese guidance and do not throw', () => {
  const h = speechClient({ supported: false });
  assert.doesNotThrow(() => h.run("initSpeechSettings(); speakEnglish('hello');"));
  assert.equal(h.spoken.length, 0);
  assert.match(h.nodes.get('#speech-status').textContent, /当前浏览器不支持语音朗读/);
});

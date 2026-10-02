const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
const settingsSource = appSource.slice(
  appSource.indexOf("const AI_PRONUNCIATION_SPEAKER_KEY"),
  appSource.indexOf("const AI_SETTINGS_KEY"),
);

function settingsHarness(entries = []) {
  const values = new Map(entries);
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const context = vm.createContext({ localStorage });
  vm.runInContext(settingsSource, context);
  return { run: (code) => vm.runInContext(code, context), values };
}

test('AI pronunciation speaker defaults to asteria', () => {
  const harness = settingsHarness();
  assert.equal(harness.run('loadAiPronunciationSpeaker()'), 'asteria');
});

test('AI pronunciation allows and persists orion and luna across reloads', () => {
  for (const speaker of ['orion', 'luna']) {
    const harness = settingsHarness();
    assert.equal(harness.run(`saveAiPronunciationSpeaker('${speaker}')`), speaker);
    const refreshed = settingsHarness([...harness.values]);
    assert.equal(refreshed.run('loadAiPronunciationSpeaker()'), speaker);
  }
});

test('invalid stored AI pronunciation speaker safely falls back to asteria', () => {
  const harness = settingsHarness([['flashdesk-ai-pronunciation-speaker', 'old-or-unknown']]);
  assert.equal(harness.run('loadAiPronunciationSpeaker()'), 'asteria');
  assert.equal(harness.run("saveAiPronunciationSpeaker('not-allowed')"), 'asteria');
  assert.equal(harness.values.get('flashdesk-ai-pronunciation-speaker'), 'asteria');
});

test('Review speech settings own the only AI pronunciation speaker selector', () => {
  const aiService = appSource.slice(appSource.indexOf('function aiSettingsHtml'), appSource.indexOf('function aiServiceStatusHtml'));
  assert.doesNotMatch(aiService, /AI发音声音|ai-pronunciation-speaker|AI_PRONUNCIATION_SPEAKERS/);
  assert.equal((indexSource.match(/id="ai-pronunciation-speaker"/g) || []).length, 1);
  assert.ok(indexSource.indexOf('id="tts-status"') < indexSource.indexOf('id="ai-pronunciation-speaker"'));
  assert.ok(indexSource.indexOf('id="ai-pronunciation-speaker"') < indexSource.indexOf('本地发音缓存'));
  assert.match(appSource, /function renderAiPronunciationSpeakerSetting[\s\S]*AI_PRONUNCIATION_SPEAKERS\.map/);
  assert.match(appSource, /Object\.freeze\(\['asteria', 'orion', 'luna'\]\)/);
});

test('Review speaker change persists immediately without the AI settings save action', () => {
  const bindEvents = appSource.slice(appSource.indexOf('function bindEvents'), appSource.indexOf('/* ---------- init ---------- */'));
  const changeHandler = bindEvents.slice(bindEvents.indexOf("$('#ai-pronunciation-speaker').addEventListener('change'"));
  assert.match(changeHandler, /aiPronunciationSpeaker = saveAiPronunciationSpeaker\(e\.target\.value\)/);
  assert.ok(changeHandler.indexOf('saveAiPronunciationSpeaker') < changeHandler.indexOf("$('#tts-save')"));
  const aiRootChange = bindEvents.slice(bindEvents.indexOf("$('#ai-root').addEventListener('change'"), bindEvents.indexOf("$('#ai-root').addEventListener('click'"));
  assert.doesNotMatch(aiRootChange, /ai-pronunciation-speaker|saveAiPronunciationSpeaker/);
});

test('AI pronunciation request sends the selected speaker without entering its audio cache', () => {
  const section = appSource.slice(appSource.indexOf('async function playAiPronunciation'), appSource.indexOf('function aiTargets'));
  assert.match(section, /JSON\.stringify\(\{ text: value, locale: 'en-US', speaker: aiPronunciationSpeaker \}\)/);
  assert.doesNotMatch(section, /audioCacheApi|ttsAudioCache|FlashAudioCache|indexedDB/);
});

test('AI speaker setting is device-local, backup-independent, and mobile-safe', () => {
  assert.doesNotMatch(settingsSource, /FlashStore|cards|history|backup/);
  assert.match(stylesSource, /\.speech-settings select\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(stylesSource, /\.ai-pronunciation-settings-block[\s\S]*display:\s*grid/);
});

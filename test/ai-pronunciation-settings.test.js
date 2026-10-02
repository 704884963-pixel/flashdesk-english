const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
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

test('AI service settings render only the three fixed speaker choices', () => {
  const section = appSource.slice(appSource.indexOf('function aiSettingsHtml'), appSource.indexOf('function aiServiceStatusHtml'));
  assert.match(section, /AI发音声音/);
  assert.match(section, /AI_PRONUNCIATION_SPEAKERS/);
  assert.match(appSource, /Object\.freeze\(\['asteria', 'orion', 'luna'\]\)/);
  assert.match(appSource, /saveAiPronunciationSpeaker\(e\.target\.value\)/);
});

test('AI pronunciation request sends the selected speaker without entering its audio cache', () => {
  const section = appSource.slice(appSource.indexOf('async function playAiPronunciation'), appSource.indexOf('function aiTargets'));
  assert.match(section, /JSON\.stringify\(\{ text: value, locale: 'en-US', speaker: aiPronunciationSpeaker \}\)/);
  assert.doesNotMatch(section, /audioCacheApi|ttsAudioCache|FlashAudioCache|indexedDB/);
});

test('AI speaker setting is device-local, backup-independent, and mobile-safe', () => {
  assert.doesNotMatch(settingsSource, /FlashStore|cards|history|backup/);
  assert.match(stylesSource, /\.ai-settings select\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(stylesSource, /@media \(max-width:\s*560px\)[\s\S]*\.ai-home-actions, \.ai-settings-grid, \.ai-options\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

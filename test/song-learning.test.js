const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Song = require('../public/song-learning.js');
const Ai = require('../public/ai-learning.js');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');

test('organized lyrics preserve supplied English, Chinese, ignored content and warnings', () => {
  const result = Song.normalizeOrganizedLyrics({
    title: ' Song ', artist: ' Singer ',
    lines: [{ english: ' Dont change me ', originalChinese: ' 不要改变我 ' }],
    ignored: [' 评论 999+ '], warnings: [' 拼写可能异常 '],
  });
  assert.equal(result.lines[0].english, 'Dont change me');
  assert.equal(result.lines[0].originalChinese, '不要改变我');
  assert.deepEqual(result.ignored, ['评论 999+']);
  assert.deepEqual(result.warnings, ['拼写可能异常']);
});
test('AI organization and explanation use structured provider-neutral tasks', () => {
  assert.deepEqual(Ai.buildOrganizeLyricsRequest('line'), { task: 'organize_lyrics', context: { rawLyrics: 'line' }, options: {} });
  assert.deepEqual(Ai.buildExplainLyricRequest('Keep moving.', '继续前进。'), { task: 'explain_lyric', context: { english: 'Keep moving.', originalChinese: '继续前进。' }, options: {} });
});
test('AI Learning home puts helper before Sentence, Article, and service settings', () => {
  const section = app.slice(app.indexOf('function renderAiHome'), app.indexOf('function aiProvenance'));
  assert.ok(section.indexOf('AI 英语助手') < section.indexOf('今日长句'));
  assert.ok(section.indexOf('今日长句') < section.indexOf('今日短文'));
  assert.ok(section.indexOf('今日短文') < section.indexOf('aiSettingsHtml'));
});
test('English helper exposes exactly lookup, example, song, and free AI actions', () => {
  const section = app.slice(app.indexOf('function renderAiHelper'), app.indexOf('async function askEnglishHelper'));
  for (const label of ['查单词', '简单例句', '歌曲学习', '问 AI']) assert.match(section, new RegExp(label));
  assert.doesNotMatch(section, /近义词|词义区别/);
});
test('helper lookup uses standard playEnglish and never Aura pronunciation', () => {
  const section = app.slice(app.indexOf('function helperLookupHtml'), app.indexOf('function renderAiHelper'));
  assert.match(section, /data-ai-speak/);
  assert.doesNotMatch(section, /data-ai-pronounce|AI发音/);
});
test('Review names ElevenLabs baseline and keeps Aura as more voices', () => {
  const section = app.slice(app.indexOf('function renderReview'), app.indexOf('function setFlipped'));
  assert.match(section, /标准发音/); assert.match(section, /慢速/); assert.match(section, /更多声音/);
  assert.match(section, /data-review-ai-pronounce/);
});
test('song organization preview is explicit and never saves automatically', () => {
  const organize = app.slice(app.indexOf('async function organizeSongLyrics'), app.indexOf('function collectSongPreview'));
  assert.doesNotMatch(organize, /createSong|saveNewCard|addCard/);
  const save = app.slice(app.indexOf('async function saveSongPreview'), app.indexOf('async function persistSong'));
  assert.match(save, /ArticleStore\.createSong/);
});
test('song actions reuse standard pronunciation, existing Word lookup, and existing Sentence Add', () => {
  assert.match(app, /data-song-speak[\s\S]*?playEnglish\(line\.english/);
  assert.match(app, /data-song-word-form[\s\S]*?lookupAiSentenceWord\(word, line\.english\)/);
  assert.match(app, /data-song-add-sentence[\s\S]*?prefillArticleCard\('Sentences'/);
});
test('AI failure retains helper input and exposes an exact-request retry', () => {
  assert.match(app, /helperRetry = \{ kind: 'ask', query \}/);
  assert.match(app, /helperRetry = \{ kind: 'shortcut', action, query \}/);
  assert.match(app, /data-ai-helper-retry/);
  assert.match(app, /retry\.kind === 'shortcut'.*runEnglishHelperShortcut/s);
});
test('song UI remains a single-column readable flow at 375px', () => {
  const mobile = styles.slice(styles.indexOf('@media (max-width: 560px)'));
  assert.match(mobile, /\.song-meta-grid \{ grid-template-columns: 1fr/);
  assert.match(mobile, /\.song-line-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(mobile, /\.song-page[^}]*overflow-x/);
});

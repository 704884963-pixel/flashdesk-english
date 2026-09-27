const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ai = require('../public/ai-learning.js');
const ArticleUtils = require('../public/article-utils.js');

const now = 2_000_000_000_000;
const word = (front, fields = {}) => ({ deck: 'Words', front, back: `${front} meaning`, forms: [], due: now + 1000, streak: 1, lapses: 0, ...fields });
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('AI target selector only selects Words', () => assert.deepEqual(Ai.selectAiTargetWords({ cards: [word('one'), { deck: 'Sentences', front: 'sentence' }], count: 5, now }).map((x) => x.front), ['one']));
test('currently weak Words receive first priority', () => assert.equal(Ai.selectAiTargetWords({ cards: [word('ordinary'), word('lapsed', { lapses: 2, streak: 0 })], count: 1, now })[0].front, 'lapsed'));
test('recovered historical lapses do not receive unresolved-error priority', () => {
  const selected = Ai.selectAiTargetWords({ cards: [word('recovered', { lapses: 3, streak: 2 }), word('new', { streak: 0 })], count: 1, now });
  assert.equal(selected[0].front, 'new');
});
test('Sentence and Article target counts both classify recovered lapses normally', () => {
  const cards = [word('recovered', { lapses: 1, streak: 1 }), word('weak', { lapses: 1, streak: 0 })];
  for (const count of [5, 10]) {
    const reasons = Object.fromEntries(Ai.selectAiTargetWords({ cards, count, now }).map((item) => [item.front, item.reason]));
    assert.equal(reasons.recovered, 'other');
    assert.equal(reasons.weak, 'lapsed');
  }
});
test('AI target selector uses the shared current-weak helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/ai-learning.js'), 'utf8');
  assert.match(source, /FlashLogic\.isWeakCard\(card\)/);
  assert.doesNotMatch(source, /if \(lapses > 0\)/);
});
test('new Words outrank ordinary Words', () => assert.equal(Ai.selectAiTargetWords({ cards: [word('ordinary'), word('new', { streak: 0 })], count: 1, now })[0].front, 'new'));
test('due Words outrank ordinary Words', () => assert.equal(Ai.selectAiTargetWords({ cards: [word('ordinary'), word('due', { due: now - 86400000 })], count: 1, now })[0].front, 'due'));
test('mastered Words are lowered below ordinary Words', () => assert.equal(Ai.selectAiTargetWords({ cards: [word('mastered', { streak: 5 }), word('ordinary')], count: 1, now })[0].front, 'ordinary'));
test('selector fills from other categories when one is absent', () => assert.equal(Ai.selectAiTargetWords({ cards: [word('a'), word('b'), word('c')], count: 3, now }).length, 3));
test('recent AI targets are lowered rather than prohibited', () => {
  const selected = Ai.selectAiTargetWords({ cards: [word('old', { streak: 0 }), word('fresh', { streak: 0 })], recentAiTargets: [{ targetWords: ['old'] }], count: 1, now });
  assert.equal(selected[0].front, 'fresh');
});
test('target count is enforced', () => assert.equal(Ai.selectAiTargetWords({ cards: Array.from({ length: 30 }, (_, i) => word(`w${i}`)), count: 8, now }).length, 8));
test('Today Sentence candidate count defaults to five', () => assert.equal(Ai.sentenceTargetCount(), 5));
test('Today Sentence candidate count stays within four to six', () => { assert.equal(Ai.sentenceTargetCount(2), 4); assert.equal(Ai.sentenceTargetCount(6), 6); assert.equal(Ai.sentenceTargetCount(20), 6); });
test('latest actual Sentence targets are available for Article reinforcement', () => {
  const history = { generations: [
    { type: 'sentences', targetWords: ['approach'] },
    { type: 'article', targetWords: ['context'] },
    { type: 'sentences', targetWords: ['evidence', 'workflow'] },
  ] };
  assert.deepEqual(Ai.latestSentenceTargetWords(history), ['evidence', 'workflow']);
});
test('Article selection can raise a recent Sentence word without forcing a dependency', () => {
  const cards = [word('reinforced', { wordNumber: 1 }), word('fresh', { wordNumber: 2 })];
  const recentAiTargets = [{ type: 'sentences', targetWords: ['reinforced'] }];
  assert.equal(Ai.selectAiTargetWords({ cards, recentAiTargets, count: 1, now })[0].front, 'fresh');
  assert.equal(Ai.selectAiTargetWords({ cards, recentAiTargets, preferredWords: ['reinforced'], count: 1, now })[0].front, 'reinforced');
  assert.deepEqual(Ai.latestSentenceTargetWords({ generations: [{ type: 'article', targetWords: ['fresh'] }] }), []);
});
test('AI history retains only ten generations', () => {
  let history = { generations: [] }; for (let i = 0; i < 12; i += 1) history = Ai.recordAiGeneration(history, { type: 'sentences', targetWords: [`w${i}`], createdAt: String(i) });
  assert.equal(history.generations.length, 10); assert.deepEqual(history.generations[0].targetWords, ['w2']);
});
test('AI context caps unknownWords at 50', () => assert.equal(Ai.buildAiContext({ cards: [], targetWords: [], unknownWords: Array.from({ length: 60 }, (_, i) => `u${i}`) }).unknownWords.length, 50));
test('AI context caps familiar sample at 20', () => assert.equal(Ai.buildAiContext({ cards: Array.from({ length: 30 }, (_, i) => word(`k${i}`, { streak: 3 })), targetWords: [], unknownWords: [] }).knownWordSample.length, 20));
test('AI context sends only learning fields needed by the model', () => {
  const target = Ai.selectAiTargetWords({ cards: [word('safe', { id: 'secret-id', created: 1, wordNumber: 99 })], count: 1, now })[0];
  assert.deepEqual(Object.keys(target), ['front', 'back', 'forms', 'reason']);
});
test('Sentence and Article requests use provider-neutral schemas', () => {
  assert.equal(Ai.buildAiRequest('generate_sentences', { targetWords: [] }).task, 'generate_sentences');
  assert.equal(Ai.buildAiRequest('generate_article', { targetWords: [] }).task, 'generate_article');
});
test('AI history and settings use keys separate from learning data', () => {
  assert.match(appSource, /flashdesk-ai-settings/); assert.match(appSource, /flashdesk-ai-history/);
  const section = appSource.slice(appSource.indexOf('function saveAiSettings'), appSource.indexOf('function rememberAiGeneration'));
  assert.doesNotMatch(section, /FlashStore|flashdesk-data/);
});
test('Sentence preview only prefills the existing Add form', () => assert.match(appSource, /prefillArticleCard\('Sentences', sentence\.english, sentence\.referenceChinese\)/));
test('Article preview saves only from the explicit save button', () => {
  assert.match(appSource, /data-ai-save-article/);
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.doesNotMatch(generate, /ArticleStore\.create/);
});
test('AI generation does not call FlashStore or mutate review progress', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.doesNotMatch(generate, /FlashStore|gradeCard|streak|lapses|due\s*=/);
});
test('existing Sentence duplicate uses the current exact-front helper', () => assert.match(appSource, /FlashArticleUtils\.sentenceExists\(state\.cards, sentence\.english\)/));
test('AI pronunciation reuses playEnglish', () => assert.match(appSource, /playEnglish\(button\.dataset\.aiSpeak/));
test('Today Sentence requests one result from five candidate targets', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /sentenceTargetCount\(\)/);
  assert.match(generate, /\{ count: 1 \}/);
});
test('Today Sentence renders one card with separate candidate and used-word labels', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiSentences'), appSource.indexOf('function renderAiArticle'));
  assert.match(render, /sentences\[0\]/);
  assert.match(render, /本轮候选重点词/);
  assert.match(render, /本句练习词/);
  assert.match(render, /生成今日长句/);
  assert.match(render, /换一句/);
  assert.doesNotMatch(render, /生成 3 条长句/);
});
test('AI history prefers actually used Sentence words and falls back to candidates', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /result\.data\.sentences\[0\]\?\.targetWordsUsed/);
  assert.match(generate, /usedTargets\?\.length \? usedTargets : state\.ai\.targets/);
});
test('Article generation uses latest Sentence practice as an optional preference', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /article \? FlashAiLearning\.latestSentenceTargetWords\(aiHistory\) : \[\]/);
  assert.match(generate, /aiTargets\(article \? 10/);
});
test('frontend has no provider-specific conditional', () => assert.doesNotMatch(appSource, /if\s*\(\s*provider\s*===\s*['"]zhipu/));
test('lookup_word uses the provider-neutral request schema', () => assert.equal(Ai.buildLookupWordRequest('evaluation', 'An evaluation helps.').task, 'lookup_word'));
test('lookup_word sends only the clicked word and sentence', () => assert.deepEqual(Ai.buildLookupWordRequest(' evaluation ', ' An evaluation helps. ').context, { word: 'evaluation', sentence: 'An evaluation helps.' }));
test('lookup cache normalizes word case and surrounding spaces', () => assert.equal(Ai.lookupCacheKey(' Evaluation ', 'Sentence.'), Ai.lookupCacheKey('evaluation', 'Sentence.')));
test('lookup cache keeps different sentence contexts separate', () => assert.notEqual(Ai.lookupCacheKey('evaluation', 'First sentence.'), Ai.lookupCacheKey('evaluation', 'Second sentence.')));
test('lookup draft prefers a confident baseForm', () => assert.equal(Ai.wordDraftFromLookup('expected', { baseForm: 'expect', meaningZh: '期待' }).front, 'expect'));
test('lookup draft falls back to the clicked token without a baseForm', () => assert.equal(Ai.wordDraftFromLookup('expected', { baseForm: '', meaningZh: '期待' }).front, 'expected'));
test('lookup draft uses meaningZh as the editable back', () => assert.equal(Ai.wordDraftFromLookup('evaluation', { meaningZh: '评估；评价' }).back, '评估；评价'));
test('lookup draft preserves pronunciation guidance fields', () => assert.deepEqual(Ai.wordDraftFromLookup('evaluation', { meaningZh: '评估', memoryReading: 'e + val', chineseReading: '伊-瓦尔（仅近似）' }), { front: 'evaluation', back: '评估', memoryReading: 'e + val', chineseReading: '伊-瓦尔（仅近似）', forms: [] }));
test('lookup draft records the clicked inflection when it differs from baseForm', () => assert.deepEqual(Ai.wordDraftFromLookup('students', { baseForm: 'student', meaningZh: '学生' }).forms, ['students']));
test('lookup draft leaves forms empty when clicked word equals baseForm', () => assert.deepEqual(Ai.wordDraftFromLookup('student', { baseForm: 'student', meaningZh: '学生' }).forms, []));
test('lookup draft ignores model-guessed forms beyond the actually clicked token', () => assert.deepEqual(Ai.wordDraftFromLookup('students', { baseForm: 'student', meaningZh: '学生', forms: ['studenting'] }).forms, ['students']));
test('AI Sentence rendering reuses the Article word tokenizer', () => assert.match(appSource, /function interactiveWordHtml[\s\S]*?FlashArticleUtils\.wordTokens/));
test('AI Sentence word tokens are clickable while punctuation stays outside token spans', () => { assert.match(appSource, /data-ai-sentence-word/); assert.match(appSource, /value\.slice\(position, token\.index\)/); });
test('existing front and forms lookup reuse the canonical Article lookup', () => { const lookup = ArticleUtils.buildWordLookup([{ deck: 'Words', front: 'expect', forms: ['expected'] }]); assert.equal(lookup.get('expect').front, 'expect'); assert.equal(lookup.get('expected').front, 'expect'); });
test('existing Word lookup remains case-insensitive', () => assert.equal(ArticleUtils.buildWordLookup([{ deck: 'Words', front: 'Expect' }]).get('expect').front, 'Expect'));
test('existing AI Sentence Word is shown directly before an inline draft', () => assert.match(appSource, /function openAiSentenceWord[\s\S]*?const card = aiLookupExistingCard\(word, result\)[\s\S]*?result && !card/));
test('unknown AI Sentence Word starts lookup immediately without an AI lookup button', () => {
  const handler = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'"));
  assert.match(handler, /await showAiSentenceWord\(word\.dataset\.aiSentenceWord, sentence\.english\)/);
  assert.doesNotMatch(appSource, /AI 查中文|data-ai-lookup-word/);
});
test('existing Word or form match bypasses lookup_word', () => {
  const section = appSource.slice(appSource.indexOf('async function showAiSentenceWord'), appSource.indexOf('function refreshAiSentenceWordLookup'));
  assert.match(section, /if \(aiLookupExistingCard\(word, null\)\) return openAiSentenceWord/);
  assert.match(section, /await lookupAiSentenceWord/);
});
test('lookup_word session cache is checked before the AI request', () => assert.match(appSource, /if \(state\.ai\.lookupCache\.has\(cacheKey\)\) return openAiSentenceWord/));
test('lookup_word records provider timing only after a cache miss', () => {
  const section = appSource.slice(appSource.indexOf('async function lookupAiSentenceWord'), appSource.indexOf('async function showAiSentenceWord'));
  assert.ok(section.indexOf('lookupCache.has(cacheKey)') < section.indexOf('const started ='));
  assert.match(section, /rememberAiTiming\('lookup_word', response, started\)/);
});
test('AI timing helper records task, cumulative provider calls, retries and length rewrite', () => {
  const section = appSource.slice(appSource.indexOf('function rememberAiTiming'), appSource.indexOf('function refreshAiServiceStatus'));
  assert.match(section, /task,/);
  assert.match(section, /totalMs: Math\.max/);
  assert.match(section, /providerTotalMs/);
  assert.match(section, /providerCalls/);
  assert.match(section, /networkRetries/);
  assert.match(section, /lengthRewrite/);
  assert.match(section, /initialWordCount/);
  assert.match(section, /finalWordCount/);
});
test('AI service diagnostics display the latest task timing without credentials', () => {
  const section = appSource.slice(appSource.indexOf('function aiServiceStatusHtml'), appSource.indexOf('function refreshAiServiceStatus'));
  assert.match(section, /最近请求/);
  assert.match(section, /今日长句/);
  assert.match(section, /今日短文/);
  assert.match(section, /单词查询/);
  assert.match(section, /总耗时/);
  assert.match(section, /Provider/);
  assert.match(section, /Provider 调用/);
  assert.match(section, /网络重试/);
  assert.match(section, /长度重写/);
  assert.doesNotMatch(section, /aiSettings\.token|Authorization|API_KEY/);
});
test('AI timing UI safely falls back to legacy providerMs and attempts fields', () => {
  const section = appSource.slice(appSource.indexOf('function rememberAiTiming'), appSource.indexOf('function refreshAiServiceStatus'));
  assert.match(section, /timing\.providerTotalMs \?\? timing\.providerMs/);
  assert.match(section, /timing\.providerCalls \?\? timing\.attempts/);
  assert.match(section, /Number\(timing\.networkRetries\) \|\| 0/);
  assert.match(section, /timing\.lengthRewrite === true/);
  assert.match(section, /timing\.initialWordCount == null \? null/);
  assert.match(section, /timing\.finalWordCount == null \? null/);
});
test('AI timing UI shows Sentence word counts only when diagnostics are present', () => {
  const section = appSource.slice(appSource.indexOf('function aiServiceStatusHtml'), appSource.indexOf('function rememberAiTiming'));
  assert.match(section, /timing\.initialWordCount == null \|\| timing\.finalWordCount == null/);
  assert.match(section, /首次词数/);
  assert.match(section, /最终词数/);
});
test('Sentence and Article generation both record response timing', () => {
  const section = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles ---------- */'));
  assert.match(section, /const started =/);
  assert.match(section, /rememberAiTiming\(task, result, started\)/);
});
test('lookup shows an immediate loading state in the current dialog', () => {
  const section = appSource.slice(appSource.indexOf('async function lookupAiSentenceWord'), appSource.indexOf('async function showAiSentenceWord'));
  assert.match(section, /openAiSentenceWord\(word, sentence, \{ loading: true \}\)/);
  assert.match(appSource, /正在查询…/);
});
test('lookup failure stays in the dialog and offers retry without an empty add action', () => {
  assert.match(appSource, /openAiSentenceWord\(word, sentence, \{ error: err\.message \}\)/);
  assert.match(appSource, /data-ai-retry-word/);
  assert.match(appSource, /查询失败/);
});
test('lookup result shows meaning, context and editable pronunciation drafts before adding', () => {
  const section = appSource.slice(appSource.indexOf('function openAiSentenceWord'), appSource.indexOf('async function lookupAiSentenceWord'));
  for (const field of ['meaningZh', 'meaningInContextZh', 'memoryReading', 'chineseReading']) assert.match(section, new RegExp(`result\\.${field}`));
  assert.match(section, /data-ai-edit-word/);
  assert.match(section, />加入单词库</);
});
test('AI Sentence Word pronunciation continues through playEnglish', () => assert.match(appSource, /data-article-speak[\s\S]*?playEnglish\(button\.dataset\.articleSpeak/));
test('AI word lookup never saves automatically', () => { const section = appSource.slice(appSource.indexOf('async function lookupAiSentenceWord'), appSource.indexOf('function refreshAiSentenceWordLookup')); assert.doesNotMatch(section, /saveNewCard|FlashStore\.addCard|gradeCard/); });
test('AI word lookup renders editable canonical Word fields inline', () => {
  for (const id of ['ai-word-front', 'ai-word-back', 'ai-word-memory-reading', 'ai-word-chinese-reading', 'ai-word-forms']) assert.match(appSource, new RegExp(`id="${id}"`));
  assert.match(appSource, /id="ai-word-inline-form"/);
  assert.match(appSource, /保存到单词库/);
});
test('AI word inline editor prefills every field from the lookup draft', () => {
  const section = appSource.slice(appSource.indexOf('function openAiSentenceWord'), appSource.indexOf('async function lookupAiSentenceWord'));
  for (const field of ['front', 'back', 'memoryReading', 'chineseReading']) assert.match(section, new RegExp(`draft\\.${field}`));
  assert.match(section, /draft\.forms\.join/);
});
test('加入单词库 expands the inline editor without saving', () => {
  const handler = appSource.slice(appSource.indexOf("$('#article-action-content').addEventListener('click'"), appSource.indexOf("$('#article-action-content').addEventListener('submit'"));
  assert.match(handler, /dataset\.aiEditWord[\s\S]*?openAiSentenceWord\([\s\S]*?\{ editing: true \}/);
  assert.doesNotMatch(handler, /saveNewCard|FlashStore\.addCard/);
});
test('single Add and AI inline Add share validation and persistence helpers', () => {
  const addSubmit = appSource.slice(appSource.indexOf("$('#add-form').addEventListener('submit'"), appSource.indexOf("$('#edit-form').addEventListener('submit'"));
  const inlineSave = appSource.slice(appSource.indexOf('async function saveInlineAiWord'), appSource.indexOf('async function setArticleUnknown'));
  assert.match(addSubmit, /newCardFields/); assert.match(addSubmit, /saveNewCard/);
  assert.match(inlineSave, /newCardFields/); assert.match(inlineSave, /saveNewCard/);
});
test('shared new-card save keeps returned numbering state in sync', () => {
  const section = appSource.slice(appSource.indexOf('async function saveNewCard'), appSource.indexOf('function duplicateWordMessage'));
  assert.match(section, /FlashStore\.addCard/); assert.match(section, /card\.wordNumber \+ 1/);
});
test('inline AI save handles duplicates as existing Words without creating another card', () => {
  const section = appSource.slice(appSource.indexOf('async function saveInlineAiWord'), appSource.indexOf('async function setArticleUnknown'));
  assert.match(section, /buildWordLookup\(state\.cards\)\.get/);
  assert.match(section, /openAiSentenceWord\(word, sentence\)/);
});
test('inline AI save refreshes lookup without replacing the generated result', () => {
  const section = appSource.slice(appSource.indexOf('async function saveInlineAiWord'), appSource.indexOf('async function setArticleUnknown'));
  assert.match(section, /refreshAiSentenceWordLookup/);
  assert.doesNotMatch(section, /renderAiSentences|state\.ai\.preview\s*=/);
  assert.doesNotMatch(section, /switchView|prefillArticleCard/);
});
test('AI word click is handled before other AI Sentence controls', () => { const handler = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'")); assert.ok(handler.indexOf("closest('[data-ai-sentence-word]')") < handler.indexOf("closest('button')")); });
test('Article Word click handling remains in its original priority position', () => { const handler = appSource.slice(appSource.indexOf("$('#article-root').addEventListener('click'"), appSource.indexOf("$('#article-action-close')")); assert.ok(handler.indexOf("closest('[data-article-word]')") < handler.indexOf("closest('[data-sentence-index]')")); });

test('Today Sentence AI pronunciation sends the complete generated sentence', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiSentences'), appSource.indexOf('function renderAiArticle'));
  assert.match(render, /data-ai-pronounce="\$\{esc\(sentence\.english\)\}"/);
});

test('AI Sentence Word dialog pronounces the exact clicked token', () => {
  const dialog = appSource.slice(appSource.indexOf('function openAiSentenceWord'), appSource.indexOf('async function lookupAiSentenceWord'));
  assert.match(dialog, /data-ai-pronounce="\$\{esc\(word\)\}"/);
  assert.doesNotMatch(dialog, /data-ai-pronounce="\$\{esc\((?:draft\.front|result\.baseForm|card\.front)\)\}"/);
});

test('Article Word dialog is unchanged by the independent AI pronunciation channel', () => {
  const dialog = appSource.slice(appSource.indexOf('function openArticleWord'), appSource.indexOf('function aiLookupExistingCard'));
  assert.doesNotMatch(dialog, /data-ai-pronounce/);
});

test('AI pronunciation controls use their independent playback function', () => {
  const articleActions = appSource.slice(appSource.indexOf("$('#article-action-content').addEventListener('click'"), appSource.indexOf("$('#article-action-content').addEventListener('submit'"));
  const aiActions = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'"));
  assert.match(articleActions, /playAiPronunciation\(button\.dataset\.aiPronounce, button\)/);
  assert.match(aiActions, /playAiPronunciation\(button\.dataset\.aiPronounce, button\)/);
  assert.match(articleActions, /playEnglish\(button\.dataset\.articleSpeak/);
  assert.match(aiActions, /playEnglish\(button\.dataset\.aiSpeak/);
});

test('AI pronunciation is ephemeral and bypasses the existing audio cache', () => {
  const section = appSource.slice(appSource.indexOf('async function playAiPronunciation'), appSource.indexOf('function aiTargets'));
  assert.match(section, /\/pronounce/);
  assert.match(section, /JSON\.stringify\(\{ text: value, locale: 'en-US' \}\)/);
  assert.match(section, /AI发音中…/);
  assert.match(section, /AI发音失败/);
  assert.match(section, /URL\.createObjectURL\(blob\)/);
  assert.match(section, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(section, /audio\.onended = release/);
  assert.doesNotMatch(section, /audioCacheApi|ttsAudioCache|FlashAudioCache|indexedDB|localStorage|playEnglish/);
});

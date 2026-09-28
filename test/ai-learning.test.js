const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Ai = require('../public/ai-learning.js');
const ArticleUtils = require('../public/article-utils.js');

const now = 2_000_000_000_000;
const word = (front, fields = {}) => ({ deck: 'Words', front, back: `${front} meaning`, forms: [], due: now + 1000, streak: 1, lapses: 0, ...fields });
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
const aiWorkerSource = (file) => fs.readFileSync(path.join(__dirname, '../cloudflare/ai-worker/src', file), 'utf8');
// Anchored on the full listener calls, so the `$` in the app's selectors never
// has to appear in this file (and never has to survive shell quoting).
const DOLLAR = String.fromCharCode(36);
const aiRootClickHandler = (source) => source.slice(
  source.indexOf(`${DOLLAR}('#ai-root').addEventListener('click'`),
  source.indexOf(`${DOLLAR}('#add-form').addEventListener('submit'`),
);

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
test('Today Sentence assigns one primary and at most one secondary target', () => {
  const targets = Ai.sentencePracticeTargets([word('primary'), word('secondary'), word('unused')]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].role, 'primary');
  assert.equal(targets[1].role, 'secondary');
});
test('Sentence history keeps the practiced primary target first', () => {
  const practice = Ai.sentencePracticeTargets([word('primary'), word('secondary')]);
  assert.deepEqual(Ai.sentenceHistoryTargets(['secondary', 'primary'], practice), ['primary', 'secondary']);
  assert.deepEqual(Ai.sentenceHistoryTargets([], practice), ['primary', 'secondary']);
});
test('Today Article defaults to three focus words and never exceeds four', () => {
  assert.equal(Ai.articleTargetCount(), 3); assert.equal(Ai.articleTargetCount(1), 1); assert.equal(Ai.articleTargetCount(8), 4);
  const targets = Ai.articlePracticeTargets([word('primary'), word('secondary-one'), word('secondary-two'), word('secondary-three'), word('unused')]);
  assert.deepEqual(targets.map((target) => target.role), ['primary', 'secondary', 'secondary', 'secondary']);
});

/* ---------- Today Sentence primary cooldown ---------- */

// One finished round of Today Sentence, fed back through the real history
// helper so the tests exercise the same shape the app persists.
function sentenceRound(cards, history, today = {}) {
  return Ai.sentencePracticeSelection({ cards, recentAiTargets: history.generations, now, today });
}
function recordRound(history, selection) {
  return Ai.recordAiGeneration(history, {
    type: 'sentences',
    targetWords: selection.practice.map((target) => target.front),
    primary: selection.practice[0]?.front,
  });
}
const rotate = (cards, rounds) => {
  let history = { generations: [] };
  const seen = [];
  for (let index = 0; index < rounds; index += 1) {
    const selection = sentenceRound(cards, history);
    const primaries = seen.map((entry) => entry[0]);
    if (primaries.length && primaries[primaries.length - 1] === selection.practice[0]?.front) return { seen, repeated: true };
    seen.push(selection.practice.map((target) => target.front));
    history = recordRound(history, selection);
  }
  return { seen, repeated: false };
};

test('Today Sentence never repeats the same primary in consecutive rounds', () => {
  const cards = [word('delay', { streak: 0, wordNumber: 1 }), word('ticket', { streak: 0, wordNumber: 2 }), word('reason', { streak: 0, wordNumber: 3 })];
  const { seen, repeated } = rotate(cards, 9);
  assert.equal(repeated, false);
  assert.deepEqual(seen.slice(0, 6).map((entry) => entry[0]), ['delay', 'ticket', 'reason', 'delay', 'ticket', 'reason']);
});
test('recent primaries are clearly demoted without being banned', () => {
  const history = { generations: [{ type: 'sentences', targetWords: ['delay', 'ticket'], primary: 'delay' }] };
  const cards = [word('delay', { streak: 0, wordNumber: 1 }), word('ticket', { streak: 0, wordNumber: 2 })];
  const selection = Ai.sentencePracticeSelection({ cards, recentAiTargets: history.generations, now });
  assert.equal(selection.practice[0].front, 'ticket');
  const two = [word('delay', { streak: 0, wordNumber: 1 }), word('ticket', { streak: 0, wordNumber: 2 })];
  assert.equal(Ai.sentencePracticeSelection({ cards: two, recentAiTargets: history.generations, now }).practice.length, 2);
  const few = [word('delay', { streak: 0, wordNumber: 1 })];
  assert.equal(Ai.sentencePracticeSelection({ cards: few, recentAiTargets: history.generations, now }).practice[0].front, 'delay');
});
test('new Words stay the strongest single category while rotating', () => {
  const cards = [word('fresh', { streak: 0 }), word('ordinary')];
  const selection = Ai.sentencePracticeSelection({ cards, recentAiTargets: [], now });
  assert.equal(selection.practice[0].front, 'fresh');
  assert.equal(selection.practice[0].reason, 'new');
  const cards2 = [word('weak', { lapses: 2, streak: 0 }), word('fresh', { streak: 0 })];
  assert.equal(Ai.sentencePracticeSelection({ cards: cards2, recentAiTargets: [], now }).practice[0].front, 'weak');
});
test('a cooled-down primary can return in a later round', () => {
  const cards = [word('delay', { streak: 0, wordNumber: 1 }), word('ticket', { streak: 0, wordNumber: 2 }), word('reason', { streak: 0, wordNumber: 3 })];
  const { seen, repeated } = rotate(cards, 6);
  assert.equal(repeated, false);
  assert.equal(seen.filter((entry) => entry[0] === 'delay').length, 2);
  assert.equal(Ai.sentencePracticeSelection({ cards: [word('delay', { streak: 0 })], recentAiTargets: [{ type: 'sentences', targetWords: ['delay'], primary: 'delay' }], now }).practice[0].front, 'delay');
});

/* ---------- Today Sentence secondary rotation ---------- */

test('secondary target does not stay frozen on the same word', () => {
  const cards = [word('delay', { streak: 0, wordNumber: 1 }), word('ticket', { streak: 0, wordNumber: 2 }), word('reason', { streak: 0, wordNumber: 3 })];
  const { seen } = rotate(cards, 6);
  const pairs = seen.map((entry) => entry.join('+'));
  assert.equal(new Set(pairs.slice(0, 3)).size, 3);
  assert.equal(pairs[3], pairs[0]);
});

/* ---------- Today Article focus words ---------- */

const techTarget = (front) => ({ deck: 'Words', front, back: `${front} 技术`, forms: [], due: now + 1000, streak: 1, lapses: 0, reason: 'other' });
const lifeTarget = (front, reason = 'other') => ({ deck: 'Words', front, back: `${front} 日常生活`, forms: [], due: now + 1000, streak: 1, lapses: 0, reason });

test('Today Article defaults to exactly three focus words', () => {
  const cards = Array.from({ length: 8 }, (_, index) => word(`w${index}`));
  const targets = Ai.selectAiTargetWords({ cards, count: Ai.articleTargetCount(), now });
  assert.equal(Ai.selectArticleFocusWords({ targets, recentAiTargets: [] }).length, 3);
  assert.equal(Ai.articleTargetCount(), 3);
});
test('Today Article focus words never exceed four', () => {
  const cards = Array.from({ length: 10 }, (_, index) => word(`w${index}`));
  const targets = Ai.selectAiTargetWords({ cards, count: 6, now });
  assert.equal(Ai.selectArticleFocusWords({ targets, recentAiTargets: [], count: 4 }).length, 4);
  assert.ok(Ai.selectArticleFocusWords({ targets, recentAiTargets: [], count: 99 }).length <= 4);
});
test('the latest Sentence primary can enter Today Article focus words', () => {
  const targets = [lifeTarget('ticket', 'lapsed'), lifeTarget('delay', 'new'), lifeTarget('reason', 'due'), lifeTarget('sunset'), lifeTarget('market')];
  const recentAiTargets = [{ type: 'sentences', targetWords: ['reason', 'ticket'], primary: 'reason' }];
  const focus = Ai.selectArticleFocusWords({ targets, recentAiTargets, topic: 'daily' });
  assert.equal(focus[0].front, 'reason');
  assert.equal(focus[0].role, 'primary');
});
test('automatic everyday topics admit at most one technical focus word', () => {
  const targets = ['transformer', 'neuron', 'inference', 'parameter', 'embedding', 'agent', 'prompt'].map(techTarget);
  const focus = Ai.selectArticleFocusWords({ targets, recentAiTargets: [], topic: 'auto' });
  assert.equal(focus.filter((item) => item.technical).length, 1);
});
test('choosing a technical topic explicitly lifts the technical cap', () => {
  const targets = ['transformer', 'neuron', 'inference', 'parameter', 'embedding', 'agent', 'prompt'].map(techTarget);
  const focus = Ai.selectArticleFocusWords({ targets, recentAiTargets: [], topic: 'ai-tech', count: 4 });
  assert.equal(focus.length, 4);
  assert.equal(focus.filter((item) => item.technical).length, 4);
});
test('a tech-heavy library cannot turn an automatic everyday article into a technical one', () => {
  const cards = [
    word('transformer', { back: 'transformer 技术' }), word('neuron', { back: 'neuron 技术' }), word('neural', { back: 'neural 技术' }),
    word('inference', { back: 'inference 技术' }), word('parameter', { back: 'parameter 技术' }), word('embedding', { back: 'embedding 技术' }),
    word('agent', { back: 'agent 技术' }), word('prompt', { back: 'prompt 技术' }),
    word('delay', { streak: 0, back: 'delay 日常生活' }), word('ticket', { due: now - 86400000, back: 'ticket 日常生活' }), word('reason', { lapses: 2, streak: 0, back: 'reason 日常生活' }),
  ];
  const targets = Ai.selectAiTargetWords({ cards, count: 4, now });
  assert.ok(targets.some((target) => Ai.isTechnicalTarget(target)));
  const focus = Ai.selectArticleFocusWords({ targets, recentAiTargets: [], topic: 'auto' });
  assert.equal(focus.length, 3);
  assert.equal(focus.filter((item) => item.technical).length, 0);
  assert.deepEqual(focus.map((item) => item.front), ['delay', 'reason', 'ticket']);
});
test('an all-technical target pool still yields only one automatic focus word', () => {
  const targets = ['transformer', 'neuron', 'inference', 'parameter', 'embedding', 'agent', 'prompt'].map(techTarget);
  const focus = Ai.selectArticleFocusWords({ targets, recentAiTargets: [], topic: 'auto' });
  assert.equal(focus.length, 1);
  assert.equal(focus.filter((item) => item.technical).length, 1);
});
test('Article generation reuses existing AI history state without a new store', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /selectArticleFocusWords\(/);
  assert.match(generate, /FlashAiLearning\.articleTargetCount\(\)/);
  assert.doesNotMatch(generate, /flashdesk-ai-targets|localStorage.*primaryCooldown/i);
});
test('target rotation never writes to the formal learning data', async () => {
  // The deployed store adapter is the thing that touches flashdesk-data.json.
  // Driving the new selection + history code against it must leave the file
  // byte-for-byte identical.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flashdesk-ai-targets-'));
  const dataFile = path.join(dir, 'flashdesk-data.json');
  const cards = [
    { front: 'delay', back: '延迟', deck: 'Words', id: 'a', due: now + 1000, streak: 0, lapses: 0 },
    { front: 'ticket', back: '票', deck: 'Words', id: 'b', due: now + 1000, streak: 0, lapses: 0 },
    { front: 'reason', back: '原因', deck: 'Words', id: 'c', due: now + 1000, streak: 0, lapses: 0 },
  ];
  fs.writeFileSync(dataFile, JSON.stringify({ cards, history: [] }));
  const before = fs.readFileSync(dataFile, 'utf8');
  const stored = { key: '' };
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pwa/store-local.js'), 'utf8'), {
    window, navigator: {},
    localStorage: {
      getItem: (key) => (key === stored.key ? stored.value : null),
      setItem: (key, value) => { stored.key = key; stored.value = value; },
    },
  });
  let history = { generations: [] };
  for (let round = 0; round < 4; round += 1) {
    const selection = Ai.sentencePracticeSelection({ cards, recentAiTargets: history.generations, now });
    history = Ai.recordAiGeneration(history, { type: 'sentences', targetWords: selection.practice.map((t) => t.front), primary: selection.practice[0]?.front });
    const focus = Ai.selectArticleFocusWords({ targets: selection.practice, recentAiTargets: history.generations, topic: 'auto' });
    assert.ok(focus.length <= 4);
  }
  stored.key = 'flashdesk-ai-history'; stored.value = JSON.stringify(history);
  assert.equal(typeof window.FlashStore.load, 'function'); // the formal store is present...
  assert.equal(typeof window.FlashStore.gradeCard, 'function'); // ...with its review-mutation entry point
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before); // ...and the file it owns is untouched
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).cards.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

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
test('latest Sentence primary target alone is available for Article reinforcement', () => {
  const history = { generations: [{ type: 'sentences', targetWords: ['approach', 'evidence'] }] };
  assert.equal(Ai.latestSentencePrimaryTarget(history), 'approach');
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
test('Article translation request sends only title and paragraphs', () => {
  assert.deepEqual(Ai.buildArticleTranslationRequest(' A title ', [' First paragraph. ', ' Second paragraph. ']), {
    task: 'translate_article', context: { title: 'A title', paragraphs: ['First paragraph.', 'Second paragraph.'] }, options: {},
  });
  assert.throws(() => Ai.buildArticleTranslationRequest('', ['Article text.']));
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
test('Today Article no longer offers a whole-article translation request', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.doesNotMatch(render, /data-ai-translate-article|查看参考翻译|全文翻译|整体翻译/);
  assert.doesNotMatch(render, /aiFetch\(/);
  assert.equal(typeof Ai.buildArticleTranslationRequest, 'function'); // the task itself stays intact
  assert.doesNotMatch(appSource, /toggleAiArticleTranslation/);
});
test('paragraph translations come from the generated Article instead of a second AI call', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.match(render, /aiArticlePreviewContentHtml\(preview\.data\.content, lookup, preview\.data\.paragraphTranslations\)/);
  const content = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.doesNotMatch(content, /aiFetch\(|translationCache/);
  assert.match(content, /normalizeParagraphTranslations\(translations/);
});
test('opening one paragraph translation never opens the others', () => {
  const handler = aiRootClickHandler(appSource);
  const branch = handler.slice(handler.indexOf('dataset.aiParagraphTranslation'));
  assert.match(branch, /state\.ai\.revealedParagraphs\.has\(index\)/);
  assert.match(branch, /state\.ai\.revealedParagraphs\.add\(index\)/);
  assert.match(branch, /state\.ai\.revealedParagraphs\.delete\(index\)/);
  const toggleBranch = branch.slice(0, branch.indexOf('data.aiAddSentence'));
  assert.doesNotMatch(toggleBranch, /revealedParagraphs = new Set|revealedParagraphs\.clear/);
});
test('a regenerated Article clears every previous paragraph expansion', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf("$('#ai-root').addEventListener('click'"));
  assert.match(generate, /if \(type === 'article'\) state\.ai\.revealedParagraphs = new Set\(\)/);
});
test('saving to the reading library carries the paragraph translations with the Article', () => {
  const handler = aiRootClickHandler(appSource);
  const branch = handler.slice(handler.indexOf('data-ai-save-article'));
  assert.match(branch, /paragraphTranslations: preview\.data\.paragraphTranslations/);
  assert.match(branch, /content: preview\.data\.content/);
  assert.match(branch, /ArticleStore\.create/);
});
test('Article generation and display keep the Stage 1 focus words untouched', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.match(render, /aiTargetHtml\(preview\.data\.targetWordsUsed\.map\(\(front\) => \(\{ front \}\)\), '本篇重点词'\)/);
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /selectArticleFocusWords\(/);
  assert.match(generate, /rememberAiGeneration\(type, historyTargets, article \? '' : requestTargets\[0\]\?\.front\)/);
});
test('paragraph narration survives the per-paragraph translation controls', () => {
  const content = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.match(content, /data-ai-narrate-paragraph="\$\{paragraphIndex\}"/);
  assert.match(content, /▶ 本段朗读/);
  assert.ok(content.indexOf('data-ai-narrate-paragraph') < content.indexOf('data-ai-paragraph-translation'));
  const narration = appSource.slice(appSource.indexOf('const AI_SENTENCE_PAUSE_MS'), appSource.indexOf('function aiSettingsHtml'));
  assert.match(narration, /data-ai-article-paragraph/);
  assert.doesNotMatch(narration, /revealedParagraphs|paragraphTranslations/);
});
test('paragraph translations never leak into lookup_word', () => {
  const lookup = appSource.slice(appSource.indexOf('async function lookupAiSentenceWord'), appSource.indexOf('function refreshAiSentenceWordLookup'));
  assert.doesNotMatch(lookup, /paragraphTranslations|revealedParagraphs|translationCache/);
  assert.doesNotMatch(Ai.buildLookupWordRequest('evaluation', 'An evaluation helps.').context ? JSON.stringify(Ai.buildLookupWordRequest('evaluation', 'An evaluation helps.')) : '', /paragraphTranslations/);
});
test('generated Article renders clickable word tokens while punctuation remains outside', () => {
  const render = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.match(render, /interactiveWordHtml\(sentence\.text/);
  assert.match(render, /data-ai-article-word/);
  assert.match(appSource, /value\.slice\(position, token\.index\)/);
});
test('generated Article word click passes its current Sentence to the shared lookup flow', () => {
  const handler = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'"));
  assert.match(handler, /data-ai-article-word/);
  assert.match(handler, /aiArticleSentenceAt\(preview\.data\.content, articleWord\.dataset\.aiArticleSentenceIndex\)/);
  assert.match(handler, /showAiSentenceWord\(articleWord\.dataset\.aiArticleWord, sentence\)/);
});
test('generated Article Words and forms use the shared existing-card lookup without AI', () => {
  const show = appSource.slice(appSource.indexOf('async function showAiSentenceWord'), appSource.indexOf('function refreshAiSentenceWordLookup'));
  assert.match(show, /aiLookupExistingCard\(word, null\)/);
  assert.ok(show.indexOf('aiLookupExistingCard(word, null)') < show.indexOf('lookupAiSentenceWord'));
  assert.match(appSource, /FlashArticleUtils\.buildWordLookup\(state\.cards\)/);
});
test('saving an inline Word refreshes both Sentence and Article preview lookups', () => {
  const refresh = appSource.slice(appSource.indexOf('function refreshAiSentenceWordLookup'), appSource.indexOf('async function saveInlineAiWord'));
  assert.match(refresh, /data-ai-sentence-word/);
  assert.match(refresh, /data-ai-article-word/);
});
test('Today Article narration plays paragraph sentences in order through playEnglish', () => {
  const narration = appSource.slice(appSource.indexOf('async function startAiArticleNarration'), appSource.indexOf('function aiSettingsHtml'));
  assert.match(narration, /FlashArticleUtils\.articleSpeechParagraphs\(preview\.data\.content\)/);
  assert.match(narration, /for \(let paragraphPosition = 0;/);
  assert.match(narration, /for \(let sentenceIndex = 0;/);
  assert.match(narration, /await playEnglish\(paragraph\.sentences\[sentenceIndex\], \{ rate: state\.ai\.narrationRate, waitForEnd: true \}\)/);
});
test('Today Article renders one unobtrusive narration action per paragraph', () => {
  const render = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.match(render, /data-ai-article-paragraph/);
  assert.match(render, /data-ai-narrate-paragraph/);
  assert.match(render, /▶ 本段朗读/);
});
test('paragraph narration uses the selected narration speed and the shared controller', () => {
  const handler = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'"));
  assert.match(handler, /startAiArticleNarration\(state\.ai\.narrationSpeed, paragraphIndex\)/);
  assert.match(handler, /narrationMode === 'paragraph'/);
});
test('Today Article narration uses cancellable sentence and paragraph pauses', () => {
  const narration = appSource.slice(appSource.indexOf('const AI_SENTENCE_PAUSE_MS'), appSource.indexOf('function aiSettingsHtml'));
  assert.match(narration, /AI_SENTENCE_PAUSE_MS = 350/);
  assert.match(narration, /AI_PARAGRAPH_PAUSE_MS = 800/);
  assert.match(narration, /cancelAiNarrationPause/);
  assert.match(narration, /aiNarrationPause\(AI_SENTENCE_PAUSE_MS/);
  assert.match(narration, /aiNarrationPause\(AI_PARAGRAPH_PAUSE_MS/);
});
test('narration highlight follows the current paragraph and clears on stop', () => {
  const refresh = appSource.slice(appSource.indexOf('function refreshAiArticleNarrationUi'), appSource.indexOf('function aiNarrationPause'));
  assert.match(refresh, /classList\.toggle\('is-narrating'/);
  const stop = appSource.slice(appSource.indexOf('function stopAiArticleNarration'), appSource.indexOf('async function startAiArticleNarration'));
  assert.match(stop, /narrationParagraphIndex = null/);
  assert.match(stop, /refreshAiArticleNarrationUi/);
});
test('each paragraph translation renders under its own paragraph and before Article actions', () => {
  const paragraphs = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.match(paragraphs, /ai-translation-row/);
  assert.match(paragraphs, /aligned\[paragraphIndex\]/);
  assert.match(paragraphs, /data-ai-article-word/);
  assert.ok(paragraphs.indexOf('ai-article-paragraph') < paragraphs.indexOf('ai-article-translation'));
  assert.match(paragraphs, /data-ai-paragraph-translation="\$\{paragraphIndex\}"/);
  // One row per paragraph: the translation must live inside the same mapped section.
  assert.equal(paragraphs.match(/<section class="ai-translation-row">/g).length, 1);
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.ok(render.indexOf('aiArticlePreviewContentHtml') < render.indexOf('data-ai-narrate-article'));
});
test('paragraph translation toggle labels switch between 查看本段翻译 and 收起本段翻译', () => {
  const paragraphs = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.match(paragraphs, /查看本段翻译/);
  assert.match(paragraphs, /收起本段翻译/);
  assert.match(paragraphs, /aria-expanded="\$\{expanded \? 'true' : 'false'\}"/);
  assert.match(paragraphs, /const expanded = Boolean\(translationZh\) && state\.ai\.revealedParagraphs\.has\(paragraphIndex\)/);
});
test('paragraph translations stay hidden until the learner asks for one', () => {
  const paragraphs = appSource.slice(appSource.indexOf('function aiArticlePreviewContentHtml'), appSource.indexOf('function aiArticleSentenceAt'));
  assert.match(paragraphs, /\$\{expanded \? `<div class="ai-article-translation"/);
  assert.doesNotMatch(paragraphs, /is-bilingual/);
  assert.match(paragraphs, /translationZh \? `<button class="btn ai-paragraph-translate"/);
});
test('paragraph translation layout stacks under the English and keeps buttons side by side at 375px', () => {
  assert.match(stylesSource, /\.ai-article-translation \{[^}]*border-left:/);
  assert.doesNotMatch(stylesSource, /ai-translation-row\.is-bilingual/);
  assert.match(stylesSource, /@media \(max-width: 560px\)[\s\S]*?\.ai-paragraph-actions \{ flex-wrap: nowrap;/);
  assert.match(stylesSource, /\.ai-paragraph-narrate, \.ai-paragraph-translate \{ flex: 1 1 0;[\s\S]*?white-space: nowrap;/);
});
test('Today Article narration offers normal and slow rates with one active queue', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.match(render, /data-ai-narrate-article data-rate="1"/);
  assert.match(render, /data-ai-narrate-article data-rate="0\.75"/);
  assert.match(render, /▶ 整篇朗读/);
  assert.match(render, /🐢 慢速朗读/);
  assert.match(render, /■ 停止朗读/);
  const start = appSource.slice(appSource.indexOf('async function startAiArticleNarration'), appSource.indexOf('function aiSettingsHtml'));
  assert.match(start, /stopAiArticleNarration\(false\)/);
  assert.match(start, /narrationId !== state\.ai\.narrationId/);
});
test('Today Article narration can stop immediately and cancels queued segments', () => {
  const stop = appSource.slice(appSource.indexOf('function stopAiArticleNarration'), appSource.indexOf('async function startAiArticleNarration'));
  assert.match(stop, /narrationId \+= 1/);
  assert.match(stop, /narrationRate = null/);
  assert.match(stop, /stopEnglishPlayback\(\)/);
});
test('regenerating or leaving Today Article stops narration', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('async function toggleAiArticleTranslation'));
  assert.match(generate, /type === 'article'.*stopAiArticleNarration\(false\)/);
  const switching = appSource.slice(appSource.indexOf('function switchView'), appSource.indexOf('/* ---------- events'));
  assert.match(switching, /name !== 'ai'.*stopAiArticleNarration\(false\)/);
  const handler = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'"));
  assert.match(handler, /data-ai-home[\s\S]*?stopAiArticleNarration\(false\)/);
});
test('Article narration has no learning-data or history side effects', () => {
  const narration = appSource.slice(appSource.indexOf('function stopAiArticleNarration'), appSource.indexOf('function aiSettingsHtml'));
  assert.doesNotMatch(narration, /FlashStore|ArticleStore|rememberAiGeneration|gradeCard|streak|lapses|due\s*=/);
});
test('Today Article keeps the save behavior with lower-priority wording', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.match(render, /data-ai-save-article>保存到阅读库/);
  assert.doesNotMatch(render, /data-ai-save-article[^>]*btn-primary/);
  assert.match(appSource, /ArticleStore\.create\(\{[\s\S]*?title: preview\.data\.title, content: preview\.data\.content/);
});
test('AI generation does not call FlashStore or mutate review progress', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.doesNotMatch(generate, /FlashStore|gradeCard|streak|lapses|due\s*=/);
});
test('A/B experiment UI and request helpers have been removed', () => {
  assert.equal(typeof Ai.buildSentenceComparisonRequests, 'undefined');
  assert.equal(typeof Ai.buildArticleComparisonRequests, 'undefined');
  assert.doesNotMatch(appSource, /data-ai-compare|本地模型 A\/B|AI_EXPERIMENT_MODEL/);
});
test('existing Sentence duplicate uses the current exact-front helper', () => assert.match(appSource, /FlashArticleUtils\.sentenceExists\(state\.cards, sentence\.english\)/));
test('AI pronunciation reuses playEnglish', () => assert.match(appSource, /playEnglish\(button\.dataset\.aiSpeak/));
test('Today Sentence rotates its primary through history and sends only primary and optional secondary', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /FlashAiLearning\.sentencePracticeSelection\(/);
  assert.match(generate, /recentAiTargets: aiHistory\.generations/);
  assert.match(generate, /sentencePracticeTargets\(state\.ai\.targets\)/);
  assert.match(generate, /\{ count: 1 \}/);
});
test('Today Sentence renders one card with primary and optional secondary labels', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiSentences'), appSource.indexOf('function renderAiArticle'));
  assert.match(render, /sentences\[0\]/);
  assert.match(appSource, /主目标词/);
  assert.match(appSource, /顺带复习/);
  assert.doesNotMatch(render, /本轮候选重点词/);
  assert.match(render, /生成今日长句/);
  assert.match(render, /换一句/);
  assert.doesNotMatch(render, /生成 3 条长句/);
});
test('Today Sentence shows 主目标词 and 顺带复习 without exposing the candidate pool', () => {
  const section = appSource.slice(appSource.indexOf('function aiSentenceFocusHtml'), appSource.indexOf('function interactiveWordHtml'));
  assert.match(section, /主目标词/);
  assert.match(section, /顺带复习/);
  assert.match(section, /sentencePracticeTargets/);
  assert.doesNotMatch(section, /candidateCount|候选/);
  const render = appSource.slice(appSource.indexOf('function renderAiSentences'), appSource.indexOf('function renderAiArticle'));
  assert.doesNotMatch(render, /candidateCount/);
});
test('Today Article shows 本篇重点词 and never the internal candidate pool', () => {
  const render = appSource.slice(appSource.indexOf('function renderAiArticle'), appSource.indexOf('function renderAiView'));
  assert.match(render, /本篇重点词/);
  assert.equal(render.match(/aiTargetHtml\(state\.ai\.targets, '本篇重点词'\)/g).length, 1);
  assert.doesNotMatch(render, /candidateCount|候选池|候选重点词/);
});
test('AI history prefers actually used Sentence words and falls back to candidates', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /result\.data\.sentences\[0\]\?\.targetWordsUsed/);
  assert.match(generate, /sentenceHistoryTargets\(usedTargets, requestTargets\)/);
});
test('Article generation uses latest Sentence practice as an optional preference', () => {
  const generate = appSource.slice(appSource.indexOf('async function generateAi'), appSource.indexOf('/* ---------- articles'));
  assert.match(generate, /article \? FlashAiLearning\.latestSentencePrimaryTarget\(aiHistory\) : ''/);
  assert.match(generate, /aiTargets\(FlashAiLearning\.articleTargetCount\(\)\)/);
  assert.match(generate, /selectArticleFocusWords\(\{ targets: state\.ai\.targets, recentAiTargets: aiHistory\.generations, topic: state\.ai\.topic, articlePrimary: recentPrimary \}\)/);
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

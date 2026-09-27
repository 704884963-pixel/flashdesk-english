const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FlashLogic = require('../public/logic.js');

const now = 2_000_000;
const words = [
  { id: 'strategy', deck: 'Words', wordNumber: 10, front: 'strategy', back: '策略；战略', due: now + 9, streak: 2, lapses: 0, created: 10, memoryReading: 'stra + te + gy', chineseReading: '斯特拉-特-吉' },
  { id: 'approach', deck: 'Words', wordNumber: 11, front: 'approach', back: '方法；方式', due: now - 1, streak: 1, lapses: 1, created: 11 },
  { id: 'confidence', deck: 'Words', wordNumber: 12, front: 'confidence', back: '置信度；信心', due: now + 9, streak: 3, lapses: 0, created: 12 },
  { id: 'evidence', deck: 'Words', wordNumber: 13, front: 'evidence', back: '证据', due: now + 9, streak: 1, lapses: 0, created: 13 },
  { id: 'strict', deck: 'Words', wordNumber: 14, front: 'strict', back: '严格的', due: now + 9, streak: 0, lapses: 0, created: 14 },
  { id: 'state', deck: 'Words', wordNumber: 15, front: 'state', back: '状态', due: now + 9, streak: 0, lapses: 4, created: 15 },
  { id: 'summary', deck: 'Words', wordNumber: 16, front: 'summary', back: '总结', due: now + 9, streak: 1, lapses: 0, created: 16 },
  { id: 'workflow', deck: 'Words', wordNumber: 17, front: 'workflow', back: '工作流', due: now + 9, streak: 1, lapses: 0, created: 17 },
  { id: 'sentence', deck: 'Sentences', front: 'Use a strategy.', back: '使用策略。', due: 0, streak: 0, lapses: 0, created: 18 },
];

const zero = () => 0;

test('中文→英文 choices are all English Word fronts', () => {
  const q = FlashLogic.buildWordQuizQuestion(words, words[0], 'zh-en', zero);
  assert.ok(q.choices.every((choice) => words.some((card) => card.deck === 'Words' && card.front === choice)));
});

test('英文→中文 choices are all Chinese Word backs', () => {
  const q = FlashLogic.buildWordQuizQuestion(words, words[0], 'en-zh', zero);
  assert.ok(q.choices.every((choice) => words.some((card) => card.deck === 'Words' && card.back === choice)));
});

test('听音题 prompt hides answer text', () => {
  const q = FlashLogic.buildWordQuizQuestion(words, words[0], 'audio-en', zero);
  assert.equal(q.prompt, '');
  assert.equal(q.audioText, 'strategy');
});

test('Sentences never enter the Word detection pool', () => {
  assert.equal(FlashLogic.wordQuizPool(words).some((card) => card.deck === 'Sentences'), false);
});

test('智能混合 gives 易错词 the highest weight', () => {
  const weights = Object.fromEntries(words.slice(0, 6).map((card) => [card.id, FlashLogic.wordQuizWeight(card, 'smart', now)]));
  assert.ok(weights.state > weights.strict);
});

test('recovered historical lapse returns to due priority instead of weak priority', () => {
  assert.equal(FlashLogic.isWeakCard(words[1]), false);
  assert.ok(FlashLogic.wordQuizWeight(words[4], 'smart', now) > FlashLogic.wordQuizWeight(words[1], 'smart', now));
  assert.ok(FlashLogic.wordQuizWeight(words[5], 'lapsed', now) > FlashLogic.wordQuizWeight(words[1], 'lapsed', now));
});

test('智能混合 gives 新词 more weight than due and ordinary words', () => {
  assert.ok(FlashLogic.wordQuizWeight(words[4], 'smart', now) > FlashLogic.wordQuizWeight(words[1], 'smart', now));
  assert.ok(FlashLogic.wordQuizWeight(words[4], 'smart', now) > FlashLogic.wordQuizWeight(words[0], 'smart', now));
});

test('已掌握词 has lower smart weight than an ordinary word', () => {
  assert.ok(FlashLogic.wordQuizWeight(words[2], 'smart', now) < FlashLogic.wordQuizWeight(words[0], 'smart', now));
});

test('智能选题 places lapsed then new Word first', () => {
  assert.deepEqual(FlashLogic.selectWordQuizCards(words, 2, 'smart', now, zero).map((card) => card.id), ['state', 'strict']);
});

test('新词优先 fills remaining question slots from other Words', () => {
  const selected = FlashLogic.selectWordQuizCards(words, 4, 'new', now, zero);
  assert.equal(selected.length, 4);
  assert.equal(selected[0].id, 'strict');
});

test('易错词优先 sorts by lapse count then fills from other Words', () => {
  const selected = FlashLogic.selectWordQuizCards(words, 4, 'lapsed', now, zero);
  assert.equal(selected.length, 4);
  assert.equal(selected[0].id, 'state');
});

test('全部随机 samples without duplicate Words', () => {
  const ids = FlashLogic.selectWordQuizCards(words, 8, 'random', now, () => 0.4).map((card) => card.id);
  assert.equal(ids.length, new Set(ids).size);
});

test('each question has four unique choices', () => {
  const choices = FlashLogic.buildWordQuizChoices(words, words[0], 'zh-en', zero);
  assert.equal(choices.length, 4);
  assert.equal(new Set(choices).size, 4);
});

test('the correct answer is always one of the four choices', () => {
  for (const type of FlashLogic.WORD_QUIZ_TYPES) {
    const q = FlashLogic.buildWordQuizQuestion(words, words[0], type, zero);
    assert.ok(q.choices.includes(q.correct));
  }
});

test('all distractors come from the current Words', () => {
  const q = FlashLogic.buildWordQuizQuestion(words, words[0], 'audio-en', zero);
  assert.ok(q.choices.every((choice) => FlashLogic.wordQuizPool(words).some((card) => card.front === choice)));
});

test('nearby numbered Words are preferred as plausible distractors', () => {
  const q = FlashLogic.buildWordQuizQuestion(words, words[0], 'zh-en', zero);
  assert.ok(q.choices.includes('approach'));
});

test('enabled question types are mixed by short shuffled cycles', () => {
  const types = FlashLogic.mixedWordQuizTypes(FlashLogic.WORD_QUIZ_TYPES, 9, () => 0.4);
  for (let i = 0; i < types.length; i += 3) assert.equal(new Set(types.slice(i, i + 3)).size, 3);
});

test('错题再现 changes type when another enabled type exists', () => {
  assert.notEqual(FlashLogic.alternateWordQuizType('zh-en', FlashLogic.WORD_QUIZ_TYPES, zero), 'zh-en');
});

test('错题 is inserted after four other questions rather than immediately', () => {
  const base = Array.from({ length: 10 }, (_, index) => ({ cardId: String(index) }));
  const retry = { cardId: 'retry' };
  const result = FlashLogic.insertWordQuizRetry(base, 2, retry, 4);
  assert.equal(result[3].cardId, '3');
  assert.equal(result[7].cardId, 'retry');
});

test('result accuracy is rounded correctly', () => {
  assert.deepEqual(FlashLogic.wordQuizResult(17, 20), { correct: 17, wrong: 3, total: 20, percentage: 85 });
});

test('invalid and empty cards are excluded from question selection', () => {
  const invalid = [{ id: 'a', deck: 'Words', front: '', back: '空' }, { id: 'b', deck: 'Words', front: 'ok', back: '' }];
  assert.equal(FlashLogic.wordQuizPool([...words, ...invalid]).length, 8);
});

function appClient() {
  const nodes = new Map();
  const context = vm.createContext({
    FlashLogic,
    window: {},
    navigator: {},
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', hidden: false, textContent: '' });
        return nodes.get(selector);
      },
      querySelectorAll: () => [],
    },
    setTimeout,
    clearTimeout,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/init\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext(`state.cards = ${JSON.stringify(words)}; state.quiz = freshQuiz();`, context);
  return { run: (code) => vm.runInContext(code, context), nodes, source };
}

function prepareQuestion(h, type = 'zh-en') {
  h.run(`
    state.quiz.phase = 'question';
    state.quiz.questions = [quizQuestionFor(state.cards[0], ${JSON.stringify(type)})];
    state.quiz.baseSize = 1;
    state.quiz.idx = 0;
  `);
}

test('answering one option twice cannot increment score twice', () => {
  const h = appClient();
  prepareQuestion(h);
  h.run('answerQuiz(state.quiz.questions[0].choices.indexOf(state.quiz.questions[0].correct)); answerQuiz(0);');
  assert.equal(h.run('state.quiz.correct'), 1);
});

test('correct answer renders immediate positive feedback', () => {
  const h = appClient();
  prepareQuestion(h);
  h.run('answerQuiz(state.quiz.questions[0].choices.indexOf(state.quiz.questions[0].correct));');
  assert.match(h.nodes.get('#quiz-area').innerHTML, /✓ 正确/);
});

test('wrong answer renders selected and correct feedback', () => {
  const h = appClient();
  prepareQuestion(h);
  h.run('answerQuiz(state.quiz.questions[0].choices.findIndex((choice) => choice !== state.quiz.questions[0].correct));');
  const html = h.nodes.get('#quiz-area').innerHTML;
  assert.match(html, /✕ 回答错误/);
  assert.match(html, /你选择/);
  assert.match(html, /正确答案/);
});

test('wrong answer enters one delayed retry and is not next', () => {
  const h = appClient();
  h.run(`
    const selected = state.cards.slice(0, 6);
    const types = FlashLogic.mixedWordQuizTypes(enabledQuizTypes(), selected.length, () => 0);
    state.quiz.phase = 'question';
    state.quiz.questions = selected.map((card, i) => quizQuestionFor(card, types[i]));
    answerQuiz(state.quiz.questions[0].choices.findIndex((choice) => choice !== state.quiz.questions[0].correct));
  `);
  assert.equal(h.run('state.quiz.retryScheduledIds.length'), 1);
  assert.notEqual(h.run('state.quiz.questions[1].cardId'), 'strategy');
});

test('result hides wrong-only retest when there are no missed Words', () => {
  const h = appClient();
  h.run("state.quiz.phase = 'done'; state.quiz.correct = 4; state.quiz.wrong = 0; renderQuiz();");
  assert.doesNotMatch(h.nodes.get('#quiz-area').innerHTML, /只重测错题/);
});

test('result offers wrong-only retest and uses only missed Words', () => {
  const h = appClient();
  h.run("state.quiz.phase = 'done'; state.quiz.correct = 2; state.quiz.wrong = 1; state.quiz.missedIds = ['strategy']; renderQuiz();");
  assert.match(h.nodes.get('#quiz-area').innerHTML, /只重测错题/);
  h.run('retestMissedQuiz();');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(state.quiz.questions.map(q => q.cardId))')), ['strategy']);
});

test('finishing detection never writes Store history or review progress', () => {
  const h = appClient();
  h.run('globalThis.FlashStore = { logQuiz() { throw new Error("must not be called"); }, load() { throw new Error("must not be called"); } };');
  const before = h.run('JSON.stringify(state.cards)');
  h.run("state.quiz.correct = 1; state.quiz.wrong = 0; finishQuiz();");
  assert.equal(h.run('JSON.stringify(state.cards)'), before);
});

test('听音 button routes through the existing playEnglish path', () => {
  const h = appClient();
  assert.match(h.source, /data-quiz-listen/);
  assert.match(h.source, /playEnglish\(card\.front, \{ rate: 1, button: b \}\)/);
});

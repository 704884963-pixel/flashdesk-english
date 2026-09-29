const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FlashLogic = require('../public/logic.js');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
  .replace(/init\(\);\s*$/, '');

const now = new Date(2026, 8, 27, 12).getTime();
const day = 86400000;
const cards = [
  { id: '137', deck: 'Words', wordNumber: 137, front: 'approach', back: '方法；方式', forms: [], due: now - 3600000, streak: 0, lapses: 0, created: now - day },
  { id: '136', deck: 'Words', wordNumber: 136, front: 'expect', back: '预期；期待', forms: ['expected'], due: now + day, streak: 1, lapses: 1, created: now - day * 2 },
  { id: '135', deck: 'Words', wordNumber: 135, front: 'perform', back: '执行；表演', memoryReading: 'per + form', chineseReading: '破佛木', forms: [], due: now - day * 2, streak: 0, lapses: 3, created: now - day * 3 },
  { id: '134', deck: 'Words', wordNumber: 134, front: 'available', back: '可用的', forms: [], due: now + day * 3, streak: 3, lapses: 0, created: now - day * 4 },
  { id: 'old', deck: 'Words', front: 'apple', back: '苹果', due: now + day * 2, streak: 0, lapses: 0, created: now - day * 5 },
  { id: 'sentence', deck: 'Sentences', front: 'Approach the desk.', back: '走近桌子。', due: now - 1, streak: 0, lapses: 0, created: now },
];

function libraryClient(input = cards) {
  const nodes = new Map();
  const context = vm.createContext({
    FlashLogic,
    localStorage: { getItem: () => null },
    document: { querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false });
      return nodes.get(selector);
    } },
    input,
    now,
  });
  vm.runInContext(source, context);
  vm.runInContext('state.cards = input;', context);
  return { run: (code) => vm.runInContext(code, context), nodes };
}

function resultIds(h, query, filter = 'all') {
  return JSON.parse(h.run(`JSON.stringify(wordLibraryCards(state.cards, { query: ${JSON.stringify(query)}, filter: ${JSON.stringify(filter)}, now }).map(card => card.id))`));
}

test('Word Library searches English front', () => {
  assert.deepEqual(resultIds(libraryClient(), 'approach'), ['137']);
});

test('Word Library English search ignores case', () => {
  assert.deepEqual(resultIds(libraryClient(), 'APPROACH'), ['137']);
});

test('Word Library searches Chinese back', () => {
  assert.deepEqual(resultIds(libraryClient(), '方法'), ['137']);
});

test('Word Library searches wordNumber with or without hash', () => {
  const h = libraryClient();
  assert.deepEqual(resultIds(h, '137'), ['137']);
  assert.deepEqual(resultIds(h, '#137'), ['137']);
});

test('due filter uses due <= now', () => {
  assert.deepEqual(resultIds(libraryClient(), '', 'due'), ['135', '137']);
});

test('new filter means no streak and no lapses', () => {
  assert.deepEqual(resultIds(libraryClient(), '', 'new'), ['137', 'old']);
});

test('weak filter includes only unresolved lapses', () => {
  assert.deepEqual(resultIds(libraryClient(), '', 'lapsed'), ['135']);
});

test('recovered historical lapse is not weak in filter, count, or status', () => {
  const h = libraryClient();
  assert.equal(h.run("wordLibraryMatches(state.cards.find(card => card.id === '136'), 'lapsed', now)"), false);
  assert.equal(h.run('wordLibraryStats(state.cards, now).lapsed'), 1);
  assert.equal(h.run("wordLearningStatus(state.cards.find(card => card.id === '136'), now).label"), '学习中');
});

test('historical lapse filter includes every Word with lapses above zero', () => {
  const h = libraryClient();
  assert.equal(h.run("hasHistoricalLapse(state.cards.find(card => card.id === '137'))"), false);
  assert.equal(h.run("hasHistoricalLapse(state.cards.find(card => card.id === '136'))"), true);
  assert.equal(h.run("hasHistoricalLapse({ deck: 'Words', streak: 5, lapses: 5 })"), true);
  assert.equal(h.run("hasHistoricalLapse({ deck: 'Words', streak: 0 })"), false);
  assert.deepEqual(resultIds(h, '', 'forgotten'), ['136', '135']);
});

test('weak and historical lapse filters keep their distinct meanings', () => {
  const h = libraryClient();
  const recovered = "state.cards.find(card => card.id === '136')";
  assert.equal(h.run(`wordLibraryMatches(${recovered}, 'lapsed', now)`), false);
  assert.equal(h.run(`wordLibraryMatches(${recovered}, 'forgotten', now)`), true);
  assert.equal(h.run('wordLibraryStats(state.cards, now).lapsed'), 1);
  assert.equal(h.run('wordLibraryStats(state.cards, now).forgotten'), 2);
});

test('historical lapse filter combines with Word Library search', () => {
  const h = libraryClient();
  assert.deepEqual(resultIds(h, 'expect', 'forgotten'), ['136']);
  assert.deepEqual(resultIds(h, 'approach', 'forgotten'), []);
});

test('historical lapse chip uses the existing Word Library filter interaction', () => {
  const h = libraryClient();
  h.run(`handleWordLibraryClick({ target: { closest: (selector) => selector === '[data-word-filter]'
    ? { dataset: { wordFilter: 'forgotten' } }
    : null } });`);
  assert.equal(h.run('state.wordLibrary.filter'), 'forgotten');
  assert.equal(h.run("document.querySelector('#word-library').innerHTML.includes('曾经忘记')"), true);
});

test('Word cards show a subtle historical lapse count only when positive', () => {
  const h = libraryClient();
  assert.match(h.run("wordListItemHtml(state.cards.find(card => card.id === '136'), now)"), /曾忘 1 次/);
  assert.match(h.run("wordListItemHtml(state.cards.find(card => card.id === '135'), now)"), /曾忘 3 次/);
  assert.doesNotMatch(h.run("wordListItemHtml(state.cards.find(card => card.id === '137'), now)"), /曾忘/);
});

test('Sentences are excluded from historical lapse statistics', () => {
  const sentenceWithLapse = { ...cards.at(-1), lapses: 4 };
  const h = libraryClient([...cards.slice(0, -1), sentenceWithLapse]);
  assert.equal(h.run('wordLibraryStats(state.cards, now).forgotten'), 2);
  assert.equal(resultIds(h, '', 'forgotten').includes('sentence'), false);
});

test('mastered filter follows recovered streak rather than lifetime lapses', () => {
  assert.deepEqual(resultIds(libraryClient(), '', 'mastered'), ['134']);
  const recovered = { ...cards[3], id: 'recovered-mastered', wordNumber: 133, lapses: 2 };
  assert.deepEqual(resultIds(libraryClient([...cards, recovered]), '', 'mastered'), ['134', 'recovered-mastered']);
});

test('Word Library weak checks use the shared helper', () => {
  assert.match(source, /filter === 'lapsed'\) return FlashLogic\.isWeakCard\(card\)/);
  assert.match(source, /function wordLearningStatus[\s\S]*?FlashLogic\.isWeakCard\(card\)/);
});

test('default sort is descending wordNumber with legacy Words last', () => {
  assert.deepEqual(resultIds(libraryClient(), ''), ['137', '136', '135', '134', 'old']);
});

test('lapsed sort puts higher lapse counts first', () => {
  const extra = { ...cards[0], id: 'low-lapse', wordNumber: 133, front: 'lower', lapses: 1 };
  assert.deepEqual(resultIds(libraryClient([...cards, extra]), '', 'lapsed'), ['135', 'low-lapse']);
});

test('due formatter returns natural Chinese dates', () => {
  const h = libraryClient();
  assert.equal(h.run('formatWordDue(now - 86400000, now)'), '已逾期');
  assert.equal(h.run('formatWordDue(now, now)'), '今天');
  assert.equal(h.run('formatWordDue(now + 86400000, now)'), '明天');
  assert.equal(h.run('formatWordDue(now + 3 * 86400000, now)'), '3天后');
});

test('legacy Word without wordNumber renders safely after numbered Words', () => {
  const h = libraryClient();
  assert.match(h.run("wordListItemHtml(state.cards.find(card => card.id === 'old'), now)"), /#未编号/);
  assert.equal(resultIds(h, '').at(-1), 'old');
});

test('empty memoryReading does not render an empty detail section', () => {
  const h = libraryClient();
  const html = h.run("wordDetailHtml(state.cards.find(card => card.id === '137'), now)");
  assert.doesNotMatch(html, /发音拆解/);
});

test('empty forms render a compact 暂无 value', () => {
  const h = libraryClient();
  const html = h.run("wordDetailHtml(state.cards.find(card => card.id === '137'), now)");
  assert.match(html, /词形变化/);
  assert.match(html, /暂无/);
});

test('pronunciation click stops propagation and never opens detail', () => {
  const h = libraryClient();
  h.run(`
    globalThis.played = [];
    playEnglish = (text, options) => played.push({ text, rate: options.rate });
    globalThis.speechButton = { dataset: { wordSpeak: '137', speakRate: '0.75' } };
    globalThis.speechEvent = {
      prevented: false,
      stopped: false,
      target: { closest: (selector) => selector === '[data-word-speak]' ? speechButton : null },
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    handleWordLibraryClick(speechEvent);
  `);
  assert.equal(h.run('state.wordLibrary.selectedId'), null);
  assert.equal(h.run('speechEvent.prevented && speechEvent.stopped'), true);
  assert.equal(h.run('JSON.stringify(played[0])'), JSON.stringify({ text: 'approach', rate: 0.75 }));
});

test('Word detail shows canonical fields and learning state', () => {
  const h = libraryClient();
  const html = h.run("wordDetailHtml(state.cards.find(card => card.id === '135'), now)");
  assert.match(html, /#135/);
  assert.match(html, /perform/);
  assert.match(html, /执行；表演/);
  assert.match(html, /per \+ form/);
  assert.match(html, /破佛木/);
  assert.match(html, /连续答对/);
  assert.match(html, /错误次数/);
  assert.match(html, /开始复习/);
  assert.match(html, /data-word-edit/);
});

test('edited Word rerenders immediately while protected fields stay intact', () => {
  const h = libraryClient();
  const before = h.run("JSON.stringify((({ id, deck, wordNumber, due, streak, lapses, created }) => ({ id, deck, wordNumber, due, streak, lapses, created }))(state.cards[0]))");
  h.run("state.wordLibrary.selectedId = '137'; state.cards[0] = { ...state.cards[0], front: 'approached', back: '已接近' };");
  const after = h.run("JSON.stringify((({ id, deck, wordNumber, due, streak, lapses, created }) => ({ id, deck, wordNumber, due, streak, lapses, created }))(state.cards[0]))");
  assert.equal(after, before);
  assert.match(h.run('wordDetailHtml(state.cards[0], now)'), /approached/);
  assert.match(h.run('wordDetailHtml(state.cards[0], now)'), /已接近/);
});

test('Sentences never enter Word Library or its statistics', () => {
  const h = libraryClient();
  assert.equal(resultIds(h, '').includes('sentence'), false);
  assert.equal(h.run('wordLibraryStats(state.cards, now).all'), 5);
});

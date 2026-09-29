const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FlashLogic = require('../public/logic.js');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const card = (id, front, back, deck = 'Words', fields = {}) => ({
  id, front, back, deck, due: 0, streak: 0, lapses: 0, created: 0, ...fields,
});

function reviewClient(cards) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      hidden: false, innerHTML: '', textContent: '',
      querySelectorAll: () => [],
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    FlashLogic,
    cards,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelector: node },
  });
  vm.runInContext(appSource.replace(/init\(\);\s*$/, ''), context);
  vm.runInContext(`
    globalThis.gradeCalls = [];
    globalThis.sessionLogs = [];
    globalThis.FlashStore = {
      async gradeCard(id, kind) {
        gradeCalls.push({ id, kind });
        const card = state.cards.find((item) => item.id === id);
        if (!card) throw new Error('card not found');
        FlashLogic.gradeReviewCard(card, kind);
        return { card: JSON.parse(JSON.stringify(card)) };
      },
      async logSession(summary) { sessionLogs.push(summary); return { ok: true, logged: true }; },
      logNote(logged) { return logged === null ? 'Saving…' : 'Saved on this device'; },
    };
    state.cards = cards.map((item) => ({ ...item }));
    state.deckFilter = 'All';
    state.session = freshSession();
    buildQueue();
  `, context);
  return { context, nodes, run: (source) => vm.runInContext(source, context) };
}

async function gradeFirst(client, kind = 'got') {
  await client.run(`(async () => {
    state.session.currentId = state.session.queue[0];
    state.session.revealed = true;
    await grade('${kind}');
  })()`);
}

test('grading one reversed card changes only the displayed entity and counts one review', async () => {
  const first = card('a', 'term', 'definition');
  const twin = card('b', 'definition', 'term', 'Words', { lapses: 2 });
  const client = reviewClient([first, twin]);
  const beforeTwin = client.run("JSON.stringify(state.cards.find((item) => item.id === 'b'))");
  await gradeFirst(client);
  assert.equal(client.run('JSON.stringify(gradeCalls.map((item) => item.id))'), JSON.stringify(['a']));
  assert.equal(client.run('state.session.reviewed'), 1);
  assert.equal(client.run("state.cards.find((item) => item.id === 'a').streak"), 1);
  assert.equal(client.run("JSON.stringify(state.cards.find((item) => item.id === 'b'))"), beforeTwin);
  assert.equal(client.run('JSON.stringify(state.session.queue)'), JSON.stringify(['b']));
});

test('90 ratings among 99 due entities modify exactly 90 cards and leave nine new', async () => {
  const cards = [];
  for (let i = 0; i < 9; i += 1) {
    cards.push(card(`a${i}`, `term ${i}`, `definition ${i}`));
    cards.push(card(`b${i}`, `definition ${i}`, `term ${i}`));
  }
  for (let i = 18; i < 99; i += 1) cards.push(card(`c${i}`, `term ${i}`, `definition ${i}`));
  const client = reviewClient(cards);
  assert.equal(client.run('state.session.queue.length'), 99);
  for (let i = 0; i < 90; i += 1) await gradeFirst(client);
  assert.equal(client.run('gradeCalls.length'), 90);
  assert.equal(client.run('state.session.reviewed'), 90);
  assert.equal(client.run('state.cards.filter((item) => item.streak === 1).length'), 90);
  assert.equal(client.run('state.cards.filter((item) => item.streak === 0).length'), 9);
  assert.equal(client.run('state.session.queue.length'), 9);
});

test('session completion never schedules cards still remaining in the queue', async () => {
  const client = reviewClient([
    card('a', 'one', '一'), card('b', 'two', '二'), card('c', 'three', '三'),
  ]);
  await gradeFirst(client);
  const before = client.run("JSON.stringify(state.cards.filter((item) => item.id !== 'a'))");
  await client.run('completeSession()');
  assert.equal(client.run("JSON.stringify(state.cards.filter((item) => item.id !== 'a'))"), before);
  assert.equal(client.run('gradeCalls.length'), 1);
  assert.equal(client.run('state.session.queue.length'), 2);
});

test('Word and Sentence Review items are independently shown and graded', async () => {
  const client = reviewClient([
    card('word', 'approach', '方法'),
    card('sentence', 'Use a careful approach.', '使用谨慎的方法。', 'Sentences'),
  ]);
  assert.equal(client.run('JSON.stringify(state.session.queue)'), JSON.stringify(['word', 'sentence']));
  await gradeFirst(client);
  await gradeFirst(client);
  assert.equal(client.run('JSON.stringify(gradeCalls.map((item) => item.id))'), JSON.stringify(['word', 'sentence']));
  assert.equal(client.run('state.cards.every((item) => item.streak === 1)'), true);
});

test('Review completion summary matches the two explicit ratings', async () => {
  const client = reviewClient([card('a', 'one', '一'), card('b', 'two', '二')]);
  await gradeFirst(client, 'got');
  await gradeFirst(client, 'again');
  assert.equal(client.run('JSON.stringify({ reviewed: state.session.reviewed, correct: state.session.correct, again: state.session.again, complete: state.session.complete })'), JSON.stringify({
    reviewed: 2, correct: 1, again: 1, complete: true,
  }));
  assert.equal(client.run('sessionLogs.length'), 1);
  assert.match(client.nodes.get('#review-area').innerHTML, /已复习 2 张卡片 · 记住了 1 张 · 很熟 0 张 · 再来一次 1 张 · 正确率 50%/);
});

test('Review grade contains exactly one current-card gradeCard call', () => {
  const section = appSource.slice(appSource.indexOf('async function grade(kind)'), appSource.indexOf('async function completeSession'));
  assert.equal((section.match(/FlashStore\.gradeCard\(/g) || []).length, 1);
  assert.doesNotMatch(section, /twin|关联卡片/);
});

test('easy grades only the current entity once and records a distinct history count', async () => {
  const client = reviewClient([card('a', 'one', '一'), card('b', '一', 'one')]);
  await gradeFirst(client, 'easy');
  assert.equal(client.run('JSON.stringify(gradeCalls)'), JSON.stringify([{ id: 'a', kind: 'easy' }]));
  assert.equal(client.run("state.cards.find((item) => item.id === 'a').streak"), 1);
  assert.equal(client.run("state.cards.find((item) => item.id === 'a').reviewStep"), 3);
  assert.equal(client.run("state.cards.find((item) => item.id === 'b').streak"), 0);
  assert.equal(client.run('state.session.correct'), 1);
  assert.equal(client.run('state.session.easy'), 1);
  await gradeFirst(client, 'got');
  assert.equal(client.run('sessionLogs[0].easy'), 1);
  assert.equal(client.run('sessionLogs[0].remember'), 1);
});

test('Review renders three horizontal grade buttons including the secondary easy action', () => {
  const render = appSource.slice(appSource.indexOf('function renderReview()'), appSource.indexOf('function setFlipped'));
  const styles = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(render, /id="grade-easy"[^>]*>很熟<\/button>/);
  assert.match(styles, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.btn-grade[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.btn-easy\s*{[^}]*background:\s*var\(--accent-dim\)[^}]*border-color:\s*var\(--accent\)/s);
});

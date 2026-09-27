const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client(cards) {
  const nodes = new Map();
  const context = vm.createContext({
    localStorage: { getItem: () => null },
    document: { querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {});
      return nodes.get(selector);
    } },
    cards,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  // Exercise real rendering/helpers without bootstrapping DOM event bindings.
  vm.runInContext(source.replace(/init\(\);\s*$/, ''), context);
  vm.runInContext('state.cards = cards; state.session.queue = cards.map(c => c.id);', context);
  return { run: (code) => vm.runInContext(code, context), nodes };
}
const old = { id: 'old', front: 'apple', back: '苹果', deck: 'Words', due: 0 };

test('old Word safely renders Review and Browse without mutating the card', () => {
  const card = { ...old };
  const h = client([card]);
  assert.equal(h.run('JSON.stringify(wordDetails(cards[0]))'), JSON.stringify({ wordNumber: null, memoryReading: '', chineseReading: '', forms: [] }));
  h.run('renderReview(); renderBrowse();');
  const html = h.nodes.get('#review-area').innerHTML;
  assert.match(html, /🇨🇳 中文意思/);
  assert.doesNotMatch(html, /🧠|🗣|词形变化/);
  assert.match(h.nodes.get('#browse-table tbody').innerHTML, /#未编号/);
  assert.deepEqual(card, old);
});

test('Word back shows ordered escaped details while front contains no answer', () => {
  const h = client([{ ...old, wordNumber: 138, memoryReading: '<hint>', chineseReading: '读法', forms: ['expected'] }]);
  h.run('renderReview();');
  const html = h.nodes.get('#review-area').innerHTML;
  const front = html.split('class="card-face face-front"')[1].split('class="card-face face-back"')[0];
  assert.doesNotMatch(front, /苹果|读法|hint|expected/);
  const back = h.run('wordBackHtml(cards[0])');
  const labels = ['#138', '🧠 发音拆解', '🗣 中文近似', '🇨🇳 中文意思', '词形变化'];
  assert.deepEqual(labels.map((label) => back.indexOf(label)), labels.map((label) => back.indexOf(label)).sort((a, b) => a - b));
  assert.match(back, /&lt;hint&gt;/);
  assert.doesNotMatch(back, /<hint>/);
});

test('Add/Edit share forms parser for comma, Chinese comma and newline', () => {
  const h = client([]);
  assert.equal(h.run("JSON.stringify(parseForms(' expected，expecting\\nexpected, Expected,  '))"), JSON.stringify(['expected', 'expecting', 'Expected']));
});

test('Quiz keeps existing front/back interpretation and ignores Word extras', () => {
  const h = client([{ ...old, wordNumber: 138, memoryReading: 'not a choice', forms: ['not a question'] }]);
  assert.equal(h.run('JSON.stringify(quizPool())'), JSON.stringify([{ cardId: 'old', term: '苹果', definition: 'apple' }]));
});

test('Sentence Review keeps original front/back presentation', () => {
  const h = client([{ ...old, deck: 'Sentences' }]);
  h.run('renderReview();');
  const html = h.nodes.get('#review-area').innerHTML;
  assert.match(html, /class="card-back">苹果/);
  assert.doesNotMatch(html, /word-back|🇨🇳/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const FlashLogic = require('../public/logic.js');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const word = (front = 'expect') => ({ front, back: '期待', deck: 'Words' });
const legacy = { ...word('approach'), id: 'old', due: 123, streak: 4, lapses: 2, created: 100 };

async function harness(t, mode, initial = { cards: [], history: [] }) {
  let fail = false;
  let stored = JSON.stringify(initial);
  if (mode === 'PWA') {
    const window = { FlashLogic };
    vm.runInNewContext(source('pwa/store-local.js'), {
      window, navigator: {}, localStorage: {
        getItem: () => stored,
        setItem(_key, value) { if (fail) throw new Error('write failed'); stored = value; },
      },
    });
    return { store: window.FlashStore, read: () => JSON.parse(stored), fail: (v) => { fail = v; } };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashdesk-word-test-'));
  const file = path.join(dir, 'flashdesk-data.json');
  fs.writeFileSync(file, stored);
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true }); // Only this harness's own temporary directory.
  });
  vm.runInNewContext(source('server.js'), {
    __dirname: dir, URL, console: { log() {}, error() {} },
    require(name) {
      if (name === './seed.js') return [];
      if (name === './public/logic.js') return FlashLogic;
      if (name === 'node:os') return { homedir: () => dir };
      if (name === 'node:fs') return { ...fs, renameSync(...args) {
        if (fail) throw new Error('write failed');
        return fs.renameSync(...args);
      } };
      if (name === 'node:http') return { createServer(handler) {
        server = http.createServer(handler);
        const listen = server.listen.bind(server);
        server.listen = (_port, cb) => listen(0, '127.0.0.1', cb);
        return server;
      } };
      return require(name);
    },
  });
  if (!server.listening) await once(server, 'listening');
  const window = {};
  vm.runInNewContext(source('public/store.js'), {
    window, fetch: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, options),
  });
  return { store: window.FlashStore, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), fail: (v) => { fail = v; } };
}

for (const mode of ['Node', 'PWA']) {
  test(`${mode}: edit all Word content but preserve number and review fields`, async (t) => {
    const original = { ...legacy, wordNumber: 138, memoryReading: '', chineseReading: '', forms: [] };
    const h = await harness(t, mode, { cards: [original], history: [], meta: { nextWordNumber: 139 } });
    const { card } = await h.store.updateCard('old', {
      front: ' expect ', back: ' 预期；期待 ', memoryReading: ' ex + pect ', chineseReading: ' 伊克斯 ',
      forms: [' expected ', '', 'expected', 'Expected'], id: 'bad', deck: 'Sentences',
      wordNumber: 999, due: 0, streak: 0, lapses: 0, created: 0,
    });
    assert.deepEqual(plain(card), { ...original, front: 'expect', back: '预期；期待',
      memoryReading: 'ex + pect', chineseReading: '伊克斯', forms: ['expected'] });
    assert.equal(h.read().meta.nextWordNumber, 139);
  });
  test(`${mode}: edit rejects case/space duplicate but allows own front`, async (t) => {
    const h = await harness(t, mode, { cards: [legacy, { ...legacy, id: 'other', front: 'expect' }], history: [] });
    for (const front of ['Expect', ' expect ', 'EXPECT']) {
      await assert.rejects(h.store.updateCard('old', { front, back: 'new' }), /该单词已存在/);
    }
    assert.equal((await h.store.updateCard('old', { front: ' APPROACH ', back: 'new' })).card.front, 'APPROACH');
    assert.equal(h.read().cards.length, 2);
  });
  test(`${mode}: legacy edit adds details without assigning a number or changing progress`, async (t) => {
    const h = await harness(t, mode, { cards: [legacy], history: [] });
    await h.store.updateCard('old', { front: legacy.front, back: legacy.back,
      memoryReading: 'hint', chineseReading: '读法', forms: ['approached'] });
    const card = (await h.store.load()).cards[0];
    assert.deepEqual(plain(card), { ...legacy, wordNumber: null, memoryReading: 'hint', chineseReading: '读法', forms: ['approached'] });
    assert.equal(h.read().meta, undefined);
  });
  test(`${mode}: Sentence edit ignores Word fields and duplicate rule`, async (t) => {
    const original = { ...legacy, deck: 'Sentences' };
    const h = await harness(t, mode, { cards: [original], history: [] });
    const { card } = await h.store.updateCard('old', { front: 'new', back: 'new back',
      memoryReading: 7, chineseReading: null, forms: {}, wordNumber: 99 });
    assert.deepEqual(plain(card), { ...original, front: 'new', back: 'new back' });
  });
  test(`${mode}: invalid edit details and failed write leave all fields unchanged`, async (t) => {
    const initial = { cards: [legacy], history: [] };
    const h = await harness(t, mode, initial);
    for (const invalid of [{ memoryReading: null }, { chineseReading: 1 }, { forms: 'x' }, { forms: [1] }]) {
      await assert.rejects(h.store.updateCard('old', { front: 'new', back: 'new', ...invalid }));
      assert.deepEqual(h.read(), initial);
    }
    h.fail(true);
    await assert.rejects(h.store.updateCard('old', { front: 'new', back: 'new', memoryReading: 'hint', forms: ['form'] }));
    assert.deepEqual(h.read(), initial);
    assert.equal((await h.store.load()).cards[0].front, legacy.front);
    assert.equal((await h.store.load()).cards[0].memoryReading, '');
  });
  test(`${mode}: first Word and consecutive numbering; client number ignored`, async (t) => {
    const h = await harness(t, mode);
    const first = (await h.store.addCard({ ...word(), wordNumber: 999 })).card;
    assert.equal(first.wordNumber, 1);
    assert.equal((await h.store.addCard(word('next'))).card.wordNumber, 2);
    assert.equal(h.read().meta.nextWordNumber, 3);
    assert.equal(first.memoryReading, '');
    assert.equal(first.chineseReading, '');
    assert.deepEqual(plain(first.forms), []);
  });
  test(`${mode}: deletion never reuses the largest number`, async (t) => {
    const h = await harness(t, mode);
    await h.store.addCard(word());
    const { card } = await h.store.addCard(word('next'));
    await h.store.deleteCard(card.id);
    assert.equal((await h.store.addCard(word('third'))).card.wordNumber, 3);
  });
  test(`${mode}: legacy load defaults do not migrate persisted data`, async (t) => {
    const initial = { cards: [legacy], history: [] };
    const h = await harness(t, mode, initial);
    assert.deepEqual(plain((await h.store.load()).cards[0]), {
      ...legacy, wordNumber: null, memoryReading: '', chineseReading: '', forms: [],
    });
    assert.deepEqual(h.read(), initial);
    assert.equal('reviewStep' in h.read().cards[0], false);
    assert.equal((await h.store.addCard(word())).card.wordNumber, 1);
    assert.deepEqual(h.read().cards[0], legacy);
  });
  test(`${mode}: existing 1..137 initializes next number to 138`, async (t) => {
    const cards = Array.from({ length: 137 }, (_, i) => ({ ...legacy, id: String(i), front: `word${i}`, wordNumber: i + 1 }));
    const h = await harness(t, mode, { cards, history: [] });
    assert.equal((await h.store.addCard(word())).card.wordNumber, 138);
    assert.equal(h.read().meta.nextWordNumber, 139);
  });
  test(`${mode}: deleting numbered legacy card before first add preserves high water`, async (t) => {
    const h = await harness(t, mode, { cards: [{ ...legacy, wordNumber: 137 }], history: [] });
    await h.store.deleteCard('old');
    assert.equal((await h.store.addCard(word())).card.wordNumber, 138);
  });
  test(`${mode}: existing meta wins over remaining cards`, async (t) => {
    const h = await harness(t, mode, { cards: [], history: [], meta: { nextWordNumber: 200, custom: true } });
    assert.equal((await h.store.addCard(word())).card.wordNumber, 200);
    assert.deepEqual(h.read().meta, { nextWordNumber: 201, custom: true });
  });
  test(`${mode}: duplicates include legacy Words, case and spaces`, async (t) => {
    const h = await harness(t, mode, { cards: [{ ...legacy, front: 'Expect' }], history: [] });
    for (const front of ['Expect', 'expect', ' expect ', ' EXPECT ']) {
      await assert.rejects(h.store.addCard(word(front)), /该单词已存在/);
    }
    assert.equal(h.read().cards.length, 1);
    assert.equal(h.read().meta, undefined);
  });
  test(`${mode}: readings and forms normalize, retain case and return independent copies`, async (t) => {
    const h = await harness(t, mode);
    const { card } = await h.store.addCard({ ...word(' expect '), memoryReading: ' ex + pect ',
      chineseReading: ' 伊克斯-佩克特 ', forms: [' expected ', '', 'expected', 'Expected', ' expecting ', '  '] });
    assert.equal(card.front, 'expect');
    assert.equal(card.memoryReading, 'ex + pect');
    assert.equal(card.chineseReading, '伊克斯-佩克特');
    assert.deepEqual(plain(card.forms), ['expected', 'expecting']);
    card.forms.push('mutation');
    assert.equal((await h.store.load()).cards[0].forms.length, 2);
  });
  test(`${mode}: forms remove the front itself with case-insensitive comparison`, async (t) => {
    const h = await harness(t, mode);
    const { card } = await h.store.addCard({ ...word('Expect'), forms: [' expect ', 'expects', 'EXPECTED', 'expected', 'expecting'] });
    assert.deepEqual(plain(card.forms), ['expects', 'EXPECTED', 'expecting']);
  });
  test(`${mode}: invalid Word fields rejected without consuming a number`, async (t) => {
    const h = await harness(t, mode);
    for (const invalid of [{ front: '' }, { back: ' ' }, { front: 1 }, { back: null },
      { memoryReading: null }, { chineseReading: 42 }, { forms: 'expected' }, { forms: [{}] }]) {
      await assert.rejects(h.store.addCard({ ...word(), ...invalid }));
    }
    assert.equal((await h.store.addCard(word())).card.wordNumber, 1);
  });
  test(`${mode}: Sentences and other decks keep original shape and allow repeats`, async (t) => {
    const h = await harness(t, mode);
    for (const deck of ['Sentences', 'Other']) {
      for (let i = 0; i < 2; i++) {
        const { card } = await h.store.addCard({ ...word(), deck, forms: null });
        assert.equal(card.deck, deck);
        assert.equal('wordNumber' in card, false);
        assert.equal('forms' in card, false);
      }
    }
    assert.equal(h.read().meta, undefined);
  });
  test(`${mode}: write failure rolls back card and counter; retry succeeds`, async (t) => {
    const h = await harness(t, mode);
    h.fail(true);
    await assert.rejects(h.store.addCard(word()));
    assert.equal((await h.store.load()).cards.length, 0);
    assert.equal(h.read().meta, undefined);
    h.fail(false);
    assert.equal((await h.store.addCard(word())).card.wordNumber, 1);
  });
  test(`${mode}: v0.2 editing preserves all Word extras and progress`, async (t) => {
    const h = await harness(t, mode);
    const { card } = await h.store.addCard({ ...word(), forms: ['expected'], memoryReading: 'hint', chineseReading: '读法' });
    const result = await h.store.updateCard(card.id, { front: 'changed', back: '修改', wordNumber: 999 });
    assert.deepEqual(plain(result.card), { ...plain(card), front: 'changed', back: '修改' });
  });
  test(`${mode}: a correct review resolves current weakness without clearing lapse history`, async (t) => {
    const h = await harness(t, mode);
    const { card } = await h.store.addCard(word('recover'));
    const afterAgain = (await h.store.gradeCard(card.id, 'again')).card;
    assert.equal(FlashLogic.isWeakCard(afterAgain), true);
    assert.equal(afterAgain.lapses, 1);
    const afterGot = (await h.store.gradeCard(card.id, 'got')).card;
    assert.equal(FlashLogic.isWeakCard(afterGot), false);
    assert.equal(afterGot.streak, 1);
    assert.equal(afterGot.lapses, 1);
    assert.equal(afterGot.reviewStep, 0);
  });
  test(`${mode}: legacy review steps upgrade naturally on remember`, async (t) => {
    const day = 86400000;
    for (const [streak, expectedStep, expectedDays] of [[1, 1, 3], [2, 2, 7], [3, 3, 14]]) {
      const id = `legacy-${streak}`;
      const h = await harness(t, mode, { cards: [{ ...legacy, id, streak, lapses: 0 }], history: [] });
      const started = Date.now();
      const result = (await h.store.gradeCard(id, 'got')).card;
      assert.equal(result.streak, streak + 1);
      assert.equal(result.reviewStep, expectedStep);
      assert.ok(Math.abs(result.due - (started + expectedDays * day)) < 1000);
    }
  });
  test(`${mode}: easy and again share the canonical review scheduler`, async (t) => {
    const day = 86400000;
    const h = await harness(t, mode, { cards: [{ ...legacy, id: 'review', streak: 0, lapses: 0 }], history: [] });
    const started = Date.now();
    const easy = (await h.store.gradeCard('review', 'easy')).card;
    assert.equal(easy.streak, 1);
    assert.equal(easy.reviewStep, 3);
    assert.equal(easy.lapses, 0);
    assert.ok(Math.abs(easy.due - (started + 14 * day)) < 1000);
    assert.equal(easy.streak >= 3, false);
    const againStarted = Date.now();
    const again = (await h.store.gradeCard('review', 'again')).card;
    assert.equal(again.streak, 0);
    assert.equal(again.reviewStep, 0);
    assert.equal(again.lapses, 1);
    assert.ok(Math.abs(again.due - (againStarted + 10 * 60 * 1000)) < 1000);
    const remembered = (await h.store.gradeCard('review', 'got')).card;
    assert.equal(remembered.streak, 1);
    assert.equal(remembered.reviewStep, 0);
  });
  test(`${mode}: session history distinguishes remember, easy and again`, async (t) => {
    const h = await harness(t, mode, { cards: [], history: [] });
    await h.store.logSession({ deck: 'Words', reviewed: 3, correct: 2, remember: 1, easy: 1, again: 1 });
    assert.deepEqual(h.read().history[0], {
      date: h.read().history[0].date, deck: 'Words', reviewed: 3, correct: 2, remember: 1, easy: 1, again: 1,
    });
  });
}

test('PWA full backup round trip preserves extras, progress and counter', async (t) => {
  const h = await harness(t, 'PWA');
  const { card } = await h.store.addCard({ ...word(), memoryReading: 'hint', chineseReading: '读法', forms: ['expected'] });
  const backup = h.store.exportData();
  const restored = await harness(t, 'PWA');
  restored.store.importData(backup);
  assert.deepEqual(restored.read(), h.read());
  await restored.store.deleteCard(card.id);
  restored.store.importData(JSON.stringify({ cards: [], history: [] }));
  assert.equal((await restored.store.addCard(word('new'))).card.wordNumber, 2);
});

test('PWA list import assigns numbers, preserves readings/forms and skips Word duplicates', async (t) => {
  const h = await harness(t, 'PWA');
  h.store.importData(JSON.stringify([{ ...word(), memoryReading: 'hint', forms: [' expected ', 'expected'] }, word(' EXPECT ')]));
  assert.equal(h.read().cards.length, 1);
  assert.equal(h.read().cards[0].memoryReading, 'hint');
  assert.deepEqual(h.read().cards[0].forms, ['expected']);
  assert.equal((await h.store.addCard(word('next'))).card.wordNumber, 2);
});

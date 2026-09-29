const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const Batch = require('../public/batch-import.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

const wordText = `WORD
front: expect
back: 期待；预期
memoryReading: ex + pect
chineseReading: 伊克斯-佩克特
forms: expected`;
const sentenceText = `SENTENCE
front: The agent receives the query.
back: 智能体接收查询。`;
const existingWord = {
  id: 'existing', deck: 'Words', wordNumber: 137, front: 'approach', back: '方法',
  memoryReading: 'old hint', chineseReading: '旧读法', forms: ['approached'],
  due: 123, streak: 4, lapses: 2, created: 100,
};
const existingSentence = {
  id: 'sentence', deck: 'Sentences', front: 'Existing sentence.', back: '已有句子。',
  due: 456, streak: 2, lapses: 1, created: 200,
};
const baseData = () => ({ cards: [existingWord, existingSentence], history: [{ date: '2026-09-27' }], meta: { nextWordNumber: 138 } });

const preview = (text, data = baseData()) => Batch.previewBatchText(text, data.cards, data.meta);

test('parses one Word block', () => {
  const item = Batch.parseBatchText(wordText)[0];
  assert.equal(item.deck, 'Words');
  assert.equal(item.front, 'expect');
  assert.equal(item.back, '期待；预期');
  assert.equal(item.memoryReading, 'ex + pect');
  assert.equal(item.chineseReading, '伊克斯-佩克特');
});

test('parses multiple Word blocks', () => {
  assert.equal(Batch.parseBatchText(`${wordText}\n\nWORD\nfront: strict\nback: 严格的`).length, 2);
});

test('parses a Sentence block', () => {
  const item = Batch.parseBatchText(sentenceText)[0];
  assert.deepEqual({ deck: item.deck, front: item.front, back: item.back }, {
    deck: 'Sentences', front: 'The agent receives the query.', back: '智能体接收查询。',
  });
});

test('parses mixed Word and Sentence input', () => {
  assert.deepEqual(Batch.parseBatchText(`${wordText}\n\n${sentenceText}`).map((item) => item.deck), ['Words', 'Sentences']);
});

test('new Words receive sequential expected numbers', () => {
  const p = preview(`${wordText}\n\nWORD\nfront: strict\nback: 严格的`);
  assert.deepEqual(p.items.map((item) => item.expectedWordNumber), [138, 139]);
});

test('Sentence does not consume an expected Word number', () => {
  const p = preview(`${wordText}\n\n${sentenceText}\n\nWORD\nfront: strict\nback: 严格的`);
  assert.deepEqual(p.items.map((item) => item.expectedWordNumber), [138, null, 139]);
});

test('preview nextWordNumber advances only for importable Words', () => {
  assert.equal(preview(`${sentenceText}\n\n${wordText}`).nextWordNumber, 139);
});

test('existing Word is skipped', () => {
  assert.equal(preview('WORD\nfront: approach\nback: 新内容').items[0].status, 'existing');
});

test('Word duplicate comparison ignores case', () => {
  assert.equal(preview('WORD\nfront: Approach\nback: 新内容').items[0].status, 'existing');
});

test('Word duplicate comparison trims spaces', () => {
  assert.equal(preview('WORD\nfront:   approach  \nback: 新内容').items[0].status, 'existing');
});

test('duplicate Word inside one batch is marked separately', () => {
  const p = preview('WORD\nfront: newword\nback: 一\n\nWORD\nfront: NewWord\nback: 二');
  assert.deepEqual(p.items.map((item) => item.status), ['importable', 'batch-duplicate']);
});

test('existing Sentence uses exact trimmed front comparison', () => {
  assert.equal(preview('SENTENCE\nfront: Existing sentence.\nback: 新内容').items[0].status, 'existing');
  assert.equal(preview('SENTENCE\nfront: existing sentence.\nback: 新内容').items[0].status, 'importable');
});

test('duplicate Sentence inside one batch is skipped', () => {
  const p = preview(`${sentenceText}\n\n${sentenceText}`);
  assert.deepEqual(p.items.map((item) => item.status), ['importable', 'batch-duplicate']);
});

test('preview statistics separate existing cards from batch duplicates', () => {
  const p = preview(`WORD
front: approach
back: 已存在

SENTENCE
front: Existing sentence.
back: 已存在

WORD
front: newword
back: 新词

WORD
front: NewWord
back: 批次重复

WORD
back: 缺少英文`);
  assert.deepEqual(p.stats, { importable: 1, existing: 2, batchDuplicate: 1, error: 1 });
});

test('forms supports a single value', () => {
  assert.deepEqual(Batch.parseBatchText(wordText)[0].forms, ['expected']);
});

test('forms supports English commas', () => {
  assert.deepEqual(Batch.normalizeForms('expected, expecting'), ['expected', 'expecting']);
});

test('forms supports Chinese commas', () => {
  assert.deepEqual(Batch.normalizeForms('expected，expecting'), ['expected', 'expecting']);
});

test('forms removes duplicates and empty values', () => {
  assert.deepEqual(Batch.normalizeForms(' expected, ,expected，expecting '), ['expected', 'expecting']);
});

test('empty forms becomes an empty array', () => {
  assert.deepEqual(Batch.parseBatchText('WORD\nfront: expect\nback: 期待\nforms:')[0].forms, []);
});

test('Word missing front is an error', () => {
  assert.match(preview('WORD\nback: 期待').items[0].reason, /缺少 front/);
});

test('Word missing back is an error', () => {
  assert.match(preview('WORD\nfront: expect').items[0].reason, /缺少 back/);
});

test('Sentence missing front or back is an error', () => {
  assert.equal(preview('SENTENCE\nback: 中文').stats.error, 1);
  assert.equal(preview('SENTENCE\nfront: English').stats.error, 1);
});

test('unknown block type is an error', () => {
  assert.match(preview('ARTICLE\nfront: title\nback: 内容').items[0].reason, /未知 block 类型/);
});

test('unparseable block line is reported rather than ignored', () => {
  assert.match(preview('WORD\nthis is not a field\nfront: expect\nback: 期待').items[0].reason, /无法解析/);
});

test('unknown field is reported as an error', () => {
  assert.match(preview('WORD\nfront: expect\nback: 期待\nnote: no').items[0].reason, /未知字段/);
});

test('multiple blank lines are accepted', () => {
  assert.equal(preview(`\n\nWORD\n\nfront: expect\n\nback: 期待\n\n\n${sentenceText}\n`).items.length, 2);
});

test('Windows line endings are accepted', () => {
  assert.equal(Batch.parseBatchText(wordText.replace(/\n/g, '\r\n'))[0].front, 'expect');
});

test('preview does not mutate cards, meta, or review progress', () => {
  const data = baseData();
  const before = JSON.stringify(data);
  preview(wordText, data);
  assert.equal(JSON.stringify(data), before);
});

test('duplicate preview leaves original Word fields and progress untouched', () => {
  const data = baseData();
  const before = JSON.stringify(data.cards[0]);
  preview('WORD\nfront: APPROACH\nback: replacement\nmemoryReading: replacement', data);
  assert.equal(JSON.stringify(data.cards[0]), before);
});

test('only importable items are emitted for confirmation', () => {
  const p = preview(`WORD\nfront: approach\nback: duplicate\n\nWORD\nfront: valid\nback: 有效\n\nWORD\nfront:\nback: invalid`);
  assert.deepEqual(Batch.importableFields(p).map((item) => item.front), ['valid']);
});

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const FlashLogic = require('../public/logic.js');

async function storeHarness(t, mode, initial = baseData()) {
  let stored = JSON.stringify(initial);
  let fail = false;
  if (mode === 'PWA') {
    const window = { FlashLogic };
    vm.runInNewContext(source('pwa/store-local.js'), {
      window, navigator: {}, localStorage: {
        getItem: () => stored,
        setItem(_key, value) { if (fail) throw new Error('write failed'); stored = value; },
      },
    });
    return { store: window.FlashStore, read: () => JSON.parse(stored), fail: (value) => { fail = value; } };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashdesk-batch-test-'));
  const file = path.join(dir, 'flashdesk-data.json');
  fs.writeFileSync(file, stored);
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  vm.runInNewContext(source('server.js'), {
    __dirname: dir, URL, console: { log() {}, error() {} },
    require(name) {
      if (name === './seed.js') return [];
      if (name === './public/logic.js') return FlashLogic;
      if (name === 'node:fs') return { ...fs, renameSync(...args) {
        if (fail) throw new Error('write failed');
        return fs.renameSync(...args);
      } };
      if (name === 'node:http') return { createServer(handler) {
        server = http.createServer(handler);
        const listen = server.listen.bind(server);
        server.listen = (_port, callback) => listen(0, '127.0.0.1', callback);
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
  return { store: window.FlashStore, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), fail: (value) => { fail = value; } };
}

for (const mode of ['Node', 'PWA']) {
  test(`${mode} batch creates canonical Words and Sentences with one save`, async (t) => {
    const h = await storeHarness(t, mode);
    const result = await h.store.importBatch([
      { deck: 'Words', front: ' expect ', back: ' 期待 ', memoryReading: ' ex + pect ', chineseReading: '', forms: [' expected ', '', 'expected'] },
      { deck: 'Sentences', front: ' A new sentence. ', back: ' 一个新句子。 ' },
      { deck: 'Words', front: 'strict', back: '严格的', forms: [] },
    ]);
    assert.equal(result.addedWords, 2);
    assert.equal(result.addedSentences, 1);
    assert.deepEqual(plain(result.cards.map((card) => card.deck)), ['Words', 'Sentences', 'Words']);
    assert.deepEqual(plain(result.cards.filter((card) => card.deck === 'Words').map((card) => card.wordNumber)), [138, 139]);
    assert.equal(h.read().meta.nextWordNumber, 140);
    assert.equal(h.read().cards.at(-3).streak, 0);
    assert.equal(h.read().cards.at(-3).lapses, 0);
  });

  test(`${mode} Sentence-only batch does not consume nextWordNumber`, async (t) => {
    const h = await storeHarness(t, mode);
    await h.store.importBatch([{ deck: 'Sentences', front: 'New sentence.', back: '新句子。' }]);
    assert.equal(h.read().meta.nextWordNumber, 138);
  });

  test(`${mode} batch skips duplicates without changing original learning data`, async (t) => {
    const h = await storeHarness(t, mode);
    const before = JSON.stringify(h.read());
    const result = await h.store.importBatch([
      { deck: 'Words', front: ' APPROACH ', back: 'replacement', memoryReading: 'replacement', forms: [] },
      { deck: 'Sentences', front: 'Existing sentence.', back: 'replacement' },
    ]);
    assert.equal(result.skipped, 2);
    assert.equal(JSON.stringify(h.read()), before);
  });

  test(`${mode} failed batch save rolls back every card and the number counter`, async (t) => {
    const h = await storeHarness(t, mode);
    const before = JSON.stringify(h.read());
    h.fail(true);
    await assert.rejects(h.store.importBatch([
      { deck: 'Words', front: 'expect', back: '期待', forms: [] },
      { deck: 'Sentences', front: 'New sentence.', back: '新句子。' },
    ]), /write failed/);
    assert.equal(JSON.stringify(h.read()), before);
    h.fail(false);
    const retry = await h.store.importBatch([{ deck: 'Words', front: 'expect', back: '期待', forms: [] }]);
    assert.equal(retry.cards[0].wordNumber, 138);
  });
}

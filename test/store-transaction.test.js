const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const FlashLogic = require('../public/logic.js');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const initialData = () => ({
  cards: [{
    id: 'original', deck: 'Words', wordNumber: 1, front: 'original', back: '原卡',
    memoryReading: '', chineseReading: '', forms: [], due: 1900000000000,
    streak: 0, lapses: 0, created: 1700000000000,
  }],
  history: [],
  meta: { nextWordNumber: 2 },
});

async function harness(t, mode) {
  let failWrites = false;
  let stored = JSON.stringify(initialData());
  if (mode === 'PWA') {
    const window = { FlashLogic };
    vm.runInNewContext(source('pwa/store-local.js'), {
      window, navigator: {},
      localStorage: {
        getItem: () => stored,
        setItem(_key, value) {
          if (failWrites) throw new Error('persist failed');
          stored = value;
        },
      },
    });
    return {
      store: window.FlashStore,
      persisted: () => JSON.parse(stored),
      fail(value) { failWrites = value; },
    };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashdesk-transaction-test-'));
  const dataFile = path.join(dir, 'flashdesk-data.json');
  fs.writeFileSync(dataFile, stored);
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  vm.runInNewContext(source('server.js'), {
    __dirname: dir, URL, console: { log() {}, error() {} },
    require(name) {
      if (name === './seed.js') return [];
      if (name === './server-config.js') return require('../server-config.js');
      if (name === './public/logic.js') return FlashLogic;
      if (name === './public/song-learning.js') return require('../public/song-learning.js');
      if (name === 'node:os') return { homedir: () => dir };
      if (name === 'node:fs') return {
        ...fs,
        renameSync(...args) {
          if (failWrites) throw new Error('persist failed');
          return fs.renameSync(...args);
        },
      };
      if (name === 'node:http') return {
        createServer(handler) {
          server = http.createServer(handler);
          const listen = server.listen.bind(server);
          server.listen = (_port, _host, callback) => listen(0, '127.0.0.1', callback);
          return server;
        },
      };
      return require(name);
    },
  });
  if (!server.listening) await once(server, 'listening');
  const window = {};
  vm.runInNewContext(source('public/store.js'), {
    window,
    fetch: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, options),
  });
  return {
    store: window.FlashStore,
    persisted: () => JSON.parse(fs.readFileSync(dataFile, 'utf8')),
    fail(value) { failWrites = value; },
  };
}

async function assertMemoryAndDisk(h, expected) {
  assert.deepEqual(plain(await h.store.exportSnapshot()), expected);
  assert.deepEqual(h.persisted(), expected);
}

for (const mode of ['PWA', 'Node']) {
  test(`${mode} failed grade is not committed by a later successful add`, async (t) => {
    const h = await harness(t, mode);
    const before = initialData();
    h.fail(true);
    await assert.rejects(h.store.gradeCard('original', 'got'), /persist failed/);
    await assertMemoryAndDisk(h, before);

    h.fail(false);
    await h.store.addCard({ deck: 'Words', front: 'later', back: '后来', forms: [] });
    const state = plain(await h.store.exportSnapshot());
    assert.equal(state.cards[0].streak, 0);
    assert.equal(state.cards[0].due, before.cards[0].due);
    assert.equal(h.persisted().cards[0].streak, 0);
    assert.equal(state.cards.at(-1).front, 'later');
  });

  test(`${mode} failed delete keeps the card through the next successful mutation`, async (t) => {
    const h = await harness(t, mode);
    const before = initialData();
    h.fail(true);
    await assert.rejects(h.store.deleteCard('original'), /persist failed/);
    await assertMemoryAndDisk(h, before);

    h.fail(false);
    await h.store.addCard({ deck: 'Sentences', front: 'A later sentence.', back: '后来的句子。' });
    assert.ok((await h.store.exportSnapshot()).cards.some((card) => card.id === 'original'));
    assert.ok(h.persisted().cards.some((card) => card.id === 'original'));
  });

  test(`${mode} failed session history is not committed later`, async (t) => {
    const h = await harness(t, mode);
    const before = initialData();
    h.fail(true);
    await assert.rejects(h.store.logSession({ deck: 'Words', reviewed: 1, correct: 1 }), /persist failed/);
    await assertMemoryAndDisk(h, before);

    h.fail(false);
    await h.store.addCard({ deck: 'Sentences', front: 'Another sentence.', back: '另一个句子。' });
    assert.deepEqual(plain((await h.store.exportSnapshot()).history), []);
    assert.deepEqual(h.persisted().history, []);
  });

  test(`${mode} failed quiz mutation does not make missed cards due later`, async (t) => {
    const h = await harness(t, mode);
    const before = initialData();
    h.fail(true);
    await assert.rejects(h.store.logQuiz({ deck: 'Words', questions: 1, correct: 0, missedIds: ['original'] }), /persist failed/);
    await assertMemoryAndDisk(h, before);

    h.fail(false);
    await h.store.addCard({ deck: 'Sentences', front: 'Successful mutation.', back: '成功操作。' });
    assert.equal((await h.store.exportSnapshot()).cards[0].due, before.cards[0].due);
    assert.equal(h.persisted().cards[0].due, before.cards[0].due);
  });
}


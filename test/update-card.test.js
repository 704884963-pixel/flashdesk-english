const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const original = {
  id: 'c_existing', front: 'approach', back: '方法', deck: 'Words',
  due: 1900000000000, streak: 4, lapses: 3, created: 1700000000000,
};
const fixture = () => ({ cards: [{ ...original }], history: [] });
const invalidFields = [
  { front: '', back: 'valid' },
  { front: ' \n ', back: 'valid' },
  { front: 'valid', back: '' },
  { front: 'valid', back: ' \t ' },
  { front: 123, back: 'valid' },
  { front: 'valid', back: null },
  { back: 'valid' },
  { front: 'valid' },
];
const injectedFields = {
  front: '  updated approach  ', back: '  更新后的备注  ',
  id: 'replacement', deck: 'Sentences', due: 0, streak: 0, lapses: 0, created: 0,
};
const expected = { ...original, front: 'updated approach', back: '更新后的备注' };

async function nodeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashdesk-update-test-'));
  const dataFile = path.join(dir, 'flashdesk-data.json');
  fs.writeFileSync(dataFile, JSON.stringify(fixture()));
  let server;
  t.after(async () => {
    if (server && server.listening) {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    // Only remove this harness's freshly created temporary directory.
    fs.rmSync(dir, { recursive: true, force: true });
  });
  vm.runInNewContext(source('server.js'), {
    __dirname: dir,
    URL,
    console: { log() {}, error() {} },
    require(name) {
      if (name === './seed.js') return require('../seed.js');
      if (name === 'node:http') {
        return {
          createServer(handler) {
            server = http.createServer(handler);
            const listen = server.listen.bind(server);
            // Execute the real handler on an isolated ephemeral loopback port.
            server.listen = (_port, callback) => listen(0, '127.0.0.1', callback);
            return server;
          },
        };
      }
      return require(name);
    },
  }, { filename: 'server.js' });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    read: () => JSON.parse(fs.readFileSync(dataFile, 'utf8')),
    async patch(id, fields) {
      const response = await fetch(`${base}/api/cards/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function pwaHarness() {
  let stored = JSON.stringify(fixture());
  let fail = false;
  const window = {};
  vm.runInNewContext(source('pwa/store-local.js'), {
    window, navigator: {},
    localStorage: {
      getItem: () => stored,
      setItem(_key, value) {
        if (fail) throw new Error('quota exceeded');
        stored = value;
      },
    },
  });
  return {
    store: window.FlashStore,
    read: () => JSON.parse(stored),
    failWrites: (value) => { fail = value; },
  };
}

test('Node PATCH trims content, persists it and ignores all protected fields', async (t) => {
  const h = await nodeHarness(t);
  const result = await h.patch(original.id, injectedFields);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { card: expected });
  assert.deepEqual(h.read(), { cards: [expected], history: [] });
  const loaded = await (await fetch(`${h.base}/api/cards`)).json();
  assert.deepEqual(loaded.cards, [expected]);
});

test('Node PATCH rejects empty/non-string content and missing IDs without changing data', async (t) => {
  const h = await nodeHarness(t);
  for (const fields of [...invalidFields, null]) {
    const result = await h.patch(original.id, fields);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'front and back must be non-empty strings');
  }
  const missing = await h.patch('missing', { front: 'new', back: 'new' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'card not found');
  assert.deepEqual(h.read(), fixture());
  assert.deepEqual(await (await fetch(`${h.base}/api/cards`)).json(), fixture());
});

test('Node FlashStore updateCard uses PATCH, sends only content and returns the full card', async (t) => {
  const h = await nodeHarness(t);
  const window = {};
  let request;
  vm.runInNewContext(source('public/store.js'), {
    window,
    fetch(url, options) {
      request = { url, options };
      return fetch(h.base + url, options);
    },
  });
  const result = await window.FlashStore.updateCard(original.id, injectedFields);
  assert.deepEqual(plain(result), { card: expected });
  assert.equal(request.url, `/api/cards/${original.id}`);
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), {
    front: injectedFields.front, back: injectedFields.back,
  });
  await assert.rejects(window.FlashStore.updateCard('missing', { front: 'x', back: 'y' }), /card not found/);
  await assert.rejects(window.FlashStore.updateCard(original.id, { front: '', back: 'y' }), /non-empty strings/);
});

test('PWA updateCard trims content, preserves protected fields and returns a clone', async () => {
  const h = pwaHarness();
  const result = await h.store.updateCard(original.id, injectedFields);
  assert.deepEqual(plain(result), { card: expected });
  assert.deepEqual(h.read(), { cards: [expected], history: [] });
  result.card.front = 'mutated response';
  result.card.streak = 99;
  assert.deepEqual(plain(await h.store.load()), { cards: [expected], history: [] });
});

test('PWA updateCard rejects empty/non-string content and missing IDs without changing data', async () => {
  const h = pwaHarness();
  for (const fields of invalidFields) {
    await assert.rejects(h.store.updateCard(original.id, fields), /front and back must be non-empty strings/);
  }
  await assert.rejects(h.store.updateCard('missing', { front: 'new', back: 'new' }), /card not found/);
  assert.deepEqual(h.read(), fixture());
  assert.deepEqual(plain(await h.store.load()), fixture());
});

test('PWA updateCard rolls back both content fields on persistence failure and can retry', async () => {
  const h = pwaHarness();
  h.failWrites(true);
  await assert.rejects(h.store.updateCard(original.id, injectedFields), /quota exceeded/);
  assert.deepEqual(h.read(), fixture());
  assert.deepEqual(plain(await h.store.load()), fixture());
  h.failWrites(false);
  assert.deepEqual(plain(await h.store.updateCard(original.id, injectedFields)), { card: expected });
});

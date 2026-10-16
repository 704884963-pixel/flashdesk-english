const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FlashLogic = require('../public/logic.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'store-local.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const initialData = () => ({
  cards: [{
    id: 'x', deck: 'Words', wordNumber: 1, front: 'X', back: 'X',
    memoryReading: '', chineseReading: '', forms: [], due: 1,
    streak: 0, lapses: 0, created: 1,
  }],
  history: [],
  meta: { nextWordNumber: 2 },
});

function sharedEnvironment({ locks = true, storageEvents = true } = {}) {
  let raw = JSON.stringify(initialData());
  const clients = [];
  let lockTail = Promise.resolve();
  let activeLocks = 0;
  let maxActiveLocks = 0;

  const lockManager = {
    request(_name, callback) {
      const run = lockTail.then(async () => {
        activeLocks += 1;
        maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
        try { return await callback(); } finally { activeLocks -= 1; }
      });
      lockTail = run.catch(() => {});
      return run;
    },
  };

  function createStore() {
    const listeners = new Map();
    const window = {
      FlashLogic,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
    };
    const client = { window, listeners };
    clients.push(client);
    const localStorage = {
      getItem(key) { return key === 'flashdesk-data' ? raw : null; },
      setItem(key, value) {
        if (key !== 'flashdesk-data') return;
        const oldValue = raw;
        raw = value;
        if (!storageEvents) return;
        for (const other of clients) {
          if (other === client) continue;
          for (const callback of other.listeners.get('storage') || []) {
            callback({ key, oldValue, newValue: value });
          }
        }
      },
    };
    vm.runInNewContext(source, {
      window,
      navigator: locks ? { locks: lockManager } : {},
      localStorage,
    });
    return window.FlashStore;
  }

  function writeExternal(next) {
    const oldValue = raw;
    raw = JSON.stringify(next);
    if (!storageEvents) return;
    for (const client of clients) {
      for (const callback of client.listeners.get('storage') || []) {
        callback({ key: 'flashdesk-data', oldValue, newValue: raw });
      }
    }
  }

  return {
    createStore,
    read: () => JSON.parse(raw),
    writeExternal,
    maxActiveLocks: () => maxActiveLocks,
  };
}

async function expectConflict(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'STORE_CONFLICT');
    assert.match(error.message, /另一个窗口更新/);
    return true;
  });
}

test('A grade succeeds, stale B add conflicts, and a reloaded B can add safely', async () => {
  const env = sharedEnvironment({ storageEvents: false });
  const a = env.createStore();
  const b = env.createStore();
  await Promise.all([a.load(), b.load()]);

  await a.gradeCard('x', 'got');
  await expectConflict(b.addCard({ deck: 'Words', front: 'Y', back: 'Y' }));
  assert.equal(env.read().cards.find((card) => card.id === 'x').streak, 1);
  assert.equal(env.read().cards.some((card) => card.front === 'Y'), false);
  assert.equal((await b.exportSnapshot()).cards.some((card) => card.front === 'Y'), false);

  const reloadedB = env.createStore();
  await reloadedB.load();
  await reloadedB.addCard({ deck: 'Words', front: 'Y', back: 'Y' });
  assert.equal(env.read().cards.find((card) => card.id === 'x').streak, 1);
  assert.equal(env.read().cards.some((card) => card.front === 'Y'), true);
});

test('A add followed by stale B delete preserves both A change and X', async () => {
  const env = sharedEnvironment({ storageEvents: false });
  const a = env.createStore();
  const b = env.createStore();
  await Promise.all([a.load(), b.load()]);
  await a.addCard({ deck: 'Words', front: 'A1', back: 'A1' });
  await expectConflict(b.deleteCard('x'));
  assert.equal(env.read().cards.some((card) => card.front === 'A1'), true);
  assert.equal(env.read().cards.some((card) => card.id === 'x'), true);
});

test('one tab can continuously grade, add, delete, log a session, and log a quiz', async () => {
  const env = sharedEnvironment();
  const store = env.createStore();
  await store.load();
  await store.gradeCard('x', 'got');
  const added = await store.addCard({ deck: 'Words', front: 'temporary', back: '临时' });
  await store.deleteCard(added.card.id);
  await store.logSession({ deck: 'Words', reviewed: 1, correct: 1 });
  await store.logQuiz({ missedIds: ['x'] });
  const persisted = env.read();
  assert.equal(persisted.cards.find((card) => card.id === 'x').streak, 1);
  assert.equal(persisted.cards.some((card) => card.front === 'temporary'), false);
  assert.equal(persisted.history.length, 1);
});

test('nearly simultaneous mutations serialize under Web Locks and only one commits', async () => {
  const env = sharedEnvironment({ storageEvents: false });
  const a = env.createStore();
  const b = env.createStore();
  await Promise.all([a.load(), b.load()]);
  const results = await Promise.allSettled([
    a.addCard({ deck: 'Words', front: 'from-a', back: 'A' }),
    b.addCard({ deck: 'Words', front: 'from-b', back: 'B' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'STORE_CONFLICT');
  assert.equal(env.read().cards.length, 2);
  assert.equal(env.maxActiveLocks(), 1);
});

test('storage events mark the store stale without clearing memory or reloading', async () => {
  const env = sharedEnvironment();
  const store = env.createStore();
  await store.load();
  const external = initialData();
  external.cards[0].streak = 4;
  env.writeExternal(external);
  assert.equal(store.hasExternalChange(), true);
  assert.equal((await store.exportSnapshot()).cards[0].streak, 0);
  await expectConflict(store.addCard({ deck: 'Words', front: 'Y', back: 'Y' }));
  assert.equal(env.read().cards[0].streak, 4);
});

test('every PWA learning-data mutation entry rejects a stale persisted baseline', async () => {
  const operations = [
    (store) => store.replaceSnapshot(initialData()),
    (store) => store.addCard({ deck: 'Words', front: 'Y', back: 'Y' }),
    (store) => store.importBatch([{ deck: 'Sentences', front: 'A sentence.', back: '一句话。' }]),
    (store) => store.updateCard('x', { front: 'X2', back: 'X2' }),
    (store) => store.gradeCard('x', 'got'),
    (store) => store.deleteCard('x'),
    (store) => store.logSession({ deck: 'Words', reviewed: 1, correct: 1 }),
    (store) => store.logQuiz({ missedIds: ['x'] }),
    (store) => store.importData(JSON.stringify([{ deck: 'Words', front: 'Y', back: 'Y' }])),
    (store) => store.importData(JSON.stringify(initialData())),
  ];
  for (const operation of operations) {
    const env = sharedEnvironment({ storageEvents: false });
    const a = env.createStore();
    const b = env.createStore();
    await Promise.all([a.load(), b.load()]);
    await a.addCard({ deck: 'Words', front: 'A1', back: 'A1' });
    await expectConflict(operation(b));
    assert.equal(env.read().cards.some((card) => card.front === 'A1'), true);
  }
});

test('fallback without Web Locks detects an already-stale page but is not advertised as atomic', async () => {
  const env = sharedEnvironment({ locks: false, storageEvents: false });
  const a = env.createStore();
  const b = env.createStore();
  await Promise.all([a.load(), b.load()]);
  await a.gradeCard('x', 'got');
  await expectConflict(b.addCard({ deck: 'Words', front: 'Y', back: 'Y' }));
  assert.equal(env.read().cards[0].streak, 1);
  assert.match(source, /without Web Locks[\s\S]*atomic cross-tab compare-and-set operation/);
});

test('the UI maps STORE_CONFLICT to one clear refresh message', () => {
  assert.match(appSource, /function learningStoreErrorMessage\([\s\S]*?STORE_CONFLICT[\s\S]*?STORE_CONFLICT_MESSAGE/);
  assert.match(appSource, /学习数据已在另一个窗口更新。请刷新当前页面后继续/);
  assert.match(appSource, /const summary = await FlashStore\.importData\(text\)/);
});

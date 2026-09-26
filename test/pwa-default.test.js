const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const defaults = JSON.parse(source('pwa/default-data.json'));

function harness(initialRaw) {
  let stored = initialRaw;
  let writes = 0;
  let fetches = 0;
  const window = {};
  vm.runInNewContext(source('pwa/store-local.js'), {
    window,
    navigator: {},
    localStorage: {
      getItem: () => stored === undefined ? null : stored,
      setItem(_key, value) { stored = value; writes += 1; },
    },
    async fetch(url) {
      fetches += 1;
      assert.equal(url, 'default-data.json');
      return { ok: true, status: 200, json: async () => plain(defaults) };
    },
  });
  return {
    store: window.FlashStore,
    read: () => stored === undefined ? null : JSON.parse(stored),
    writes: () => writes,
    fetches: () => fetches,
  };
}

test('PWA with no localStorage key initializes all 137 Words once', async () => {
  const h = harness();
  const loaded = plain(await h.store.load());
  assert.equal(loaded.cards.length, 137);
  assert.equal(loaded.cards.every((card) => card.deck === 'Words'), true);
  assert.equal(loaded.meta.nextWordNumber, 138);
  assert.equal(h.fetches(), 1);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.read(), defaults);
});

test('PWA reload preserves an existing customized dataset without fetching defaults', async () => {
  const existing = plain(defaults);
  existing.cards.push({
    id: 'custom', deck: 'Words', wordNumber: 138, front: 'custom', back: '自定义',
    memoryReading: 'custom', chineseReading: '卡斯腾', forms: ['customized'],
    due: 987654321, streak: 4, lapses: 2, created: 123456789,
  });
  existing.history.push({ date: '2026-09-27', deck: 'Words', reviewed: 3, correct: 2 });
  existing.meta.nextWordNumber = 139;
  const raw = JSON.stringify(existing);
  const h = harness(raw);
  assert.deepEqual(plain(await h.store.load()), existing);
  assert.equal(h.fetches(), 0);
  assert.equal(h.writes(), 0);
  assert.equal(JSON.stringify(h.read()), raw);
});

test('PWA preserves an explicitly empty existing dataset', async () => {
  const existing = { cards: [], history: [] };
  const h = harness(JSON.stringify(existing));
  assert.deepEqual(plain(await h.store.load()), existing);
  assert.equal(h.fetches(), 0);
  assert.equal(h.writes(), 0);
});

test('PWA preserves legacy front/back Words instead of treating them as first run', async () => {
  const legacy = {
    cards: [{ id: 'old', deck: 'Words', front: 'legacy', back: '旧卡', due: 10, streak: 2, lapses: 1, created: 5 }],
    history: [{ date: '2026-01-01', deck: 'Words', reviewed: 1, correct: 1 }],
  };
  const h = harness(JSON.stringify(legacy));
  const loaded = plain(await h.store.load());
  assert.deepEqual(loaded.cards[0], {
    ...legacy.cards[0], wordNumber: null, memoryReading: '', chineseReading: '', forms: [],
  });
  assert.deepEqual(h.read(), legacy);
  assert.equal(h.fetches(), 0);
  assert.equal(h.writes(), 0);
});

test('PWA full export/import preserves schema, Word details, progress, history and meta', async () => {
  const sourceDevice = harness();
  await sourceDevice.store.load();
  const first = defaults.cards[0];
  await sourceDevice.store.gradeCard(first.id, 'got');
  await sourceDevice.store.logSession({ deck: 'Words', reviewed: 1, correct: 1 });
  const added = await sourceDevice.store.addCard({
    deck: 'Words', front: 'portable', back: '可迁移', memoryReading: 'port + able',
    chineseReading: '波特额波', forms: ['ported'],
  });
  assert.equal(added.card.wordNumber, 138);
  const exported = sourceDevice.store.exportData();

  const targetDevice = harness();
  await targetDevice.store.load();
  targetDevice.store.importData(exported);
  assert.deepEqual(JSON.parse(targetDevice.store.exportData()), JSON.parse(exported));
  const restored = plain(await targetDevice.store.load());
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.meta.nextWordNumber, 139);
  assert.equal(restored.history.length, 1);
  const restoredFirst = restored.cards.find((card) => card.id === first.id);
  assert.equal(restoredFirst.streak, 1);
  assert.equal(restoredFirst.lapses, 0);
  assert.ok(restoredFirst.due > 0);
  const restoredAdded = restored.cards.find((card) => card.id === added.card.id);
  assert.deepEqual(restoredAdded.forms, ['ported']);
  assert.equal(restoredAdded.memoryReading, 'port + able');
  assert.equal(restoredAdded.chineseReading, '波特额波');
});

test('default-data exactly covers authority #1-#137 with unique English', () => {
  const first = JSON.parse(source('import/english-words-1-131.json')).cards;
  const last = source('import/英语词汇总表_132-137.md')
    .split(/\r?\n/)
    .filter((line) => /^\|\s*13[2-7]\s*\|/.test(line))
    .map((line) => {
      const [number, front, memoryReading, chineseReading, back, forms] = line
        .slice(1, -1).split('|').map((value) => value.trim());
      return { deck: 'Words', wordNumber: Number(number), front, memoryReading,
        chineseReading, back, forms: JSON.parse(forms) };
    });
  const authority = [...first, ...last];
  assert.equal(defaults.schemaVersion, 2);
  assert.equal(defaults.cards.length, 137);
  assert.equal(defaults.meta.nextWordNumber, 138);
  assert.deepEqual(defaults.history, []);
  assert.deepEqual(defaults.cards.map((card) => card.wordNumber), Array.from({ length: 137 }, (_, i) => i + 1));
  assert.equal(new Set(defaults.cards.map((card) => card.front.trim().toLowerCase())).size, 137);
  assert.equal(new Set(defaults.cards.map((card) => card.id)).size, 137);
  for (let i = 0; i < authority.length; i += 1) {
    const actual = defaults.cards[i];
    const expected = authority[i];
    for (const key of ['deck', 'wordNumber', 'front', 'back', 'memoryReading', 'chineseReading', 'forms']) {
      assert.deepEqual(actual[key], expected[key]);
    }
    assert.equal(Number.isFinite(actual.due), true);
    assert.equal(Number.isFinite(actual.created), true);
    assert.equal(actual.streak, 0);
    assert.equal(actual.lapses, 0);
  }
});

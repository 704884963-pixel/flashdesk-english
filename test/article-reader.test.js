const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');

const Utils = require('../public/article-utils.js');
const { createArticleStore } = require('../pwa/article-store-idb.js');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const appSource = source('public/app.js');

const sample = {
  title: 'AI Is Changing Work', source: 'Reuters', sourceUrl: 'https://example.com/story',
  publishedAt: '2026-09-27', content: 'Mr. Smith trains models.\n\nDo they work? Yes!',
};

test('Article input normalizes the canonical editable fields', () => {
  assert.deepEqual(Utils.normalizeArticleInput({ ...sample, title: '  Title  ' }), { ...sample, title: 'Title' });
});
test('Article title is required', () => assert.throws(() => Utils.normalizeArticleInput({ content: 'text' }), /标题/));
test('Article content is required', () => assert.throws(() => Utils.normalizeArticleInput({ title: 'title' }), /正文/));
test('Article source may be empty', () => assert.equal(Utils.normalizeArticleInput({ title: 't', content: 'c' }).source, ''));
test('Article accepts an http source URL', () => assert.equal(Utils.normalizeArticleInput({ title: 't', content: 'c', sourceUrl: 'http://example.com' }).sourceUrl, 'http://example.com'));
test('Article accepts an https source URL', () => assert.equal(Utils.normalizeArticleInput(sample).sourceUrl, sample.sourceUrl));
test('Article rejects a non-http source URL', () => assert.throws(() => Utils.normalizeArticleInput({ title: 't', content: 'c', sourceUrl: 'file:///tmp/a' }), /http/));
test('Windows newlines normalize without flattening paragraphs', () => assert.equal(Utils.normalizeContent(' A\r\n\r\nB '), 'A\n\nB'));
test('paragraph splitting preserves blank-line boundaries', () => assert.deepEqual(Utils.splitParagraphs('One.\n\nTwo.\n\n\nThree.'), ['One.', 'Two.', 'Three.']));
test('sentence splitting returns ordinary statements', () => assert.deepEqual(Utils.splitSentences('One. Two.'), ['One.', 'Two.']));
test('sentence splitting handles questions', () => assert.deepEqual(Utils.splitSentences('Ready? Go.'), ['Ready?', 'Go.']));
test('sentence splitting handles exclamations', () => assert.deepEqual(Utils.splitSentences('Stop! Go.'), ['Stop!', 'Go.']));
test('fallback sentence splitting protects common abbreviations', () => assert.deepEqual(Utils.splitSentences('Mr. Smith met Dr. Jones. They left.', null), ['Mr. Smith met Dr. Jones.', 'They left.']));
test('Intl sentence splitting also merges a standalone common abbreviation', () => assert.deepEqual(Utils.splitSentences('Mr. Smith left. Dr. Jones stayed.'), ['Mr. Smith left.', 'Dr. Jones stayed.']));
test('fallback sentence splitting protects U.S. and decimals', () => assert.deepEqual(Utils.splitSentences('U.S. growth was 2.5%. It rose.', null), ['U.S. growth was 2.5%.', 'It rose.']));
test('word tokenization ignores punctuation and numbers', () => assert.deepEqual(Utils.wordTokens('Model, 123 training!').map((t) => t.text), ['Model', 'training']));
test("word tokenization keeps don't together", () => assert.deepEqual(Utils.wordTokens("don't stop").map((t) => t.text), ["don't", 'stop']));
test('word tokenization keeps AI-powered together', () => assert.deepEqual(Utils.wordTokens('AI-powered model').map((t) => t.text), ['AI-powered', 'model']));
test('coverage is zero with no learned Words', () => assert.equal(Utils.articleCoverage('one two', []).percent, 0));
test('coverage is 100 percent when every token is learned', () => assert.equal(Utils.articleCoverage('One one', [{ deck: 'Words', front: 'one', forms: [] }]).percent, 100));
test('coverage measures token matches rather than unique matches', () => {
  const result = Utils.articleCoverage('one one two', [{ deck: 'Words', front: 'one', forms: [] }]);
  assert.deepEqual(result, { total: 3, matched: 2, percent: 67 });
});
test('Word front enters the learned lookup', () => assert.equal(Utils.buildWordLookup([{ deck: 'Words', front: 'expect' }]).get('expect').front, 'expect'));
test('Word forms enter the learned lookup', () => assert.equal(Utils.buildWordLookup([{ deck: 'Words', front: 'expect', forms: ['expected'] }]).get('expected').front, 'expect'));
test('learned lookup matching ignores case', () => assert.equal(Utils.articleCoverage('EXPECTED', [{ deck: 'Words', front: 'expect', forms: ['expected'] }]).percent, 100));
test('punctuation does not affect a learned match', () => assert.equal(Utils.articleCoverage('(expect),', [{ deck: 'Words', front: 'expect' }]).percent, 100));
test('Sentence duplicate uses exact trimmed front comparison', () => {
  const cards = [{ deck: 'Sentences', front: ' A sentence. ' }];
  assert.equal(Utils.sentenceExists(cards, 'A sentence.'), true);
  assert.equal(Utils.sentenceExists(cards, 'a sentence.'), false);
});
test('unlearned Word action only prefills the existing Add form', () => {
  assert.match(appSource, /prefillArticleCard\('Words'/);
  assert.doesNotMatch(appSource, /data-article-add-word[^\n]+FlashStore\.addCard/);
});
test('Sentence action only prefills the existing Add form', () => assert.match(appSource, /prefillArticleCard\('Sentences'/));
test('progress defaults invalid values to zero', () => assert.deepEqual(Utils.normalizeProgress(undefined, undefined), { progressSentenceIndex: 0, progressPercent: 0 }));
test('progress accepts an intermediate position', () => assert.deepEqual(Utils.normalizeProgress(4, 42), { progressSentenceIndex: 4, progressPercent: 42 }));
test('progress clamps to 100 percent', () => assert.deepEqual(Utils.normalizeProgress(99, 140), { progressSentenceIndex: 99, progressPercent: 100 }));
test('Article analysis retains paragraphs and global sentence indexes', () => {
  const result = Utils.analyzeArticle('One. Two.\n\nThree.');
  assert.equal(result.paragraphs.length, 2);
  assert.deepEqual(result.paragraphs.flatMap((p) => p.sentences.map((s) => s.index)), [0, 1, 2]);
});
test('10,000-word Article segmentation completes without loss or overflow', () => {
  const content = Array.from({ length: 1000 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(10)}ends.`).join('\n\n');
  const result = Utils.analyzeArticle(content);
  assert.equal(result.paragraphs.length, 1000);
  assert.equal(result.sentenceCount, 1000);
  assert.ok(result.wordCount >= 11000);
});
test('coverage recomputes after a Word is added', () => {
  const before = Utils.articleCoverage('regulation matters', []);
  const after = Utils.articleCoverage('regulation matters', [{ deck: 'Words', front: 'regulation' }]);
  assert.equal(before.percent, 0);
  assert.equal(after.percent, 50);
});
test('reader TTS reuses the existing playEnglish function', () => assert.match(appSource, /playEnglish\(button\.dataset\.articleSpeak/));
test('Article sentences render without a visible sentence-end marker', () => {
  const renderSource = appSource.slice(appSource.indexOf('function articleSentenceHtml'), appSource.indexOf('function renderArticleReader'));
  assert.doesNotMatch(renderSource, /article-sentence-action|data-article-sentence|>句</);
});
test('Article sentence text remains the clickable Sentence target', () => {
  assert.match(appSource, /class="article-sentence" data-sentence-index/);
  assert.match(appSource, /const sentence = e\.target\.closest\('\[data-sentence-index\]'\)/);
  assert.match(appSource, /openArticleSentence\(sentence\.dataset\.sentenceText\)/);
});
test('Article Word click is handled before Sentence click and stops propagation', () => {
  const handlerSource = appSource.slice(appSource.indexOf("$('#article-root').addEventListener('click'"), appSource.indexOf("$('#article-action-close')"));
  assert.ok(handlerSource.indexOf("closest('[data-article-word]')") < handlerSource.indexOf("closest('[data-sentence-index]')"));
  assert.match(handlerSource, /word[\s\S]*?stopPropagation\(\)[\s\S]*?return/);
});
test('Article Word and Sentence pronunciation both route through playEnglish', () => {
  const actionSource = appSource.slice(appSource.indexOf("$('#article-action-content').addEventListener('click'"), appSource.indexOf("$('#add-form').addEventListener('submit'"));
  assert.match(actionSource, /playEnglish\(button\.dataset\.articleSpeak/);
  assert.doesNotMatch(actionSource, /speechSynthesis|speakEnglish/);
  assert.match(appSource, /function openArticleWord[\s\S]*?data-article-speak/);
  assert.match(appSource, /function openArticleSentence[\s\S]*?data-article-speak/);
});
test('Article progress is throttled rather than saved for every observer event', () => assert.match(appSource, /setTimeout\(flushArticleProgress, 1500\)/));

function fakeIndexedDb({ legacyArticles = false } = {}) {
  const databases = new Map();
  if (legacyArticles) databases.set('flashdesk-content', { stores: new Map([['articles', new Map()]]), version: 1 });
  let failWrites = false;
  const asyncEvent = (fn) => setTimeout(fn, 0);
  function request(transaction, operation, write = false) {
    const req = {};
    transaction.pending += 1;
    asyncEvent(() => {
      if (write && failWrites) {
        req.error = new Error('write failed');
        req.onerror?.();
        transaction.fail(req.error);
        return;
      }
      try { req.result = operation(); req.onsuccess?.(); transaction.finish(); }
      catch (err) { req.error = err; req.onerror?.(); transaction.fail(err); }
    });
    return req;
  }
  function transaction(storeMap) {
    const tx = {
      pending: 0, completed: false, error: null,
      objectStore: () => ({
        getAll: () => request(tx, () => [...storeMap.values()].map((v) => structuredClone(v))),
        get: (id) => request(tx, () => storeMap.has(id) ? structuredClone(storeMap.get(id)) : undefined),
        add: (value) => request(tx, () => { if (storeMap.has(value.id)) throw new Error('duplicate'); storeMap.set(value.id, structuredClone(value)); }, true),
        put: (value) => request(tx, () => storeMap.set(value.id, structuredClone(value)), true),
        delete: (id) => request(tx, () => storeMap.delete(id), true),
      }),
      finish() { this.pending -= 1; if (!this.pending && !this.completed) { this.completed = true; asyncEvent(() => this.oncomplete?.()); } },
      fail(err) { this.error = err; this.completed = true; asyncEvent(() => { this.onerror?.(); this.onabort?.(); }); },
      abort() { this.fail(new Error('aborted')); },
    };
    return tx;
  }
  return {
    setFail(value) { failWrites = value; },
    open(name, version = 1) {
      const req = {};
      asyncEvent(() => {
        let record = databases.get(name);
        const fresh = !record;
        if (!record) { record = { stores: new Map(), version: 0 }; databases.set(name, record); }
        req.result = {
          objectStoreNames: { contains: (store) => record.stores.has(store) },
          createObjectStore(store) { record.stores.set(store, new Map()); },
          transaction(store) { return transaction(record.stores.get(store)); },
        };
        if (fresh || version > record.version) {
          req.onupgradeneeded?.();
          record.version = version;
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('PWA ArticleStore creates and lists a canonical Article', async () => {
  const store = createArticleStore(fakeIndexedDb(), Utils);
  const article = await store.create(sample);
  assert.equal(article.title, sample.title);
  assert.equal(article.progressPercent, 0);
  assert.equal((await store.list()).length, 1);
});
test('PWA ArticleStore gets one Article', async () => {
  const store = createArticleStore(fakeIndexedDb(), Utils);
  const created = await store.create(sample);
  assert.equal((await store.get(created.id)).content, sample.content);
});
test('PWA ArticleStore updates progress and lastReadAt', async () => {
  const store = createArticleStore(fakeIndexedDb(), Utils);
  const created = await store.create(sample);
  const updated = await store.updateProgress(created.id, { progressSentenceIndex: 2, progressPercent: 80 });
  assert.equal(updated.progressSentenceIndex, 2);
  assert.equal(updated.progressPercent, 80);
  assert.ok(updated.lastReadAt);
});
test('PWA ArticleStore deletes only the requested Article', async () => {
  const store = createArticleStore(fakeIndexedDb(), Utils);
  const first = await store.create(sample);
  await store.create({ ...sample, title: 'Second' });
  await store.delete(first.id);
  assert.deepEqual((await store.list()).map((a) => a.title), ['Second']);
});
test('PWA Article save failure leaves no partial Article', async () => {
  const idb = fakeIndexedDb();
  const store = createArticleStore(idb, Utils);
  idb.setFail(true);
  await assert.rejects(store.create(sample), /write failed|保存失败/);
  idb.setFail(false);
  assert.equal((await store.list()).length, 0);
});

async function nodeArticleHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashdesk-article-test-'));
  const cardData = { cards: [{ id: 'word', deck: 'Words', front: 'expect', back: '期待', due: 1, streak: 2, lapses: 1, created: 1 }], history: [], meta: { nextWordNumber: 138 } };
  fs.writeFileSync(path.join(dir, 'flashdesk-data.json'), JSON.stringify(cardData));
  let server;
  let failArticleWrite = false;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  vm.runInNewContext(source('server.js'), {
    __dirname: dir, URL, console: { log() {}, error() {} },
    require(name) {
      if (name === './seed.js') return [];
      if (name === './public/article-utils.js') return Utils;
      if (name === 'node:fs') return { ...fs, renameSync(from, to) {
        if (failArticleWrite && String(to).endsWith('flashdesk-articles.json')) throw new Error('article write failed');
        return fs.renameSync(from, to);
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
  vm.runInNewContext(source('public/article-store.js'), {
    window, fetch: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, options),
  });
  return {
    store: window.ArticleStore,
    cardFile: path.join(dir, 'flashdesk-data.json'),
    articleFile: path.join(dir, 'flashdesk-articles.json'),
    fail(value) { failArticleWrite = value; },
  };
}

test('Node ArticleStore creates its independent file and model', async (t) => {
  const h = await nodeArticleHarness(t);
  const article = await h.store.create(sample);
  assert.equal(article.source, 'Reuters');
  assert.equal(JSON.parse(fs.readFileSync(h.articleFile)).articles.length, 1);
});
test('Node ArticleStore reads the latest disk state on every list', async (t) => {
  const h = await nodeArticleHarness(t);
  await h.store.create(sample);
  const disk = JSON.parse(fs.readFileSync(h.articleFile));
  disk.articles.push({ ...disk.articles[0], id: 'external', title: 'External' });
  fs.writeFileSync(h.articleFile, JSON.stringify(disk));
  assert.equal((await h.store.list()).length, 2);
});
test('Node ArticleStore updates progress', async (t) => {
  const h = await nodeArticleHarness(t);
  const article = await h.store.create(sample);
  const updated = await h.store.updateProgress(article.id, { progressSentenceIndex: 1, progressPercent: 100 });
  assert.equal(updated.progressPercent, 100);
});
test('Node ArticleStore delete does not change FlashStore cards', async (t) => {
  const h = await nodeArticleHarness(t);
  const before = fs.readFileSync(h.cardFile, 'utf8');
  const article = await h.store.create(sample);
  await h.store.delete(article.id);
  assert.equal(fs.readFileSync(h.cardFile, 'utf8'), before);
});
test('Node Article save failure never changes FlashStore data', async (t) => {
  const h = await nodeArticleHarness(t);
  const before = fs.readFileSync(h.cardFile, 'utf8');
  h.fail(true);
  await assert.rejects(h.store.create(sample), /article write failed/);
  assert.equal(fs.readFileSync(h.cardFile, 'utf8'), before);
});
test('Article source is not stored in FlashStore export code', () => {
  assert.doesNotMatch(source('pwa/store-local.js'), /flashdesk-content|articles/);
  const executable = source('pwa/article-store-idb.js').replace(/\/\/.*$/gm, '');
  assert.match(executable, /DB_NAME = 'flashdesk-content'/);
  assert.doesNotMatch(executable, /flashdesk-data|flashdesk-audio/);
});

test('unknown word normalization defaults to an empty global list', () => {
  assert.deepEqual(Utils.normalizeUnknownWords(), []);
});
test('recognition starts at 100 percent when nothing is marked unknown', () => {
  assert.deepEqual(Utils.recognitionRate('Every token is known.', []), { total: 4, unknownTokens: 0, percent: 100 });
});
test('one unknown word lowers recognition', () => {
  assert.equal(Utils.recognitionRate('one two three', ['two']).percent, 66.7);
});
test('an unknown word is deducted for every token occurrence', () => {
  assert.deepEqual(Utils.recognitionRate('rule rule known', ['rule']), { total: 3, unknownTokens: 2, percent: 33.3 });
});
test('two unknown words are both deducted', () => {
  assert.equal(Utils.recognitionRate('one two three four', ['one', 'three']).percent, 50);
});
test('unknown word matching ignores case and surrounding whitespace', () => {
  assert.equal(Utils.recognitionRate('Regulation matters', [' regulation ']).unknownTokens, 1);
});
test('punctuation does not affect unknown word matching', () => {
  assert.equal(Utils.recognitionRate('(regulation), works.', ['regulation']).unknownTokens, 1);
});
test('adding an unknown word immediately lowers the pure recognition result', () => {
  const words = new Set();
  assert.equal(Utils.recognitionRate('one two', words).percent, 100);
  words.add('one');
  assert.equal(Utils.recognitionRate('one two', words).percent, 50);
});
test('removing an unknown word restores recognition', () => {
  const words = new Set(['one']);
  words.delete('one');
  assert.equal(Utils.recognitionRate('one two', words).percent, 100);
});
test('one global unknown list applies across Articles', () => {
  const words = ['regulation'];
  assert.equal(Utils.recognitionRate('Regulation changes.', words).unknownTokens, 1);
  assert.equal(Utils.recognitionRate('New regulation arrived.', words).unknownTokens, 1);
});
test('FlashDesk hit rate and recognition rate remain independent', () => {
  const cards = [{ deck: 'Words', front: 'expect', forms: [] }];
  assert.equal(Utils.articleCoverage('expect change', cards).percent, 50);
  assert.equal(Utils.recognitionRate('expect change', ['expect']).percent, 50);
});
test('a form can hit FlashDesk while the actual token remains unknown', () => {
  const cards = [{ deck: 'Words', front: 'expect', forms: ['expected'] }];
  assert.equal(Utils.articleCoverage('expected', cards).percent, 100);
  assert.equal(Utils.recognitionRate('expected', ['expected']).percent, 0);
});
test('unknown actions use ArticleStore rather than FlashStore', () => {
  const functionSource = appSource.slice(appSource.indexOf('async function setArticleUnknown'), appSource.indexOf('function openArticleSentence'));
  assert.match(functionSource, /ArticleStore\.setUnknownWord/);
  assert.doesNotMatch(functionSource, /FlashStore/);
});
test('marking unknown does not call the Word creation API', () => {
  const functionSource = appSource.slice(appSource.indexOf('async function setArticleUnknown'), appSource.indexOf('function openArticleSentence'));
  assert.doesNotMatch(functionSource, /addCard|addCardsBatch/);
});
test('unknown and add-to-library are separate bottom-sheet actions', () => {
  assert.match(appSource, /data-article-unknown/);
  assert.match(appSource, /data-article-add-word/);
  assert.match(appSource, /data-article-known/);
});
test('PWA unknownWords persist across ArticleStore instances', async () => {
  const idb = fakeIndexedDb();
  await createArticleStore(idb, Utils).setUnknownWord(' Regulation ', true);
  assert.deepEqual(await createArticleStore(idb, Utils).getUnknownWords(), ['regulation']);
});
test('PWA upgrades an old Article-only database with a reading profile', async () => {
  const store = createArticleStore(fakeIndexedDb({ legacyArticles: true }), Utils);
  assert.deepEqual(await store.getUnknownWords(), []);
  assert.deepEqual(await store.setUnknownWord('constraint', true), ['constraint']);
});
test('Node unknownWords persist in the independent Article file', async (t) => {
  const h = await nodeArticleHarness(t);
  await h.store.setUnknownWord(' Regulation ', true);
  assert.deepEqual(await h.store.getUnknownWords(), ['regulation']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.articleFile)).unknownWords, ['regulation']);
});
test('Node reads old Article data without unknownWords', async (t) => {
  const h = await nodeArticleHarness(t);
  fs.writeFileSync(h.articleFile, JSON.stringify({ articles: [] }));
  assert.deepEqual(await h.store.getUnknownWords(), []);
});
test('Node unknownWords updates never change flashdesk-data.json', async (t) => {
  const h = await nodeArticleHarness(t);
  const before = fs.readFileSync(h.cardFile, 'utf8');
  await h.store.setUnknownWord('expect', true);
  await h.store.setUnknownWord('expect', false);
  assert.equal(fs.readFileSync(h.cardFile, 'utf8'), before);
});

test('PWA Article list is empty before any Article is created', async () => {
  const store = createArticleStore(fakeIndexedDb(), Utils);
  assert.deepEqual(await store.list(), []);
});
test('Node Article list is empty when its independent file does not exist', async (t) => {
  const h = await nodeArticleHarness(t);
  assert.deepEqual(await h.store.list(), []);
  assert.equal(fs.existsSync(h.articleFile), false);
});
test('Node stale Article id reports a missing Article', async (t) => {
  const h = await nodeArticleHarness(t);
  await assert.rejects(h.store.get('already-deleted'), /article not found/);
});
test('missing Article navigation clears stale state and returns to the list', () => {
  const openSource = appSource.slice(appSource.indexOf('async function openArticle'), appSource.indexOf('function stopArticleProgressTracking'));
  assert.match(openSource, /articleIsMissing\(err\)/);
  assert.match(openSource, /state\.article\.current = null/);
  assert.match(openSource, /state\.article\.mode = 'list'/);
  assert.match(openSource, /renderArticleHome\(\)/);
  assert.match(openSource, /文章不存在或已删除/);
});
test('optional reading profile failure cannot hide an otherwise valid Article list', () => {
  const initSource = appSource.slice(appSource.indexOf('async function init()'), appSource.indexOf('\ninit();'));
  assert.match(initSource, /state\.articles = await ArticleStore\.list\(\)/);
  assert.doesNotMatch(initSource, /Promise\.all/);
  assert.match(initSource, /ArticleStore\.getUnknownWords\(\)/);
});
test('looking up a stale Article id never changes FlashStore data', async (t) => {
  const h = await nodeArticleHarness(t);
  const before = fs.readFileSync(h.cardFile, 'utf8');
  await assert.rejects(h.store.get('missing'));
  assert.equal(fs.readFileSync(h.cardFile, 'utf8'), before);
});

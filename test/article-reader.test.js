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

/* ---------- optional paragraph translations ---------- */

const translated = { ...sample, paragraphTranslations: ['史密斯先生训练模型。', '它们有用吗？是的！'] };

test('Article input keeps aligned paragraph translations as an optional field', () => {
  const normalized = Utils.normalizeArticleInput(translated);
  assert.deepEqual(normalized.paragraphTranslations, ['史密斯先生训练模型。', '它们有用吗？是的！']);
  assert.equal(Utils.splitParagraphs(normalized.content).length, normalized.paragraphTranslations.length);
});
test('Article input omits paragraph translations entirely when they are absent', () => {
  const normalized = Utils.normalizeArticleInput(sample);
  assert.equal('paragraphTranslations' in normalized, false);
  assert.equal(JSON.stringify(normalized).includes('paragraphTranslations'), false);
});
test('misaligned paragraph translations are dropped instead of throwing', () => {
  const short = Utils.normalizeArticleInput({ ...sample, paragraphTranslations: ['只有一段'] });
  assert.equal('paragraphTranslations' in short, false);
  const extra = Utils.normalizeArticleInput({ ...sample, paragraphTranslations: ['一', '二', '三'] });
  assert.equal('paragraphTranslations' in extra, false);
});
test('blank or non-string paragraph translations degrade to no translations', () => {
  assert.deepEqual(Utils.normalizeParagraphTranslations(['  ', ''], 2), []);
  assert.deepEqual(Utils.normalizeParagraphTranslations('not an array', 2), []);
  assert.deepEqual(Utils.normalizeParagraphTranslations(null, 2), []);
  assert.deepEqual(Utils.normalizeParagraphTranslations([1, 2], 2), []);
  assert.deepEqual(Utils.normalizeParagraphTranslations([' 一段 ', '二段 '], 2), ['一段', '二段']);
});
test('normalizeParagraphTranslations tolerates an unknown paragraph count', () => {
  assert.deepEqual(Utils.normalizeParagraphTranslations(['一', '二'], undefined), ['一', '二']);
});

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
test('Article speech segments preserve natural sentence order', () => {
  assert.deepEqual(Utils.articleSpeechSegments('First sentence. Second sentence!\n\nThird sentence?'), ['First sentence.', 'Second sentence!', 'Third sentence?']);
});
test('Article speech paragraphs preserve paragraph and sentence boundaries', () => {
  assert.deepEqual(Utils.articleSpeechParagraphs('First sentence. Second sentence!\n\nThird sentence?'), [
    ['First sentence.', 'Second sentence!'],
    ['Third sentence?'],
  ]);
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
test('saving an Article persists its paragraph translations and reads them back', async (t) => {
  const h = await nodeArticleHarness(t);
  const created = await h.store.create(translated);
  assert.deepEqual(created.paragraphTranslations, ['史密斯先生训练模型。', '它们有用吗？是的！']);
  const reloaded = await h.store.get(created.id);
  assert.deepEqual(reloaded.paragraphTranslations, ['史密斯先生训练模型。', '它们有用吗？是的！']);
  assert.equal(reloaded.content, translated.content);
});
test('an Article saved without translations round-trips with no new field', async (t) => {
  const h = await nodeArticleHarness(t);
  const created = await h.store.create(sample);
  assert.equal('paragraphTranslations' in created, false);
  const reloaded = await h.store.get(created.id);
  assert.equal('paragraphTranslations' in reloaded, false);
  assert.equal(reloaded.content, sample.content);
});
test('an existing Article on disk without translations still lists and loads', async (t) => {
  const h = await nodeArticleHarness(t);
  // Simulate an Article written before the field existed.
  fs.mkdirSync(path.dirname(h.articleFile), { recursive: true });
  fs.writeFileSync(h.articleFile, JSON.stringify({
    articles: [{ id: 'legacy_1', ...sample, createdAt: 1, updatedAt: 1, lastReadAt: null, progressSentenceIndex: 0, progressPercent: 0 }],
    unknownWords: [],
  }));
  const legacy = await h.store.get('legacy_1');
  assert.equal(legacy.title, sample.title);
  assert.equal(legacy.content, sample.content);
  assert.equal(Utils.splitParagraphs(legacy.content).length, 2);
  assert.equal('paragraphTranslations' in legacy, false);
  assert.equal((await h.store.list()).length, 1);
});
test('Article progress updates preserve already saved paragraph translations', async (t) => {
  const h = await nodeArticleHarness(t);
  const created = await h.store.create(translated);
  await h.store.updateProgress(created.id, { progressSentenceIndex: 1, progressPercent: 50 });
  const reloaded = await h.store.get(created.id);
  assert.deepEqual(reloaded.paragraphTranslations, ['史密斯先生训练模型。', '它们有用吗？是的！']);
  assert.equal(reloaded.progressPercent, 50);
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

/* ---------- Reading: per-paragraph narration + translation ---------- */

// Evaluate the real Reading paragraph renderer with a tiny DOM stand-in so the
// tests exercise the shipped markup instead of a hand-copied fixture.
function readingRenderHarness({ article, revealed = [], narration = {} } = {}) {
  const renderSource = appSource.slice(appSource.indexOf('function articleParagraphToolbarHtml'), appSource.indexOf('function renderArticleView'));
  const sentenceSource = appSource.slice(appSource.indexOf('function articleSentenceHtml'), appSource.indexOf('function articleParagraphToolbarHtml'));
  const captured = { html: '' };
  const sandbox = {
    FlashArticleUtils: Utils,
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    state: {
      cards: [{ id: 'w', deck: 'Words', front: 'expect', back: '期待', due: 1, streak: 1, created: 1 }],
      article: {
        current: article, mode: 'reader', parsed: null, unknownWords: new Set(),
        revealedParagraphs: new Set(revealed), narrationParagraphIndex: narration.paragraphIndex ?? null, narrationRate: narration.rate ?? null,
        cache: new Map(),
      },
    },
    articleMetrics: () => ({
      analysis: Utils.analyzeArticle(article.content),
      lookup: Utils.buildWordLookup(sandbox.state.cards),
      coverage: Utils.articleCoverage(article.content, Utils.buildWordLookup(sandbox.state.cards)),
      recognition: Utils.recognitionRate(article.content, sandbox.state.article.unknownWords),
    }),
    articlePercent: (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(1)),
    articleDate: () => '',
    startArticleProgressTracking: () => {},
    renderArticleHome: () => { captured.html = '<home>'; },
    requestAnimationFrame: () => {},
    document: { querySelector: () => null },
  };
  sandbox.$ = () => ({ set innerHTML(value) { captured.html = value; } });
  vm.runInNewContext(`${sentenceSource}\n${renderSource}\nrenderArticleReader();`, sandbox);
  return captured.html;
}

const readingSample = {
  id: 'r1', title: 'A Slow Morning', source: '', content: 'One. Two.\n\nThree.\n\nFour.',
  paragraphTranslations: ['第一段。', '第二段。', '第三段。'],
};

test('Reading renders one paragraph toolbar per English paragraph', () => {
  const html = readingRenderHarness({ article: readingSample });
  assert.equal((html.match(/class="article-paragraph-row"/g) || []).length, 3);
  assert.equal((html.match(/data-article-narrate-paragraph=/g) || []).length, 6); // normal + slow per paragraph
});

test('Reading shows a translation button only for paragraphs that stored one', () => {
  const html = readingRenderHarness({ article: readingSample });
  assert.equal((html.match(/data-article-paragraph-translation=/g) || []).length, 3);
  const legacy = readingRenderHarness({ article: { ...readingSample, paragraphTranslations: undefined } });
  assert.doesNotMatch(legacy, /data-article-paragraph-translation/);
  assert.doesNotMatch(legacy, /查看本段翻译/);
});

test('Reading keeps every translation collapsed until the learner asks', () => {
  const html = readingRenderHarness({ article: readingSample });
  assert.doesNotMatch(html, /data-article-paragraph-translation-body/);
  assert.equal((html.match(/查看本段翻译/g) || []).length, 3);
});

test('Reading expands exactly the requested paragraph', () => {
  const html = readingRenderHarness({ article: readingSample, revealed: [1] });
  const bodies = html.match(/data-article-paragraph-translation-body="\d"/g) || [];
  assert.deepEqual(bodies, ['data-article-paragraph-translation-body="1"']);
  assert.match(html, /第二段。/);
  assert.doesNotMatch(html, /第一段。/);
  assert.match(html, /收起本段翻译/);
});

test('Reading can expand several paragraphs at once', () => {
  const html = readingRenderHarness({ article: readingSample, revealed: [0, 2] });
  const bodies = html.match(/data-article-paragraph-translation-body="\d"/g) || [];
  assert.equal(bodies.length, 2);
  assert.match(html, /第一段。/);
  assert.match(html, /第三段。/);
});

test('Reading translation markup is a stable hook for tests and never a modal', () => {
  const html = readingRenderHarness({ article: readingSample, revealed: [0] });
  assert.match(html, /class="article-paragraph-translation" lang="zh-CN"/);
  assert.doesNotMatch(html, /<dialog|showModal/);
});

test('Reading uses the shared Article paragraph splitter', () => {
  const renderSource = appSource.slice(appSource.indexOf('function articleParagraphRowHtml'), appSource.indexOf('function renderArticleView'));
  assert.match(renderSource, /metrics\.analysis\.paragraphs/);
  assert.doesNotMatch(renderSource, /\.split\(\/\\n/); // no second paragraph regex in app.js
  assert.match(appSource, /function articleParagraphRowHtml\(paragraph, paragraphIndex, lookup, translations\)/);
});

test('Reading paragraph count matches the saved Article paragraph count', () => {
  const content = 'One.\n\nTwo.\n\nThree.\n\nFour.';
  const html = readingRenderHarness({ article: { ...readingSample, content, paragraphTranslations: ['一。', '二。', '三。', '四。'] } });
  assert.equal((html.match(/class="article-paragraph-row"/g) || []).length, Utils.splitParagraphs(content).length);
});

test('Reading paragraph narration plays only the selected paragraph sentences at normal rate', async () => {
  const calls = [];
  const startSource = appSource.slice(appSource.indexOf('async function startArticleParagraphNarration'), appSource.indexOf('function openArticleWord'));
  const sandbox = {
    FlashArticleUtils: Utils,
    state: { article: { current: { content: 'Alpha one. Alpha two.\n\nBeta one.' }, narrationId: 0, narrationRate: null, narrationParagraphIndex: null } },
    playEnglish: async (text, options) => { calls.push({ text, rate: options.rate }); return 'system'; },
    aiNarrationPause: async () => true,
    stopArticleParagraphNarration: () => {},
    refreshArticleParagraphNarrationUi: () => {},
    stopEnglishPlayback: () => {},
  };
  vm.runInNewContext(`${startSource}\nstartArticleParagraphNarration(1, 0);`, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.map((c) => c.text), ['Alpha one.', 'Alpha two.']);
  assert.deepEqual(calls.map((c) => c.rate), [1, 1]);
});

test('Reading slow narration passes the paragraph and the slow rate', async () => {
  const calls = [];
  const startSource = appSource.slice(appSource.indexOf('async function startArticleParagraphNarration'), appSource.indexOf('function openArticleWord'));
  const sandbox = {
    FlashArticleUtils: Utils,
    state: { article: { current: { content: 'Alpha one. Alpha two.\n\nBeta one.' }, narrationId: 0, narrationRate: null, narrationParagraphIndex: null } },
    playEnglish: async (text, options) => { calls.push({ text, rate: options.rate }); return 'system'; },
    aiNarrationPause: async () => true,
    stopArticleParagraphNarration: () => {},
    refreshArticleParagraphNarrationUi: () => {},
    stopEnglishPlayback: () => {},
  };
  vm.runInNewContext(`${startSource}\nstartArticleParagraphNarration(0.75, 1);`, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.map((c) => c.text), ['Beta one.']);
  assert.deepEqual(calls.map((c) => c.rate), [0.75]);
});

test('Reading narration never sends the Chinese translation into TTS', async () => {
  const calls = [];
  const startSource = appSource.slice(appSource.indexOf('async function startArticleParagraphNarration'), appSource.indexOf('function openArticleWord'));
  const sandbox = {
    FlashArticleUtils: Utils,
    state: { article: { current: { content: 'Only English here.', paragraphTranslations: ['只有中文翻译。'] }, narrationId: 0, narrationRate: null, narrationParagraphIndex: null } },
    playEnglish: async (text) => { calls.push(text); return 'system'; },
    aiNarrationPause: async () => true,
    stopArticleParagraphNarration: () => {},
    refreshArticleParagraphNarrationUi: () => {},
    stopEnglishPlayback: () => {},
  };
  vm.runInNewContext(`${startSource}\nstartArticleParagraphNarration(1, 0);`, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['Only English here.']);
  assert.equal(calls.some((t) => /[\u4e00-\u9fff]/.test(t)), false);
});

test('Reading paragraph narration prefers the existing playEnglish pipeline', () => {
  const startSource = appSource.slice(appSource.indexOf('async function startArticleParagraphNarration'), appSource.indexOf('function openArticleWord'));
  assert.match(startSource, /playEnglish\(sentences\[sentenceIndex\], \{ rate: state\.article\.narrationRate, waitForEnd: true \}\)/);
  assert.doesNotMatch(startSource, /speechSynthesis|new Audio\(|AudioContext|fetchTtsAudio/);
});

test('Reading toolbar buttons are handled before word and sentence lookups', () => {
  const handler = appSource.slice(appSource.indexOf("$('#article-root').addEventListener('click'"), appSource.indexOf("$('#article-action-close')"));
  assert.ok(handler.indexOf('data-article-narrate-paragraph') < handler.indexOf("closest('[data-article-word]')"));
  assert.match(handler, /e\.stopPropagation\(\)[\s\S]*?closest\('\[data-article-word\]'\)/);
});

test('Reading translation toggle flips a single paragraph and rerenders in place', () => {
  const handler = appSource.slice(appSource.indexOf("$('#article-root').addEventListener('click'"), appSource.indexOf("$('#article-action-close')"));
  assert.match(handler, /state\.article\.revealedParagraphs\.delete\(index\)/);
  assert.match(handler, /state\.article\.revealedParagraphs\.add\(index\)/);
  assert.match(handler, /renderArticleReader\(\)/);
  // Toggling must not touch any Article write path.
  assert.doesNotMatch(handler, /ArticleStore\.(create|updateProgress|setUnknownWord)/);
});

test('switching to a different Article clears the previous expansion state', () => {
  const openSource = appSource.slice(appSource.indexOf('async function openArticle'), appSource.indexOf('function stopArticleProgressTracking'));
  assert.match(openSource, /state\.article\.revealedParagraphs = new Set\(\)/);
});

test('leaving the reader clears expansion state without persisting it', () => {
  const handler = appSource.slice(appSource.indexOf("$('#article-root').addEventListener('click'"), appSource.indexOf("$('#article-action-close')"));
  const listBranch = handler.slice(handler.indexOf('data-article-list'), handler.indexOf('data.articleOpen'));
  assert.match(listBranch, /data-article-list/);
  assert.match(listBranch, /state\.article\.revealedParagraphs = new Set\(\)/);
  assert.doesNotMatch(appSource, /revealedParagraphs[^\n]*ArticleStore/);
});

test('Reading paragraph toolbar renders clickable Word tokens inside the English only', () => {
  const html = readingRenderHarness({ article: readingSample, revealed: [0] });
  assert.match(html, /data-article-word="One"/);
  const translationSection = html.slice(html.indexOf('article-paragraph-translation'), html.indexOf('article-paragraph-translation', html.indexOf('article-paragraph-translation') + 1));
  assert.doesNotMatch(translationSection, /data-article-word/);
});

/* ---------- Reading: statistics stay English-only ---------- */

test('Chinese translations never enter the Reading word count', () => {
  const content = 'One two three.';
  const withZh = `${content}\n\n一 二 三 四 五 六 七 八 九 十。`;
  const analysis = Utils.analyzeArticle(content);
  const polluted = Utils.analyzeArticle(withZh);
  assert.equal(analysis.wordCount, 3);
  assert.ok(polluted.wordCount > analysis.wordCount || polluted.paragraphs.length > analysis.paragraphs.length);
  // The Reading renderer only ever counts word tokens of the English content.
  const renderSource = appSource.slice(appSource.indexOf('function renderArticleReader'), appSource.indexOf('function renderArticleView'));
  assert.match(renderSource, /metrics\.analysis\.wordCount/);
  assert.doesNotMatch(renderSource, /wordCount[\s\S]{0,40}paragraphTranslations/);
});

test('Chinese translations do not change recognition rate', () => {
  const content = 'expect unknownword.';
  const base = Utils.recognitionRate(content, ['unknownword']);
  const withZh = Utils.recognitionRate(content, ['unknownword']);
  assert.deepEqual(base, withZh);
  assert.equal(base.total, 2);
});

test('Chinese translations do not change unknownWords', () => {
  const content = 'Alpha beta.';
  const before = Utils.normalizeUnknownWords(['beta']);
  const after = Utils.normalizeUnknownWords(['beta']);
  assert.deepEqual(before, after);
  assert.deepEqual(before, ['beta']);
});

test('FlashDesk coverage ignores the Chinese translation field', () => {
  const content = 'expect more';
  const cards = [{ deck: 'Words', front: 'expect' }];
  assert.equal(Utils.articleCoverage(content, cards).percent, 50);
  assert.equal(Utils.articleCoverage(content, cards).matched, 1);
});

/* ---------- Reading: layout contract at 375px ---------- */

test('Reading paragraph actions are a wrapping flex row that cannot become vertical slivers', () => {
  const css = source('public/styles.css');
  const block = css.slice(css.indexOf('.article-paragraph-actions'), css.indexOf('.article-paragraph-translation {'));
  assert.match(block, /display: flex/);
  assert.match(block, /flex-wrap: wrap/);
  assert.match(block, /min-height: 3[26]px/);
  // The narrow viewport is where slivers would appear: keep them from shrinking
  // and forbid mid-label wrapping.
  const narrow = css.slice(css.indexOf('@media (max-width: 560px)', css.indexOf('.article-paragraph-actions')));
  assert.match(narrow, /\.article-paragraph-narrate, \.article-paragraph-translate \{ flex: 1 1 auto; min-width: 0/);
  assert.match(narrow, /white-space: nowrap/);
});

test('Reading translations are visually lighter than the English body', () => {
  const css = source('public/styles.css');
  const block = css.slice(css.indexOf('.article-paragraph-translation {'), css.indexOf('.article-paragraph-translation .micro-label'));
  assert.match(block, /color: var\(--muted\)/);
  assert.match(block, /font-size: \.95rem/);
});

/* ---------- Reading: backward compatibility + no formal data writes ---------- */

test('a legacy Article without translations still renders English, words and progress', () => {
  const legacy = { id: 'legacy', title: 'Old', content: 'Mr. Smith trains models.\n\nDo they work? Yes!' };
  const html = readingRenderHarness({ article: legacy });
  assert.match(html, /data-article-word="Mr"/);
  assert.match(html, /class="article-sentence"/);
  assert.match(html, /article-progress-bar/);
  assert.match(html, /article-recognition-rate/);
  assert.doesNotMatch(html, /查看本段翻译/);
});

test('Reading never writes to the formal learning data', () => {
  const renderSource = appSource.slice(appSource.indexOf('function articleParagraphToolbarHtml'), appSource.indexOf('function renderArticleView'));
  assert.doesNotMatch(renderSource, /FlashStore|flashdesk-data/);
  const startSource = appSource.slice(appSource.indexOf('async function startArticleParagraphNarration'), appSource.indexOf('function openArticleWord'));
  assert.doesNotMatch(startSource, /FlashStore|flashdesk-data/);
});

test('the AI Today Article and Reading share the same paragraph splitter contract', () => {
  const content = 'One.\n\nTwo.\n\nThree.';
  assert.equal(Utils.splitParagraphs(content).length, Utils.analyzeArticle(content).paragraphs.length);
  assert.equal(Utils.splitParagraphs(content).length, Utils.normalizeParagraphTranslations(['一', '二', '三'], 3).length);
});

// PWA ArticleStore — long-form content lives in its own IndexedDB database,
// completely separate from flashdesk-data localStorage and flashdesk-audio.

((global) => {
  const DB_NAME = 'flashdesk-content';
  const DB_VERSION = 2;
  const STORE = 'articles';
  const PROFILE_STORE = 'readingProfile';
  const PROFILE_ID = 'default';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const makeId = () => `a_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  function createArticleStore(indexedDb = global.indexedDB, utils = global.FlashArticleUtils) {
    let dbPromise;

    function open() {
      if (!indexedDb) return Promise.reject(new Error('IndexedDB unavailable'));
      if (!utils) return Promise.reject(new Error('Article utilities unavailable'));
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(PROFILE_STORE)) db.createObjectStore(PROFILE_STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('无法打开文章数据库'));
      });
      return dbPromise;
    }

    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('文章存储操作失败'));
    });

    const transactionDone = (transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('文章保存失败'));
      transaction.onerror = () => reject(transaction.error || new Error('文章保存失败'));
    });

    async function list() {
      const db = await open();
      const transaction = db.transaction(STORE, 'readonly');
      const articles = await requestResult(transaction.objectStore(STORE).getAll());
      return clone(articles);
    }

    async function get(id) {
      const db = await open();
      const transaction = db.transaction(STORE, 'readonly');
      const article = await requestResult(transaction.objectStore(STORE).get(String(id)));
      if (!article) throw new Error('article not found');
      return clone(article);
    }

    async function create(fields) {
      const normalized = utils.normalizeArticleInput(fields);
      const now = Date.now();
      const article = {
        id: makeId(), ...normalized,
        createdAt: now, updatedAt: now, lastReadAt: null,
        progressSentenceIndex: 0, progressPercent: 0,
      };
      const db = await open();
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).add(article);
      await transactionDone(transaction);
      return clone(article);
    }

    async function updateProgress(id, progress) {
      const db = await open();
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const article = await requestResult(store.get(String(id)));
      if (!article) {
        transaction.abort();
        throw new Error('article not found');
      }
      const normalized = utils.normalizeProgress(progress?.progressSentenceIndex, progress?.progressPercent);
      const now = Date.now();
      Object.assign(article, normalized, { lastReadAt: now, updatedAt: now });
      store.put(article);
      await transactionDone(transaction);
      return clone(article);
    }

    async function remove(id) {
      const db = await open();
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(String(id));
      await transactionDone(transaction);
      return { ok: true };
    }

    async function getUnknownWords() {
      const db = await open();
      const transaction = db.transaction(PROFILE_STORE, 'readonly');
      const profile = await requestResult(transaction.objectStore(PROFILE_STORE).get(PROFILE_ID));
      return utils.normalizeUnknownWords(profile?.unknownWords);
    }

    async function setUnknownWord(word, unknown) {
      const key = utils.wordKey(word);
      if (!key) throw new Error('word is required');
      const db = await open();
      const transaction = db.transaction(PROFILE_STORE, 'readwrite');
      const store = transaction.objectStore(PROFILE_STORE);
      const profile = await requestResult(store.get(PROFILE_ID));
      const words = new Set(utils.normalizeUnknownWords(profile?.unknownWords));
      if (unknown) words.add(key); else words.delete(key);
      const unknownWords = [...words];
      store.put({ id: PROFILE_ID, unknownWords });
      await transactionDone(transaction);
      return clone(unknownWords);
    }

    return { list, get, create, updateProgress, delete: remove, getUnknownWords, setUnknownWord };
  }

  global.createArticleStore = createArticleStore;
  global.ArticleStore = createArticleStore();
  if (typeof module !== 'undefined' && module.exports) module.exports = { createArticleStore };
})(typeof window !== 'undefined' ? window : globalThis);

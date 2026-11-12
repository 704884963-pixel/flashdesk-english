// PWA ArticleStore — long-form content lives in its own IndexedDB database,
// completely separate from flashdesk-data localStorage and flashdesk-audio.

((global) => {
  const DB_NAME = 'flashdesk-content';
  const DB_VERSION = 4;
  const STORE = 'articles';
  const PROFILE_STORE = 'readingProfile';
  const PROFILE_ID = 'default';
  const DRAFT_STORE = 'aiDrafts';
  const SONG_STORE = 'songs';
  const songLearning = global.FlashSongLearning
    || (typeof module !== 'undefined' && module.exports ? require('../public/song-learning.js') : null);
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
          if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(SONG_STORE)) db.createObjectStore(SONG_STORE, { keyPath: 'id' });
        };
        request.onblocked = () => reject(new Error('文章数据库正在被其他页面使用，请关闭旧页面后重试'));
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
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

    async function listSongs() {
      const db = await open();
      const transaction = db.transaction(SONG_STORE, 'readonly');
      return clone(await requestResult(transaction.objectStore(SONG_STORE).getAll()));
    }

    async function getSong(id) {
      const db = await open();
      const transaction = db.transaction(SONG_STORE, 'readonly');
      const song = await requestResult(transaction.objectStore(SONG_STORE).get(String(id)));
      if (!song) throw new Error('song not found');
      return clone(song);
    }

    async function createSong(fields) {
      const song = songLearning.createSong(fields);
      const db = await open();
      const transaction = db.transaction(SONG_STORE, 'readwrite');
      transaction.objectStore(SONG_STORE).add(song);
      await transactionDone(transaction);
      return clone(song);
    }

    async function updateSong(id, fields) {
      const current = await getSong(id);
      const now = Date.now();
      const song = songLearning.normalizeSong({
        ...current, ...clone(fields), id: current.id, createdAt: current.createdAt,
        updatedAt: now, lastStudiedAt: fields?.lastStudiedAt === null ? null : (Number(fields?.lastStudiedAt) || now),
      });
      const db = await open();
      const transaction = db.transaction(SONG_STORE, 'readwrite');
      transaction.objectStore(SONG_STORE).put(song);
      await transactionDone(transaction);
      return clone(song);
    }

    async function deleteSong(id) {
      const db = await open();
      const transaction = db.transaction(SONG_STORE, 'readwrite');
      transaction.objectStore(SONG_STORE).delete(String(id));
      await transactionDone(transaction);
      return { ok: true };
    }

    async function exportSnapshot() {
      return { articles: await list(), unknownWords: await getUnknownWords(), songs: await listSongs() };
    }

    async function replaceSnapshot(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.articles) || !Array.isArray(snapshot.unknownWords)) {
        throw new Error('阅读数据格式无效');
      }
      const normalizedSongs = (Array.isArray(snapshot.songs) ? snapshot.songs : []).map(songLearning.normalizeSong);
      const db = await open();
      const transaction = db.transaction([STORE, PROFILE_STORE, SONG_STORE], 'readwrite');
      const articles = transaction.objectStore(STORE);
      const profile = transaction.objectStore(PROFILE_STORE);
      const songs = transaction.objectStore(SONG_STORE);
      articles.clear();
      songs.clear();
      snapshot.articles.forEach((article) => articles.put(clone(article)));
      normalizedSongs.forEach((song) => songs.put(song));
      profile.put({ id: PROFILE_ID, unknownWords: utils.normalizeUnknownWords(snapshot.unknownWords) });
      await transactionDone(transaction);
      return exportSnapshot();
    }

    async function listAiDrafts() {
      const db = await open();
      const transaction = db.transaction(DRAFT_STORE, 'readonly');
      return clone(await requestResult(transaction.objectStore(DRAFT_STORE).getAll()));
    }

    async function saveAiDraft(fields) {
      const db = await open();
      const now = Date.now();
      const draft = {
        type: fields?.type, data: clone(fields?.data || {}), provenance: utils.normalizeAiProvenance(fields?.provenance) || {},
        id: fields?.id || `d_${now}_${Math.random().toString(16).slice(2, 8)}`, createdAt: fields?.createdAt || now,
      };
      const transaction = db.transaction(DRAFT_STORE, 'readwrite');
      transaction.objectStore(DRAFT_STORE).put(draft);
      await transactionDone(transaction);
      return clone(draft);
    }

    async function deleteAiDraft(id) {
      const db = await open();
      const transaction = db.transaction(DRAFT_STORE, 'readwrite');
      transaction.objectStore(DRAFT_STORE).delete(String(id));
      await transactionDone(transaction);
      return { ok: true };
    }

    return {
      list, get, create, updateProgress, delete: remove, getUnknownWords, setUnknownWord,
      exportSnapshot, replaceSnapshot, listAiDrafts, saveAiDraft, deleteAiDraft,
      listSongs, getSong, createSong, updateSong, deleteSong,
    };
  }

  global.createArticleStore = createArticleStore;
  global.ArticleStore = createArticleStore();
  if (typeof module !== 'undefined' && module.exports) module.exports = { createArticleStore };
})(typeof window !== 'undefined' ? window : globalThis);

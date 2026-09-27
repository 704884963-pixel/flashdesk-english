// Persistent high-quality pronunciation audio. Card data and TTS credentials
// deliberately live elsewhere; this database stores only reusable audio blobs.
(function initFlashAudioCache(global) {
  const DB_NAME = 'flashdesk-audio';
  const DB_VERSION = 1;
  const STORE_NAME = 'audio';
  const CACHE_SCHEMA = 'audio-v1';

  function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function cacheKey(endpoint, text) {
    return JSON.stringify([CACHE_SCHEMA, String(endpoint || '').trim(), normalizeText(text)]);
  }

  function createAudioCache(indexedDb = global.indexedDB) {
    let databasePromise = null;

    function openDatabase() {
      if (!indexedDb || typeof indexedDb.open !== 'function') {
        return Promise.reject(new Error('IndexedDB unavailable'));
      }
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open audio cache'));
        request.onblocked = () => reject(new Error('Audio cache upgrade blocked'));
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
      return databasePromise;
    }

    async function request(storeMode, operation) {
      const database = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, storeMode);
        const store = transaction.objectStore(STORE_NAME);
        let result;
        let operationRequest;
        try {
          operationRequest = operation(store);
        } catch (error) {
          reject(error);
          return;
        }
        if (operationRequest) {
          operationRequest.onsuccess = () => { result = operationRequest.result; };
          operationRequest.onerror = () => reject(operationRequest.error || new Error('Audio cache request failed'));
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('Audio cache transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('Audio cache transaction aborted'));
      });
    }

    async function get(key) {
      return (await request('readonly', (store) => store.get(key))) || null;
    }

    async function put(record) {
      const normalized = {
        key: String(record.key),
        text: normalizeText(record.text),
        blob: record.blob,
        mimeType: String(record.mimeType || record.blob?.type || 'audio/mpeg'),
        endpoint: String(record.endpoint || ''),
        createdAt: Number(record.createdAt) || Date.now(),
        size: Number(record.size) || Number(record.blob?.size) || 0,
      };
      await request('readwrite', (store) => store.put(normalized));
      return normalized;
    }

    async function getAll() {
      return (await request('readonly', (store) => store.getAll())) || [];
    }

    async function clear() {
      await request('readwrite', (store) => store.clear());
    }

    return { get, put, getAll, clear };
  }

  const cache = createAudioCache();
  global.FlashAudioCache = {
    DB_NAME,
    DB_VERSION,
    STORE_NAME,
    CACHE_SCHEMA,
    normalizeText,
    cacheKey,
    createAudioCache,
    ...cache,
  };
})(window);

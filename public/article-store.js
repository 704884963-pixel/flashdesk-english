// Node/server Article adapter. The PWA build replaces this file with the
// IndexedDB adapter from pwa/article-store-idb.js.

(() => {
  async function api(path, options) {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || response.statusText);
    return body;
  }

  const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  window.ArticleStore = {
    list: async () => (await api('/api/articles')).articles,
    exportSnapshot: () => api('/api/articles/backup'),
    replaceSnapshot: (snapshot) => api('/api/articles/backup', json('PUT', snapshot)),
    getUnknownWords: async () => (await api('/api/articles/profile')).unknownWords,
    setUnknownWord: async (word, unknown) => (
      await api('/api/articles/profile/unknown-word', json('PATCH', { word, unknown }))
    ).unknownWords,
    get: async (id) => (await api(`/api/articles/${encodeURIComponent(id)}`)).article,
    create: async (article) => (await api('/api/articles', json('POST', article))).article,
    updateProgress: async (id, progress) => (
      await api(`/api/articles/${encodeURIComponent(id)}/progress`, json('PATCH', progress))
    ).article,
    delete: (id) => api(`/api/articles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
})();

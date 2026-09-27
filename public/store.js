// FlashDesk server adapter — talks to server.js over /api/*.
// The PWA build replaces this file with a localStorage adapter (pwa/store-local.js);
// app.js only ever touches window.FlashStore.

(() => {
  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }

  const postJSON = (path, obj) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  window.FlashStore = {
    load: () => api('/api/cards'), // -> {cards, history, meta?}; legacy Word defaults are read-only
    addCard: (fields) => postJSON('/api/cards', fields), // -> {card}
    importBatch: (items) => postJSON('/api/cards/batch', { items }), // -> atomic batch result
    updateCard: (id, { front, back, memoryReading, chineseReading, forms }) => api(`/api/cards/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ front, back, memoryReading, chineseReading, forms }),
    }), // -> {card}
    gradeCard: (id, grade) => postJSON('/api/cards/grade', { id, grade }), // -> {card}
    deleteCard: (id) => api(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }), // -> {ok}
    logSession: (summary) => postJSON('/api/session', summary), // -> {ok, logged}
    logQuiz: (result) => postJSON('/api/quiz', result), // -> {ok, logged}
    logNote: (logged) => (logged === null
      ? 'Logging…'
      : logged ? 'Logged to ~/drills/log.txt' : 'Could not write ~/drills/log.txt'),
    // exportData / importData deliberately absent — the server owns the data
    // file, and app.js hides the Data panel when they're missing.
  };
})();

// FlashDesk local adapter — the PWA build ships this file as store.js.
// All data lives in localStorage on this device; the scheduling logic mirrors
// server.js exactly (interval ladder, again-delay, quiz-miss handling).

(() => {
  const KEY = 'flashdesk-data';
  const TEN_MINUTES = 10 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const LADDER = [1, 3, 7, 14, 30, 60]; // days out by streak; streak ≥ 6 stays at 60

  const makeId = () => 'c_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6);

  function toCard({ front, back, deck }) {
    const now = Date.now();
    return { id: makeId(), front, back, deck, due: now, streak: 0, lapses: 0, created: now };
  }

  // Deep clones on every boundary: app.js mutates its own copies (e.g. the
  // optimistic history push after a session) without touching persisted state —
  // the same separation the HTTP server gives it for free.
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function localDate(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  let data;
  let initError;
  let ready = Promise.resolve();

  function validData(value) {
    return value && Array.isArray(value.cards) && Array.isArray(value.history);
  }

  function parseStored(raw) {
    const parsed = JSON.parse(raw);
    if (!validData(parsed)) throw new Error('本机保存的数据格式无效，请先导出或修复备份');
    return parsed;
  }

  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) {
      ready = fetch('default-data.json')
        .then((response) => {
          if (!response.ok) throw new Error(`无法加载初始词库（${response.status}）`);
          return response.json();
        })
        .then((initial) => {
          if (!validData(initial)) throw new Error('初始词库格式无效');
          // Another tab may have created data while the request was in flight.
          // Existing local data always wins, even when its cards array is empty.
          const existing = localStorage.getItem(KEY);
          data = existing === null ? clone(initial) : parseStored(existing);
          if (existing === null) persist();
        })
        .catch((err) => { initError = err; });
    } else {
      data = parseStored(raw);
    }
  } catch (err) {
    initError = err;
  }

  async function ensureReady() {
    await ready;
    if (initError) throw initError;
  }

  function requireReady() {
    if (initError) throw initError;
    if (!data) throw new Error('初始词库仍在加载，请稍后重试');
  }

  function wordDefaults(card) {
    if (card.deck !== 'Words') return card;
    return {
      ...card,
      wordNumber: card.wordNumber ?? null,
      memoryReading: card.memoryReading ?? '',
      chineseReading: card.chineseReading ?? '',
      forms: card.forms ?? [],
    };
  }

  function wordFields(fields) {
    const memoryReading = fields.memoryReading === undefined ? '' : fields.memoryReading;
    const chineseReading = fields.chineseReading === undefined ? '' : fields.chineseReading;
    if (typeof memoryReading !== 'string' || typeof chineseReading !== 'string') {
      throw new Error('发音拆解和中文近似必须是字符串');
    }
    const forms = fields.forms === undefined ? [] : fields.forms;
    if (!Array.isArray(forms) || forms.some((form) => typeof form !== 'string')) {
      throw new Error('词形变化必须是字符串数组');
    }
    return {
      memoryReading: memoryReading.trim(),
      chineseReading: chineseReading.trim(),
      forms: [...new Set(forms.map((form) => form.trim()).filter(Boolean))],
    };
  }

  function nextWordNumber() {
    let max = 0;
    for (const card of data.cards) {
      if (Number.isSafeInteger(card.wordNumber) && card.wordNumber > max) max = card.wordNumber;
    }
    const saved = data.meta?.nextWordNumber;
    const next = Math.max(max + 1, Number.isSafeInteger(saved) && saved > 0 ? saved : 1);
    if (!Number.isSafeInteger(next) || !Number.isSafeInteger(next + 1)) {
      throw new Error('单词编号已超出安全范围');
    }
    return next;
  }

  function prepareWord(fields) {
    if (typeof fields.front !== 'string' || !fields.front.trim()
        || typeof fields.back !== 'string' || !fields.back.trim()) {
      throw new Error('英文单词和中文意思必须是非空字符串');
    }
    const front = fields.front.trim();
    if (data.cards.some((card) => card.deck === 'Words'
        && card.front.trim().toLowerCase() === front.toLowerCase())) {
      throw new Error('该单词已存在，请勿重复添加');
    }
    return { ...wordFields(fields), wordNumber: nextWordNumber() };
  }

  function editableWordFields(card, fields) {
    if (card.deck !== 'Words') return {};
    if (data.cards.some((other) => other.id !== card.id && other.deck === 'Words'
        && other.front.trim().toLowerCase() === fields.front.trim().toLowerCase())) {
      throw new Error('该单词已存在，请勿重复添加');
    }
    const normalized = wordFields(fields);
    const changes = {};
    for (const key of ['memoryReading', 'chineseReading', 'forms']) {
      if (fields[key] !== undefined) changes[key] = normalized[key];
    }
    return changes;
  }

  function persist() {
    // Throws on quota/private-mode failures so callers surface the existing
    // "Save failed" / "Could not save" paths instead of losing data silently.
    localStorage.setItem(KEY, JSON.stringify(data));
  }
  function findCard(id) {
    const card = data.cards.find((c) => c.id === id);
    if (!card) throw new Error('card not found');
    return card;
  }

  window.FlashStore = {
    async load() {
      await ensureReady();
      return clone({
        ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
        cards: data.cards.map(wordDefaults), history: data.history,
        ...(data.meta ? { meta: data.meta } : {}),
      });
    },

    async addCard(fields) {
      await ensureReady();
      let { front, back, deck } = fields;
      deck = String(deck || '').trim();
      const extra = deck === 'Words' ? prepareWord(fields) : {};
      front = String(front || '').trim();
      back = String(back || '').trim();
      if (!front || !back || !deck) throw new Error('front, back, and deck are all required');
      const card = toCard({ front, back, deck });
      if (deck === 'Words') {
        card.wordNumber = extra.wordNumber;
        card.memoryReading = extra.memoryReading;
        card.chineseReading = extra.chineseReading;
        card.forms = extra.forms;
      }
      const previousMeta = data.meta;
      if (deck === 'Words') data.meta = { ...data.meta, nextWordNumber: card.wordNumber + 1 };
      data.cards.push(card);
      try { persist(); }
      catch (err) {
        data.cards.pop();
        if (previousMeta === undefined) delete data.meta;
        else data.meta = previousMeta;
        throw err;
      }
      return { card: clone(card) };
    },

    async updateCard(id, fields) {
      await ensureReady();
      const { front, back } = fields;
      const card = findCard(id);
      if (typeof front !== 'string' || !front.trim()
          || typeof back !== 'string' || !back.trim()) {
        throw new Error('front and back must be non-empty strings');
      }
      const changes = editableWordFields(card, fields);
      const previous = { ...card };
      card.front = front.trim();
      card.back = back.trim();
      for (const key of Object.keys(changes)) card[key] = changes[key];
      try {
        persist();
      } catch (err) {
        for (const key of Object.keys(changes)) delete card[key];
        Object.assign(card, previous);
        throw err;
      }
      return { card: clone(card) };
    },

    async gradeCard(id, grade) {
      await ensureReady();
      const card = findCard(id);
      if (grade === 'again') {
        card.due = Date.now() + TEN_MINUTES;
        card.streak = 0;
        card.lapses += 1;
      } else if (grade === 'got') {
        card.streak += 1;
        card.due = Date.now() + LADDER[Math.min(card.streak, LADDER.length) - 1] * DAY;
      } else {
        throw new Error('grade must be "again" or "got"');
      }
      persist();
      return { card: clone(card) };
    },

    async deleteCard(id) {
      await ensureReady();
      const card = data.cards.find((c) => c.id === id);
      if (card && Number.isSafeInteger(card.wordNumber) && card.wordNumber > 0) {
        data.meta = { ...data.meta, nextWordNumber: nextWordNumber() };
      }
      data.cards = data.cards.filter((c) => c.id !== id);
      persist();
      return { ok: true };
    },

    async logSession({ deck, reviewed, correct }) {
      await ensureReady();
      data.history.push({ date: localDate(), deck, reviewed, correct });
      persist();
      return { ok: true, logged: true };
    },

    async logQuiz({ missedIds }) {
      await ensureReady();
      const now = Date.now();
      for (const id of missedIds || []) {
        const card = data.cards.find((c) => c.id === id);
        if (card && card.due > now) card.due = now; // back in the review queue; stats untouched
      }
      persist();
      return { ok: true, logged: true };
    },

    logNote(logged) {
      return logged === null
        ? 'Saving…'
        : logged ? 'Saved on this device' : 'Could not save on this device';
    },

    exportData() {
      requireReady();
      return JSON.stringify(data, null, 2);
    },

    importData(text) {
      requireReady();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('that is not valid JSON');
      }

      const validCard = (c) => c && typeof c === 'object'
        && typeof c.front === 'string' && c.front.trim()
        && typeof c.back === 'string' && c.back.trim()
        && typeof c.deck === 'string' && c.deck.trim();

      if (Array.isArray(parsed)) {
        // Bare card list -> merge as fresh cards, skip duplicates by front+deck.
        if (!parsed.every(validCard)) throw new Error('every card needs front, back, and deck');
        const seen = new Set(data.cards.map((c) => `${c.front} ${c.deck}`));
        let added = 0;
        const previous = clone(data);
        try {
          for (const c of parsed) {
            const key = `${c.front} ${c.deck}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const fields = { ...c, front: c.front.trim(), back: c.back.trim(), deck: c.deck.trim() };
            if (fields.deck === 'Words' && data.cards.some((card) => card.deck === 'Words'
                && card.front.trim().toLowerCase() === fields.front.toLowerCase())) continue;
            const extra = fields.deck === 'Words' ? prepareWord(fields) : {};
            data.cards.push({ ...toCard(fields), ...extra });
            if (fields.deck === 'Words') data.meta = { ...data.meta, nextWordNumber: extra.wordNumber + 1 };
            added += 1;
          }
          persist();
        } catch (err) {
          data = previous;
          throw err;
        }
        return `Merged ${added} new card${added === 1 ? '' : 's'} (${parsed.length - added} duplicate${parsed.length - added === 1 ? '' : 's'} skipped).`;
      }

      if (parsed && Array.isArray(parsed.cards)) {
        // Full export -> replace everything, keeping review state when present.
        if (!parsed.cards.every(validCard)) throw new Error('every card needs front, back, and deck');
        const now = Date.now();
        const previous = data;
        const highWater = nextWordNumber();
        const replacement = {
          ...(Number.isSafeInteger(parsed.schemaVersion)
            ? { schemaVersion: parsed.schemaVersion }
            : (Number.isSafeInteger(data.schemaVersion) ? { schemaVersion: data.schemaVersion } : {})),
          cards: parsed.cards.map((c) => ({
            id: typeof c.id === 'string' && c.id ? c.id : makeId(),
            front: c.front.trim(),
            back: c.back.trim(),
            deck: c.deck.trim(),
            due: Number.isFinite(c.due) ? c.due : now,
            streak: Number.isFinite(c.streak) ? c.streak : 0,
            lapses: Number.isFinite(c.lapses) ? c.lapses : 0,
            created: Number.isFinite(c.created) ? c.created : now,
            ...(c.deck.trim() === 'Words' ? {
              ...wordFields(c),
              wordNumber: Number.isSafeInteger(c.wordNumber) && c.wordNumber > 0 ? c.wordNumber : null,
            } : {}),
          })),
          history: Array.isArray(parsed.history) ? parsed.history : [],
          meta: {
            ...data.meta, ...parsed.meta,
            nextWordNumber: Math.max(highWater,
              Number.isSafeInteger(parsed.meta?.nextWordNumber) && parsed.meta.nextWordNumber > 0
                ? parsed.meta.nextWordNumber : 1),
          },
        };
        data = replacement;
        try {
          data.meta.nextWordNumber = nextWordNumber();
          persist();
        } catch (err) {
          data = previous;
          throw err;
        }
        return `Imported ${data.cards.length} cards (full replace).`;
      }

      throw new Error('expected a full export or a list of {front, back, deck} cards');
    },
  };

  // Ask the browser to protect this origin's storage from eviction.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Offline support. No auto-reload on update — that would yank an in-progress
  // session; the toast tells the owner a relaunch picks up the new version.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller
                && typeof toast === 'function') {
              toast('Updated — close and reopen to get the new version');
            }
          });
        });
      }).catch(() => {});
    });
  }
})();

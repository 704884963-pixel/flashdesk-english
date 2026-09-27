// FlashDesk batch text parser and preview planner. Pure functions only:
// parsing/previewing never writes cards, localStorage, or server data.

(() => {
  const TYPES = { WORD: 'Words', SENTENCE: 'Sentences' };
  const COMMON_FIELDS = new Set(['front', 'back']);
  const WORD_FIELDS = new Set(['front', 'back', 'memoryReading', 'chineseReading', 'forms']);

  function normalizeForms(value) {
    return [...new Set(String(value || '').split(/[,，]+/).map((form) => form.trim()).filter(Boolean))];
  }

  function finishBlock(block, index) {
    const errors = block.errors.slice();
    const deck = TYPES[block.rawType] || null;
    const allowed = block.rawType === 'WORD' ? WORD_FIELDS : COMMON_FIELDS;
    if (!deck) errors.push(block.rawType ? `未知 block 类型：${block.rawType}` : 'block 缺少类型');
    for (const field of Object.keys(block.fields)) {
      if (!allowed.has(field)) errors.push(`未知字段：${field}`);
    }
    const front = String(block.fields.front || '').trim();
    const back = String(block.fields.back || '').trim();
    if (deck && !front) errors.push('缺少 front');
    if (deck && !back) errors.push('缺少 back');
    return {
      index: index + 1,
      rawType: block.rawType || '',
      deck,
      front,
      back,
      memoryReading: deck === 'Words' ? String(block.fields.memoryReading || '').trim() : '',
      chineseReading: deck === 'Words' ? String(block.fields.chineseReading || '').trim() : '',
      forms: deck === 'Words' ? normalizeForms(block.fields.forms) : [],
      errors,
    };
  }

  function parseBatchText(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let current = null;
    const start = (rawType) => ({ rawType, fields: {}, errors: [] });
    const push = () => {
      if (current) blocks.push(finishBlock(current, blocks.length));
      current = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^[A-Z][A-Z0-9_-]*$/.test(line)) {
        push();
        current = start(line);
        continue;
      }
      const field = line.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
      if (field) {
        if (!current) current = start('');
        current.fields[field[1]] = field[2];
        continue;
      }
      if (!current) current = start('');
      current.errors.push(`无法解析：${line}`);
    }
    push();
    return blocks;
  }

  const wordKey = (front) => String(front).trim().toLowerCase();
  const sentenceKey = (front) => String(front).trim();

  function effectiveNextWordNumber(cards, meta) {
    let max = 0;
    for (const card of cards || []) {
      if (Number.isSafeInteger(card.wordNumber) && card.wordNumber > max) max = card.wordNumber;
    }
    const saved = meta?.nextWordNumber;
    return Math.max(max + 1, Number.isSafeInteger(saved) && saved > 0 ? saved : 1);
  }

  function previewBatchText(text, cards, meta) {
    const parsed = parseBatchText(text);
    const existingWords = new Set((cards || []).filter((card) => card.deck === 'Words').map((card) => wordKey(card.front)));
    const existingSentences = new Set((cards || []).filter((card) => card.deck === 'Sentences').map((card) => sentenceKey(card.front)));
    const batchWords = new Set();
    const batchSentences = new Set();
    let nextNumber = effectiveNextWordNumber(cards || [], meta);
    const items = parsed.map((item) => {
      if (item.errors.length) return { ...item, status: 'error', reason: item.errors.join('；'), expectedWordNumber: null };
      const isWord = item.deck === 'Words';
      const key = isWord ? wordKey(item.front) : sentenceKey(item.front);
      const existing = isWord ? existingWords : existingSentences;
      const batch = isWord ? batchWords : batchSentences;
      if (existing.has(key)) return { ...item, status: 'existing', reason: '已存在', expectedWordNumber: null };
      if (batch.has(key)) return { ...item, status: 'batch-duplicate', reason: '批次内重复', expectedWordNumber: null };
      batch.add(key);
      const expectedWordNumber = isWord ? nextNumber++ : null;
      return { ...item, status: 'importable', reason: '', expectedWordNumber };
    });
    return {
      items,
      stats: {
        importable: items.filter((item) => item.status === 'importable').length,
        existing: items.filter((item) => item.status === 'existing').length,
        batchDuplicate: items.filter((item) => item.status === 'batch-duplicate').length,
        error: items.filter((item) => item.status === 'error').length,
      },
      nextWordNumber: nextNumber,
    };
  }

  function importableFields(preview) {
    return preview.items.filter((item) => item.status === 'importable').map((item) => ({
      deck: item.deck,
      front: item.front,
      back: item.back,
      ...(item.deck === 'Words' ? {
        memoryReading: item.memoryReading,
        chineseReading: item.chineseReading,
        forms: item.forms.slice(),
      } : {}),
    }));
  }

  const FlashBatchImport = {
    normalizeForms, parseBatchText, effectiveNextWordNumber,
    previewBatchText, importableFields,
  };
  if (typeof window !== 'undefined') window.FlashBatchImport = FlashBatchImport;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlashBatchImport;
})();

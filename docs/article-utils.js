// Pure Article parsing and vocabulary helpers shared by Node tests and the UI.

(() => {
  const LETTER = /\p{L}/u;

  function normalizeContent(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim();
  }

  function normalizeArticleInput(input) {
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const content = typeof input?.content === 'string' ? normalizeContent(input.content) : '';
    const source = typeof input?.source === 'string' ? input.source.trim() : '';
    const sourceUrl = typeof input?.sourceUrl === 'string' ? input.sourceUrl.trim() : '';
    const publishedAt = typeof input?.publishedAt === 'string' ? input.publishedAt.trim() : '';
    if (!title) throw new Error('文章标题不能为空');
    if (!content) throw new Error('文章正文不能为空');
    if (sourceUrl) {
      let url;
      try { url = new URL(sourceUrl); } catch { throw new Error('原文链接必须是有效的 http / https 地址'); }
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('原文链接必须是有效的 http / https 地址');
      }
    }
    return { title, source, sourceUrl, publishedAt, content };
  }

  function splitParagraphs(content) {
    const normalized = normalizeContent(content);
    if (!normalized) return [];
    return normalized.split(/\n[\t ]*\n+/)
      .map((paragraph) => paragraph.trim().replace(/\n+/g, ' '))
      .filter(Boolean);
  }

  function fallbackSentences(text) {
    const marker = '\uE000';
    let safe = text;
    safe = safe.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\./gi, (value) => value.replace('.', marker));
    safe = safe.replace(/\b(?:[A-Za-z]\.){2,}/g, (value) => value.replaceAll('.', marker));
    safe = safe.replace(/(\d)\.(\d)/g, `$1${marker}$2`);
    return safe.split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.replaceAll(marker, '.').trim())
      .filter(Boolean);
  }

  function splitSentences(text, segmenterFactory = typeof Intl !== 'undefined' ? Intl.Segmenter : null) {
    const value = String(text || '').trim();
    if (!value) return [];
    if (typeof segmenterFactory === 'function') {
      try {
        const segmenter = new segmenterFactory('en', { granularity: 'sentence' });
        const raw = [...segmenter.segment(value)].map((part) => part.segment.trim()).filter(Boolean);
        const merged = [];
        for (let i = 0; i < raw.length; i += 1) {
          let sentence = raw[i];
          while (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.$/i.test(sentence)
              || /^(?:[A-Za-z]\.){2,}$/.test(sentence)) {
            if (i + 1 >= raw.length) break;
            sentence += ` ${raw[++i]}`;
          }
          merged.push(sentence);
        }
        return merged;
      } catch { /* use the abbreviation-aware fallback */ }
    }
    return fallbackSentences(value);
  }

  function fallbackWordTokens(text) {
    const pattern = /[\p{L}]+(?:['’][\p{L}]+)*(?:-[\p{L}]+(?:['’][\p{L}]+)*)*/gu;
    return [...String(text || '').matchAll(pattern)].map((match) => ({ text: match[0], index: match.index }));
  }

  function wordTokens(text, segmenterFactory = typeof Intl !== 'undefined' ? Intl.Segmenter : null) {
    const value = String(text || '');
    if (typeof segmenterFactory !== 'function') return fallbackWordTokens(value);
    try {
      const parts = [...new segmenterFactory('en', { granularity: 'word' }).segment(value)];
      const tokens = [];
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!part.isWordLike || !LETTER.test(part.segment)) continue;
        let textValue = part.segment;
        let end = part.index + part.segment.length;
        while (i + 2 < parts.length) {
          const joiner = parts[i + 1];
          const next = parts[i + 2];
          if (!/^['’\-]$/.test(joiner.segment) || joiner.index !== end
              || !next.isWordLike || next.index !== end + joiner.segment.length
              || !LETTER.test(next.segment)) break;
          textValue += joiner.segment + next.segment;
          end = next.index + next.segment.length;
          i += 2;
        }
        tokens.push({ text: textValue, index: part.index });
      }
      return tokens;
    } catch {
      return fallbackWordTokens(value);
    }
  }

  const wordKey = (value) => String(value || '').trim().toLowerCase();

  function buildWordLookup(cards) {
    const lookup = new Map();
    for (const card of cards || []) {
      if (card?.deck !== 'Words' || typeof card.front !== 'string' || !card.front.trim()) continue;
      const values = [card.front, ...(Array.isArray(card.forms) ? card.forms : [])];
      for (const value of values) {
        const key = wordKey(value);
        if (key && !lookup.has(key)) lookup.set(key, card);
      }
    }
    return lookup;
  }

  function articleCoverage(content, cardsOrLookup) {
    const lookup = cardsOrLookup instanceof Map ? cardsOrLookup : buildWordLookup(cardsOrLookup);
    const tokens = wordTokens(content);
    const matched = tokens.reduce((count, token) => count + (lookup.has(wordKey(token.text)) ? 1 : 0), 0);
    return { total: tokens.length, matched, percent: tokens.length ? Math.round((matched / tokens.length) * 100) : 0 };
  }

  function normalizeUnknownWords(words) {
    return [...new Set(Array.from(words || []).map(wordKey).filter(Boolean))];
  }

  function recognitionRate(content, unknownWords) {
    const unknown = new Set(normalizeUnknownWords(unknownWords));
    const tokens = wordTokens(content);
    const unknownTokens = tokens.reduce((count, token) => count + (unknown.has(wordKey(token.text)) ? 1 : 0), 0);
    const percent = tokens.length
      ? Math.round((1 - (unknownTokens / tokens.length)) * 1000) / 10
      : 100;
    return { total: tokens.length, unknownTokens, percent };
  }

  function analyzeArticle(content) {
    let sentenceIndex = 0;
    const paragraphs = splitParagraphs(content).map((text) => ({
      text,
      sentences: splitSentences(text).map((sentence) => ({ text: sentence, index: sentenceIndex++ })),
    }));
    return { paragraphs, sentenceCount: sentenceIndex, wordCount: wordTokens(content).length };
  }

  function normalizeProgress(sentenceIndex, percent) {
    const index = Number.isFinite(Number(sentenceIndex)) ? Math.max(0, Math.floor(Number(sentenceIndex))) : 0;
    const value = Number.isFinite(Number(percent)) ? Math.min(100, Math.max(0, Math.round(Number(percent)))) : 0;
    return { progressSentenceIndex: index, progressPercent: value };
  }

  function sentenceExists(cards, text) {
    const front = String(text || '').trim();
    return Boolean(front) && (cards || []).some((card) => card.deck === 'Sentences'
      && typeof card.front === 'string' && card.front.trim() === front);
  }

  const FlashArticleUtils = {
    normalizeContent, normalizeArticleInput, splitParagraphs, splitSentences,
    wordTokens, wordKey, buildWordLookup, articleCoverage, analyzeArticle,
    normalizeUnknownWords, recognitionRate, normalizeProgress, sentenceExists,
  };
  if (typeof window !== 'undefined') window.FlashArticleUtils = FlashArticleUtils;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlashArticleUtils;
})();

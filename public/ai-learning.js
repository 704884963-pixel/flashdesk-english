// Pure helpers for AI-assisted learning. No storage or network side effects.

((global, FlashLogic) => {
  const wordKey = (value) => String(value || '').trim().toLowerCase();

  function normalizeRecentGenerations(value) {
    const generations = Array.isArray(value?.generations) ? value.generations : [];
    return { generations: generations.slice(-10).map((item) => ({
      type: item?.type === 'article' ? 'article' : 'sentences',
      targetWords: [...new Set((Array.isArray(item?.targetWords) ? item.targetWords : []).map(wordKey).filter(Boolean))],
      createdAt: typeof item?.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    })) };
  }

  function recordAiGeneration(history, generation) {
    const current = normalizeRecentGenerations(history).generations;
    current.push({
      type: generation?.type === 'article' ? 'article' : 'sentences',
      targetWords: [...new Set((generation?.targetWords || []).map(wordKey).filter(Boolean))],
      createdAt: generation?.createdAt || new Date().toISOString(),
    });
    return { generations: current.slice(-10) };
  }

  function sentenceTargetCount(value = 5) {
    return Math.max(4, Math.min(6, Math.floor(Number(value) || 5)));
  }

  function articleTargetCount(value = 3) {
    return Math.max(1, Math.min(3, Math.floor(Number(value) || 3)));
  }

  function sentencePracticeTargets(targets) {
    return (targets || []).slice(0, 2).map((target, index) => ({
      ...target,
      role: index === 0 ? 'primary' : 'secondary',
    }));
  }

  function articlePracticeTargets(targets) {
    return (targets || []).slice(0, 3).map((target, index) => ({
      ...target,
      role: index === 0 ? 'primary' : 'secondary',
    }));
  }

  function sentenceHistoryTargets(usedWords, practiceTargets) {
    const used = [...new Set((usedWords || []).map((word) => String(word || '').trim()).filter(Boolean))];
    if (!used.length) return (practiceTargets || []).map((target) => target.front).filter(Boolean);
    const primaryKey = wordKey(practiceTargets?.[0]?.front);
    if (!primaryKey) return used;
    return [...used.filter((word) => wordKey(word) === primaryKey), ...used.filter((word) => wordKey(word) !== primaryKey)];
  }

  function latestSentenceTargetWords(history) {
    const generations = normalizeRecentGenerations(history).generations;
    return [...generations].reverse().find((item) => item.type === 'sentences')?.targetWords || [];
  }

  function latestSentencePrimaryTarget(history) {
    return latestSentenceTargetWords(history)[0] || '';
  }

  function selectAiTargetWords({ cards, recentAiTargets, preferredWords = [], count = 8, now = Date.now() }) {
    const limit = Math.max(0, Math.min(20, Math.floor(Number(count) || 0)));
    const recent = normalizeRecentGenerations({ generations: recentAiTargets || [] }).generations.slice(-3);
    const recentCounts = new Map();
    recent.forEach((entry) => entry.targetWords.forEach((word) => recentCounts.set(word, (recentCounts.get(word) || 0) + 1)));
    const preferred = new Set((preferredWords || []).map(wordKey).filter(Boolean));
    const seen = new Set();
    const candidates = [];
    for (const card of cards || []) {
      if (card?.deck !== 'Words' || typeof card.front !== 'string' || !card.front.trim()) continue;
      const key = wordKey(card.front);
      if (seen.has(key)) continue;
      seen.add(key);
      const lapses = Math.max(0, Number(card.lapses) || 0);
      const streak = Math.max(0, Number(card.streak) || 0);
      const due = Number(card.due) || 0;
      let reason = 'other'; let base = 200;
      if (FlashLogic.isWeakCard(card)) { reason = 'lapsed'; base = 500 + Math.min(lapses, 20); }
      else if (streak === 0) { reason = 'new'; base = 400; }
      else if (due <= now) { reason = 'due'; base = 300 + Math.min(50, Math.floor((now - due) / 86400000)); }
      else if (streak >= 3) { reason = 'mastered'; base = 100 - Math.min(streak, 20); }
      const recentPenalty = (recentCounts.get(key) || 0) * 260;
      const preferredBonus = preferred.has(key) ? 260 : 0;
      candidates.push({ card, key, reason, score: base - recentPenalty + preferredBonus });
    }
    const sort = (items) => [...items].sort((a, b) => b.score - a.score
      || (Number(a.card.wordNumber) || Number.MAX_SAFE_INTEGER) - (Number(b.card.wordNumber) || Number.MAX_SAFE_INTEGER)
      || a.key.localeCompare(b.key));
    const picked = [];
    const take = (reason, max) => {
      for (const item of sort(candidates.filter((entry) => entry.reason === reason))) {
        if (picked.length >= limit || picked.filter((entry) => entry.reason === reason).length >= max) break;
        if (!picked.includes(item)) picked.push(item);
      }
    };
    take('lapsed', 2); take('new', 3); take('due', 2);
    for (const item of sort(candidates)) {
      if (picked.length >= limit) break;
      if (!picked.includes(item)) picked.push(item);
    }
    return picked.map(({ card, reason }) => ({
      front: card.front.trim(),
      back: typeof card.back === 'string' ? card.back.trim() : '',
      forms: [...new Set((Array.isArray(card.forms) ? card.forms : []).filter((form) => typeof form === 'string').map((form) => form.trim()).filter(Boolean))],
      reason,
    }));
  }

  function knownWordSample(cards, targets, count = 20) {
    const targetKeys = new Set((targets || []).map((item) => wordKey(item.front)));
    return [...new Set((cards || []).filter((card) => card?.deck === 'Words'
      && Number(card.streak) >= 2 && !FlashLogic.isWeakCard(card))
      .map((card) => String(card.front || '').trim()).filter((front) => front && !targetKeys.has(wordKey(front))))].slice(0, count);
  }

  function buildAiContext({ cards, targetWords, unknownWords, topic, difficulty }) {
    return {
      targetWords: (targetWords || []).map(({ front, back, forms, reason, role }) => ({ front, back, forms, reason, ...(role ? { role } : {}) })),
      unknownWords: [...new Set(Array.from(unknownWords || []).map(wordKey).filter(Boolean))].slice(0, 50),
      knownWordSample: knownWordSample(cards, targetWords, 20),
      ...(topic ? { topic } : {}),
      ...(difficulty ? { difficulty } : {}),
    };
  }

  function buildAiRequest(task, context, options = {}) {
    if (!['generate_sentences', 'generate_article', 'translate_article', 'lookup_word'].includes(task)) throw new Error('unknown AI task');
    return { task, context, options };
  }

  function buildArticleTranslationRequest(title, paragraphs) {
    const articleTitle = String(title || '').trim();
    const articleParagraphs = Array.isArray(paragraphs) ? paragraphs.map((paragraph) => String(paragraph || '').trim()) : [];
    if (!articleTitle || !articleParagraphs.length || articleParagraphs.some((paragraph) => !paragraph)) {
      throw new Error('article title and paragraphs are required');
    }
    return buildAiRequest('translate_article', { title: articleTitle, paragraphs: articleParagraphs });
  }

  function lookupCacheKey(word, sentence) {
    return `${wordKey(word)}\n${String(sentence || '').trim()}`;
  }

  function buildLookupWordRequest(word, sentence) {
    const normalizedWord = String(word || '').trim();
    const normalizedSentence = String(sentence || '').trim();
    if (!normalizedWord || !normalizedSentence) throw new Error('word and sentence are required');
    return buildAiRequest('lookup_word', { word: normalizedWord, sentence: normalizedSentence });
  }

  function wordDraftFromLookup(clickedWord, result) {
    const clicked = String(clickedWord || '').trim();
    const front = String(result?.baseForm || '').trim() || clicked;
    return {
      front,
      back: String(result?.meaningZh || '').trim(),
      memoryReading: String(result?.memoryReading || '').trim(),
      chineseReading: String(result?.chineseReading || '').trim(),
      forms: clicked && wordKey(clicked) !== wordKey(front) ? [clicked] : [],
    };
  }

  const api = {
    wordKey, normalizeRecentGenerations, recordAiGeneration, selectAiTargetWords,
    sentenceTargetCount, articleTargetCount, sentencePracticeTargets, articlePracticeTargets, sentenceHistoryTargets,
    latestSentenceTargetWords, latestSentencePrimaryTarget,
    knownWordSample, buildAiContext, buildAiRequest, buildArticleTranslationRequest, lookupCacheKey,
    buildLookupWordRequest, wordDraftFromLookup,
  };
  global.FlashAiLearning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis,
  typeof module !== 'undefined' && module.exports ? require('./logic.js') : globalThis.FlashLogic);

// Pure helpers for AI-assisted learning. No storage or network side effects.

((global, FlashLogic) => {
  const wordKey = (value) => String(value || '').trim().toLowerCase();

  function normalizeRecentGenerations(value) {
    const generations = Array.isArray(value?.generations) ? value.generations : [];
    return { generations: generations.slice(-10).map((item) => ({
      type: item?.type === 'article' ? 'article' : 'sentences',
      targetWords: [...new Set((Array.isArray(item?.targetWords) ? item.targetWords : []).map(wordKey).filter(Boolean))],
      // `primary` is the word the learner actually focused on. Older records
      // predate the field; for sentences the first history word is the primary.
      primary: wordKey(item?.primary) || (item?.type === 'article' ? '' : wordKey((Array.isArray(item?.targetWords) ? item.targetWords : [])[0])),
      createdAt: typeof item?.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    })) };
  }

  function recordAiGeneration(history, generation) {
    const current = normalizeRecentGenerations(history).generations;
    const type = generation?.type === 'article' ? 'article' : 'sentences';
    const words = [...new Set((generation?.targetWords || []).map(wordKey).filter(Boolean))];
    current.push({
      type,
      targetWords: words,
      primary: wordKey(generation?.primary) || (type === 'sentences' ? (words[0] || '') : ''),
      createdAt: generation?.createdAt || new Date().toISOString(),
    });
    return { generations: current.slice(-10) };
  }

  function sentenceTargetCount(value = 5) {
    return Math.max(4, Math.min(6, Math.floor(Number(value) || 5)));
  }

  // Today Article now teaches three focus words by default and never more than
  // four, so a level below CET-4 is not forced to juggle five at once.
  function articleTargetCount(value = 3) {
    return Math.max(1, Math.min(4, Math.floor(Number(value) || 3)));
  }

  const SENTENCE_PRIMARY_COOLDOWN = 1; // the newest finished rounds that cannot be primary again
  const SENTENCE_PRIMARY_COOLDOWN_PENALTY = 400; // > any base score: fully out of the way, never banned
  const SENTENCE_PRIMARY_RECENT_WINDOW = 3; // how many recent primaries are demoted
  const SENTENCE_PRIMARY_RECENT_PENALTY = 90;
  const SECONDARY_RECENT_WINDOW = 3;
  const ARTICLE_TECH_PATTERNS = [
    /\b(ai|a\.i\.|algorithm|artificial intelligence|automation|bot|chatbot|cloud|code|coding|compute|computer|data|database|dataset|deep learning|device|digital|embedding|engineer|engineering|gpu|hardware|inference|internet|javascript|language model|machine|machine learning|model|network|neural|neuron|online|parameter|platform|program|programmer|programming|prompt|python|robot|script|server|software|startup|system|tech|technical|technology|token|tool|transformer|virtual|website)\b/,
    /(人工智能|算法|技术)/,
  ];

  function isTechnicalTarget(target) {
    const text = `${target?.front || ''} ${target?.back || ''}`.toLowerCase();
    return ARTICLE_TECH_PATTERNS.some((pattern) => pattern.test(text));
  }

  function sentencePracticeTargets(targets) {
    return (targets || []).slice(0, 2).map((target, index) => ({
      ...target,
      role: index === 0 ? 'primary' : 'secondary',
    }));
  }

  function articlePracticeTargets(targets) {
    return (targets || []).slice(0, 4).map((target, index) => ({
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
    const generations = normalizeRecentGenerations(history).generations;
    const latest = [...generations].reverse().find((item) => item.type === 'sentences');
    return latest?.primary || latest?.targetWords?.[0] || '';
  }

  // Recent history is reused in place of a new store: one entry per finished
  // round lets the selector cool a primary down without ever banning it.
  function recentHistory(generations, type) {
    const all = normalizeRecentGenerations({ generations: generations || [] }).generations;
    const filtered = all.filter((entry) => entry.type === type);
    return { all, filtered, newestFirst: [...filtered].reverse() };
  }

  // A word that keeps showing up — as primary or as secondary — loses weight
  // with an escalating penalty, so the third appearance in a row costs far more
  // than the first. `window` is how many recent rounds are inspected and
  // `decay` how fast older rounds are forgiven.
  function recurrence(chronicles, count, window, decay) {
    let penalty = 0;
    chronicles.slice(0, window).forEach((targetWords, depth) => {
      if (targetWords.includes(count.key)) penalty += 90 * (decay ** depth);
    });
    if (count.primaryRole) penalty += 70;
    return penalty;
  }

  function filterCandidates(cards) {
    const seen = new Set();
    const candidates = [];
    for (const card of cards || []) {
      if (card?.deck !== 'Words' || typeof card.front !== 'string' || !card.front.trim()) continue;
      const key = wordKey(card.front);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ card, key });
    }
    return candidates;
  }

  function sortCandidates(items) {
    return [...items].sort((a, b) => b.score - a.score
      || (Number(a.card.wordNumber) || Number.MAX_SAFE_INTEGER) - (Number(b.card.wordNumber) || Number.MAX_SAFE_INTEGER)
      || a.key.localeCompare(b.key));
  }

  // Overall priority is unchanged: lapsed → new → due → long-unpractised →
  // ordinary → mastered. Cooldowns and rotation only shift the score INSIDE
  // that ladder, so a category never overtakes a stronger one. Even an active
  // primary cooldown (-100) cannot drop a new word (400→300) below an ordinary
  // one (200), so a stuck new word still leads the pool — it just rotates with
  // its peers instead of winning three rounds in a row.
  function sentenceCandidates({ cards, past, now }) {
    const primaryChronicles = past.newestFirst.map((entry) => [entry.primary].filter(Boolean));
    const secondaryChronicles = past.newestFirst.map((entry) => entry.targetWords.slice(1));
    const cooldownKeys = new Set(past.newestFirst.slice(0, SENTENCE_PRIMARY_COOLDOWN).map((entry) => entry.primary).filter(Boolean));
    const items = [];
    for (const { card, key } of filterCandidates(cards)) {
      const lapses = Math.max(0, Number(card.lapses) || 0);
      const streak = Math.max(0, Number(card.streak) || 0);
      const due = Number(card.due) || 0;
      let reason = 'other'; let base = 200;
      if (FlashLogic.isWeakCard(card)) { reason = 'lapsed'; base = 500 + Math.min(lapses, 20); }
      else if (streak === 0) { reason = 'new'; base = 400; }
      else if (due <= now) { reason = 'due'; base = 300 + Math.min(50, Math.floor((now - due) / 86400000)); }
      else if (streak >= 3) { reason = 'mastered'; base = 100 - Math.min(streak, 20); }
      const item = { card, key, reason, score: base };
      item.primaryPenalty = recurrence(primaryChronicles, { key, primaryRole: true }, SENTENCE_PRIMARY_RECENT_WINDOW + 1, 0.65);
      item.secondaryPenalty = recurrence(secondaryChronicles, { key, primaryRole: false }, SECONDARY_RECENT_WINDOW, 1);
      items.push(item);
    }
    return { items, cooldownKeys };
  }

  function sentenceTargetCountFor({ cards, selectedKeys = new Set() } = {}) {
    const remaining = filterCandidates(cards).filter((entry) => !selectedKeys.has(entry.key)).length;
    return Math.max(0, Math.min(1, remaining));
  }

  function sentencePracticeSelection({ cards, history, recentAiTargets, preferredWords = [], now = Date.now(), today = {} } = {}) {
    const entries = recentAiTargets || history?.generations || [];
    const past = recentHistory(entries, 'sentences');
    const { items, cooldownKeys } = sentenceCandidates({ cards, past, now });
    const lastPrimary = past.newestFirst[0]?.primary || '';
    const lastSecondary = today?.lastSecondary || '';
    const lastSecondaryCombo = today?.lastSecondaryCombo || '';
    // Primary: the newest primary is skipped outright, the ones just behind it
    // are demoted by an escalating penalty, and the cooldown window adds one
    // more notch. Nothing is ever removed from the pool: when every candidate
    // is cooling down the filters fall through and a word may lead again.
    const primaryScore = (item) => item.score - item.primaryPenalty - (cooldownKeys.has(item.key) ? 100 : 0);
    const primaryRank = (candidates) => [...candidates].sort((a, b) => primaryScore(b) - primaryScore(a)
      || (Number(a.card.wordNumber) || Number.MAX_SAFE_INTEGER) - (Number(b.card.wordNumber) || Number.MAX_SAFE_INTEGER)
      || a.key.localeCompare(b.key));
    const pool = items.filter((item) => item.key !== lastPrimary);
    const primary = primaryRank(pool.filter((item) => !cooldownKeys.has(item.key)))[0] || primaryRank(pool)[0] || null;
    // Secondary: never a repeat of the primary just chosen, the previous
    // secondary, or the previous primary, so "primary + secondary" keeps
    // moving instead of freezing into one pair.
    const secondaryScore = (item) => item.score - item.secondaryPenalty;
    const secondaryRank = (candidates) => [...candidates].sort((a, b) => secondaryScore(b) - secondaryScore(a)
      || (Number(a.card.wordNumber) || Number.MAX_SAFE_INTEGER) - (Number(b.card.wordNumber) || Number.MAX_SAFE_INTEGER)
      || a.key.localeCompare(b.key));
    const secondaryPool = items.filter((item) => item.key !== primary?.key);
    const secondary = secondaryRank(secondaryPool.filter((item) => item.key !== lastSecondary
      && item.key !== lastPrimary && item.key !== lastSecondaryCombo.split('+')[0]))[0]
      || secondaryRank(secondaryPool.filter((item) => item.key !== lastSecondary))[0]
      || secondaryRank(secondaryPool)[0] || null;
    const chosen = [primary, secondary].filter(Boolean);
    const practice = chosen.map((item, index) => ({
      front: item.card.front.trim(),
      back: typeof item.card.back === 'string' ? item.card.back.trim() : '',
      reason: item.reason,
      role: index === 0 ? 'primary' : 'secondary',
    }));
    return { practice, candidateCount: sentenceTargetCountFor({ cards, selectedKeys: new Set(chosen.map((item) => item.key)) }) };
  }

  function comboKey(primary, secondary) {
    return primary && secondary ? `${primary}+${secondary}` : '';
  }

  // Today Article focus words stay rare for a while after they led a round, so
  // the article reinforces words instead of repeating itself.
  const ARTICLE_PRIMARY_RECENT_PENALTY = 130;
  const ARTICLE_RECENT_FOCUS_PENALTY = 90;

  function selectAiTargetWords({ cards, recentAiTargets, preferredWords = [], count = 8, now = Date.now() }) {
    const limit = Math.max(0, Math.min(20, Math.floor(Number(count) || 0)));
    const recent = normalizeRecentGenerations({ generations: recentAiTargets || [] }).generations.slice(-3);
    const recentCounts = new Map();
    recent.forEach((entry) => entry.targetWords.forEach((word) => recentCounts.set(word, (recentCounts.get(word) || 0) + 1)));
    const preferred = new Set((preferredWords || []).map(wordKey).filter(Boolean));
    const candidates = [];
    for (const { card, key } of filterCandidates(cards)) {
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
    const sort = (items) => sortCandidates(items);
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

  // Focus words for Today Article. Three by default, four at most. The running
  // order is: the latest Sentence primary (to meet it again in reading), then
  // exactly one weak-or-new word, then one due / long-unpractised / ordinary
  // word, then — only when the other slots could not fill — one more from the
  // remaining priority pool.
  //
  // With an automatic everyday topic the pool may contribute at most ONE
  // AI / programming word. A technical word that has no natural place in a
  // daily-life article is skipped this round instead of dragging the whole
  // article into a tech theme; choosing a technical topic explicitly lifts the
  // cap. Displays only the chosen focus words, never the candidate pool.
  function selectArticleFocusWords({ targets, recentAiTargets, topic = 'auto', articlePrimary = '', count = articleTargetCount() } = {}) {
    const limit = Math.max(1, Math.min(4, Math.floor(Number(count) || 3)));
    const articleHistory = recentHistory(recentAiTargets, 'article');
    const sentenceHistory = recentHistory(recentAiTargets, 'sentences');
    const technicalAllowed = topic === 'ai-tech';
    const recentFocus = new Set(sentenceHistory.newestFirst.slice(0, 2)
      .flatMap((entry) => entry.targetWords)
      .filter((word) => word !== sentenceHistory.newestFirst[0]?.primary));
    articleHistory.newestFirst.slice(0, 2).forEach((entry) => entry.targetWords.forEach((word) => recentFocus.add(word)));
    const recentPrimaryKeys = new Set([...articleHistory.newestFirst.slice(0, 2), ...sentenceHistory.newestFirst.slice(0, 1)]
      .map((entry) => entry.primary).filter(Boolean));
    const pool = filterCandidates((targets || []).map((target) => ({ deck: 'Words', ...target })));
    const used = new Set();
    const focus = [];
    let technicalCount = 0;
    const take = (item, role) => {
      if (!item || used.has(item.key) || focus.length >= limit) return null;
      const technical = isTechnicalTarget(item.card);
      if (technical && !technicalAllowed && technicalCount >= 1) return null;
      used.add(item.key);
      if (technical) technicalCount += 1;
      const entry = { ...item, role, technical };
      focus.push(entry);
      return entry;
    };
    const byScore = (candidates) => sortCandidates(candidates.filter((item) => !used.has(item.key)))
      .sort((a, b) => focusPenalty(a) - focusPenalty(b));
    const focusPenalty = (item) => (recentFocus.has(item.key) ? ARTICLE_RECENT_FOCUS_PENALTY : 0)
      + (recentPrimaryKeys.has(item.key) ? ARTICLE_PRIMARY_RECENT_PENALTY : 0);
    // 1. Latest Sentence primary — a preference, not a hard dependency.
    const preferredPrimary = wordKey(articlePrimary) || sentenceHistory.newestFirst[0]?.primary || '';
    if (preferredPrimary) take(pool.find((item) => item.key === preferredPrimary), 'primary');
    // 2. One weak or new word.
    take(byScore(pool.filter((item) => item.reason === 'lapsed' || item.reason === 'new'))[0], 'secondary');
    // 3. One due / long-unpractised / ordinary word.
    take(byScore(pool.filter((item) => ['due', 'other'].includes(item.reason)))[0], 'secondary');
    // 4. Backfill only what is still missing. A fourth slot is filled from the
    // remaining non-technical pool first: with an automatic everyday topic the
    // technical word is the one that waits, so a tech-heavy library cannot pull
    // the whole article back into a technical theme.
    const remaining = pool.filter((item) => !used.has(item.key));
    const everydayFirst = technicalAllowed ? remaining : [...remaining].sort((a, b) => Number(isTechnicalTarget(a.card)) - Number(isTechnicalTarget(b.card)));
    const backfill = technicalAllowed ? byScore(remaining) : [...byScore(everydayFirst.filter((item) => !isTechnicalTarget(item.card))), ...byScore(everydayFirst.filter((item) => isTechnicalTarget(item.card)))];
    for (const item of backfill) {
      if (focus.length >= limit) break;
      take(item, 'secondary');
    }
    return focus.map(({ card, key, reason, role, technical }) => ({
      front: card.front.trim(),
      back: typeof card.back === 'string' ? card.back.trim() : '',
      forms: [...new Set((Array.isArray(card.forms) ? card.forms : []).filter((form) => typeof form === 'string').map((form) => form.trim()).filter(Boolean))],
      reason,
      role,
      ...(technical ? { technical: true } : {}),
    }));
  }

  const api = {
    wordKey, normalizeRecentGenerations, recordAiGeneration, selectAiTargetWords,
    sentenceTargetCount, articleTargetCount, sentencePracticeTargets, articlePracticeTargets, sentenceHistoryTargets,
    latestSentenceTargetWords, latestSentencePrimaryTarget,
    sentencePracticeSelection, selectArticleFocusWords, isTechnicalTarget,
    knownWordSample, buildAiContext, buildAiRequest, buildArticleTranslationRequest, lookupCacheKey,
    buildLookupWordRequest, wordDraftFromLookup,
  };
  global.FlashAiLearning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis,
  typeof module !== 'undefined' && module.exports ? require('./logic.js') : globalThis.FlashLogic);

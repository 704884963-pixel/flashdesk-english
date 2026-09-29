// FlashDesk shared pure logic — review queues and quiz-distractor similarity. Plain script: attaches
// window.FlashLogic in the browser, module.exports under node --test.

(() => {
  const norm = (s) => String(s).trim().toLowerCase();
  const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30, 60, 120, 240, 365];
  const REVIEW_DAY_MS = 24 * 60 * 60 * 1000;

  // Legacy cards used streak as both the correctness counter and interval
  // index. Keep them readable without migrating the dataset; the first real
  // grade naturally writes the independent reviewStep field.
  function effectiveReviewStep(card) {
    const stored = Number(card?.reviewStep);
    if (Number.isInteger(stored) && stored >= 0 && stored < REVIEW_INTERVAL_DAYS.length) return stored;
    const streak = Math.max(0, Math.floor(Number(card?.streak) || 0));
    return Math.min(Math.max(streak - 1, 0), 5);
  }

  function gradeReviewCard(card, grade, now = Date.now()) {
    const currentStep = effectiveReviewStep(card);
    if (grade === 'again') {
      card.due = now + 10 * 60 * 1000;
      card.streak = 0;
      card.lapses = Math.max(0, Number(card.lapses) || 0) + 1;
      card.reviewStep = 0;
      return card;
    }
    if (grade !== 'got' && grade !== 'easy') throw new Error('grade must be "again", "got" or "easy"');
    const streak = Math.max(0, Math.floor(Number(card.streak) || 0));
    card.streak = streak + 1;
    if (grade === 'easy') card.reviewStep = currentStep < 3 ? 3 : Math.min(currentStep + 1, REVIEW_INTERVAL_DAYS.length - 1);
    else card.reviewStep = streak === 0 ? 0 : Math.min(currentStep + 1, REVIEW_INTERVAL_DAYS.length - 1);
    card.due = now + REVIEW_INTERVAL_DAYS[card.reviewStep] * REVIEW_DAY_MS;
    return card;
  }
  // Every due entity is an independent review item. Cards whose front/back are
  // reversed are still separate cards and must each be shown and graded.
  function reviewQueue(cards, now) {
    return cards
      .filter((card) => Number(card.due) <= now)
      .sort((a, b) => Number(a.due) - Number(b.due))
      .map((card) => card.id);
  }

  const STOP = new Set([
    'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'that', 'this',
    'is', 'are', 'was', 'with', 'on', 'from', 'by', 'as', 'it', 'its',
    'into', 'not', 'no', 'be', 'vs', 'what', 'which', 'name', 'your', 'you',
  ]);

  function tokens(text) {
    return new Set(
      String(text).toLowerCase().split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
    );
  }

  // Word-overlap (Jaccard) similarity over term+definition text of quiz pool
  // items {cardId, term, definition}. 0 when nothing overlaps. Small bonus
  // for close definition lengths so "the longest answer" stops being a tell.
  function similarity(a, b) {
    const A = tokens(a.term + ' ' + a.definition);
    const B = tokens(b.term + ' ' + b.definition);
    let inter = 0;
    for (const w of A) if (B.has(w)) inter += 1;
    if (!inter) return 0;
    const jaccard = inter / (A.size + B.size - inter);
    const lenRatio = Math.min(a.definition.length, b.definition.length)
      / Math.max(a.definition.length, b.definition.length, 1);
    return jaccard + 0.1 * lenRatio;
  }

  // Top-n most similar pool items to `item`, excluding item itself,
  // duplicate/identical definitions, and any candidate that NAMES the asked
  // term — a vocab deck plus scenario cards about the same fact would
  // otherwise put a second correct answer on screen. Best first.
  function rankDistractors(pool, item, n) {
    const seenDefs = new Set([item.definition]);
    const itemTerm = norm(item.term);
    // Either term containing the other means both cards describe the same
    // fact — offering one against the other puts two correct answers on
    // screen. Definitions naming the asked term are the same hazard.
    const namesTerm = (p) => {
      const pTerm = norm(p.term);
      if (itemTerm.length > 3 && (pTerm.includes(itemTerm) || norm(p.definition).includes(itemTerm))) return true;
      return pTerm.length > 3 && itemTerm.includes(pTerm);
    };
    return pool
      .filter((p) => {
        if (p.cardId === item.cardId || seenDefs.has(p.definition)) return false;
        if (namesTerm(p)) return false;
        seenDefs.add(p.definition);
        return true;
      })
      .map((p) => ({ p, score: similarity(item, p) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, n)
      .map((x) => x.p);
  }

  function shuffleArr(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // "Around the same length": both short (a keyword next to a keyword), or
  // within roughly 2x of each other. Anything else is a length tell.
  const SHORT = 45;
  function lengthCompatible(a, b) {
    if (a.length <= SHORT && b.length <= SHORT) return true;
    return Math.min(a.length, b.length) / Math.max(a.length, b.length, 1) >= 0.45;
  }

  // n distractor texts for a quiz question about `item`. side picks which
  // text the choices show: 'definition' (keyword-mode) or 'term'
  // (definition-mode). Priority: similar topic + similar length, then
  // similar length anywhere in the pool, then similar topic any length,
  // then anything — a length tell defeats the question outright, an
  // off-topic option only weakens it; a full row beats a uniform one.
  function buildChoices(pool, item, side, n) {
    const count = n || 3;
    const correct = side === 'term' ? item.term : item.definition;
    const textOf = (p) => (side === 'term' ? p.term : p.definition);
    const used = new Set([correct]);
    const chosen = [];
    const take = (candidates, requireLength) => {
      for (const p of candidates) {
        if (chosen.length >= count) return;
        const t = textOf(p);
        if (used.has(t)) continue;
        if (requireLength && !lengthCompatible(t, correct)) continue;
        used.add(t);
        chosen.push(t);
      }
    };
    const ranked = shuffleArr(rankDistractors(pool, item, 8));
    const rest = shuffleArr(pool.filter((p) => p.cardId !== item.cardId));
    take(ranked, true);
    take(rest, true);
    take(ranked, false);
    take(rest, false);
    return chosen;
  }

  /* ---------- Word detection (Quiz v0.7) ---------- */

  const WORD_QUIZ_TYPES = ['zh-en', 'en-zh', 'audio-en'];

  // `lapses` is lifetime history. A card is currently weak only while the
  // latest review streak has not recovered from that history.
  function isWeakCard(card) {
    return Math.max(0, Number(card?.lapses) || 0) > 0
      && Math.max(0, Number(card?.streak) || 0) === 0;
  }

  function wordQuizPool(cards) {
    return cards.filter((card) => card.deck === 'Words' && String(card.front || '').trim() && String(card.back || '').trim());
  }

  function wordQuizWeight(card, scope, now) {
    const lapses = Math.max(0, Number(card.lapses) || 0);
    const streak = Math.max(0, Number(card.streak) || 0);
    const isNew = streak === 0 && lapses === 0;
    const isDue = Number(card.due) <= now;
    const isMastered = streak >= 3;
    const isWeak = isWeakCard(card);
    const smart = isWeak ? 500 + lapses * 20
      : isNew ? 400
        : isDue ? 300
          : isMastered ? 50
            : 150;
    if (scope === 'new') return isNew ? 1000 : smart;
    if (scope === 'lapsed') return isWeak ? 1000 + lapses * 20 : smart;
    if (scope === 'random') return 1;
    return smart;
  }

  function shuffleWith(arr, random) {
    const rand = random || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Priority-based sampling without replacement. Large gaps between category
  // weights keep the requested priority deterministic; `created` and a random
  // tie-break keep cards inside a category from always appearing in one order.
  function selectWordQuizCards(cards, count, scope, now, random) {
    const pool = wordQuizPool(cards);
    const limit = Math.min(Math.max(0, Number(count) || 0), pool.length);
    if (scope === 'random') return shuffleWith(pool, random).slice(0, limit);
    const rand = random || Math.random;
    return pool.map((card) => ({
      card,
      weight: wordQuizWeight(card, scope, now),
      created: Number(card.created) || 0,
      tie: rand(),
    })).sort((a, b) => b.weight - a.weight || b.created - a.created || b.tie - a.tie)
      .slice(0, limit)
      .map((entry) => entry.card);
  }

  function quizChoiceText(card, type) {
    return type === 'en-zh' ? String(card.back).trim() : String(card.front).trim();
  }

  function wordNumberDistance(a, b) {
    const x = Number(a.wordNumber);
    const y = Number(b.wordNumber);
    return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) : 999;
  }

  function quizDistractorScore(candidate, item, type) {
    const a = quizChoiceText(candidate, type);
    const b = quizChoiceText(item, type);
    const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length, 1);
    const nearby = 1 / (1 + wordNumberDistance(candidate, item));
    const mappedA = { term: candidate.front, definition: candidate.back };
    const mappedB = { term: item.front, definition: item.back };
    return lengthRatio * 2 + nearby * 3 + similarity(mappedA, mappedB);
  }

  function buildWordQuizChoices(cards, item, type, random) {
    const correct = quizChoiceText(item, type);
    const used = new Set([norm(correct)]);
    const rand = random || Math.random;
    const ranked = wordQuizPool(cards)
      .filter((card) => card.id !== item.id)
      .map((card) => ({ card, score: quizDistractorScore(card, item, type), tie: rand() }))
      .sort((a, b) => b.score - a.score || b.tie - a.tie);
    const distractors = [];
    for (const entry of ranked) {
      const text = quizChoiceText(entry.card, type);
      const keyText = norm(text);
      if (used.has(keyText)) continue;
      used.add(keyText);
      distractors.push(text);
      if (distractors.length === 3) break;
    }
    return shuffleWith([correct, ...distractors], rand);
  }

  function buildWordQuizQuestion(cards, item, type, random) {
    const safeType = WORD_QUIZ_TYPES.includes(type) ? type : 'zh-en';
    return {
      cardId: item.id,
      type: safeType,
      prompt: safeType === 'zh-en' ? item.back : safeType === 'en-zh' ? item.front : '',
      audioText: safeType === 'audio-en' ? item.front : '',
      correct: quizChoiceText(item, safeType),
      choices: buildWordQuizChoices(cards, item, safeType, random),
      retry: false,
    };
  }

  // Cycle through a freshly shuffled copy of the enabled types. This looks
  // mixed in use while preventing long blocks of one question type.
  function mixedWordQuizTypes(enabled, count, random) {
    const types = enabled.filter((type) => WORD_QUIZ_TYPES.includes(type));
    if (!types.length) return [];
    const result = [];
    while (result.length < count) result.push(...shuffleWith(types, random));
    return result.slice(0, count);
  }

  function alternateWordQuizType(previous, enabled, random) {
    const alternatives = enabled.filter((type) => WORD_QUIZ_TYPES.includes(type) && type !== previous);
    if (!alternatives.length) return previous;
    return shuffleWith(alternatives, random)[0];
  }

  function insertWordQuizRetry(questions, currentIndex, retryQuestion, gap) {
    const copy = questions.slice();
    const otherQuestions = Math.max(3, Math.min(5, Number(gap) || 4));
    const at = Math.min(copy.length, currentIndex + otherQuestions + 1);
    copy.splice(at, 0, retryQuestion);
    return copy;
  }

  function wordQuizResult(correct, total) {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCorrect = Math.max(0, Math.min(safeTotal, Number(correct) || 0));
    return {
      correct: safeCorrect,
      wrong: safeTotal - safeCorrect,
      total: safeTotal,
      percentage: safeTotal ? Math.round((safeCorrect / safeTotal) * 100) : 0,
    };
  }

  const FlashLogic = {
    REVIEW_INTERVAL_DAYS, effectiveReviewStep, gradeReviewCard,
    reviewQueue, similarity, rankDistractors, buildChoices,
    WORD_QUIZ_TYPES, isWeakCard, wordQuizPool, wordQuizWeight, selectWordQuizCards,
    buildWordQuizChoices, buildWordQuizQuestion, mixedWordQuizTypes,
    alternateWordQuizType, insertWordQuizRetry, wordQuizResult,
  };
  if (typeof window !== 'undefined') window.FlashLogic = FlashLogic;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlashLogic;
})();

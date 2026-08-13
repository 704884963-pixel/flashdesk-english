// FlashDesk shared pure logic — reversed-pair detection, review-queue
// collapse, and quiz-distractor similarity. Plain script: attaches
// window.FlashLogic in the browser, module.exports under node --test.

(() => {
  const norm = (s) => String(s).trim().toLowerCase();
  // JSON-array key: unambiguous regardless of characters in card text.
  const key = (deck, a, b) => JSON.stringify([deck, norm(a), norm(b)]);

  // cardId -> twinId for reversed pairs: A.front==B.back && A.back==B.front
  // (trim/case-insensitive), same deck.
  function buildTwinMap(cards) {
    const byKey = new Map();
    for (const c of cards) byKey.set(key(c.deck, c.front, c.back), c.id);
    const twins = new Map();
    for (const c of cards) {
      const twinId = byKey.get(key(c.deck, c.back, c.front));
      if (twinId && twinId !== c.id) twins.set(c.id, twinId);
    }
    return twins;
  }

  // Due card ids with reversed pairs collapsed to one entry, sorted by due.
  // direction: 'keyword' -> the twin with the shorter front shows,
  // 'description' -> the longer front, 'mixed' -> random per pair, memoized
  // in `picks` (caller-owned, mutated) so a session stays stable.
  // A pair is due when EITHER twin is due; it sorts by the earlier due.
  function reviewQueue(cards, now, direction, picks) {
    const twins = buildTwinMap(cards);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const seen = new Set();
    const entries = [];
    for (const c of cards) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const twin = byId.get(twins.get(c.id));
      if (!twin) {
        if (c.due <= now) entries.push({ id: c.id, due: c.due });
        continue;
      }
      seen.add(twin.id);
      const due = Math.min(c.due, twin.due);
      if (due > now) continue;
      let rep;
      if (direction === 'keyword') {
        rep = c.front.length <= twin.front.length ? c : twin;
      } else if (direction === 'description') {
        rep = c.front.length <= twin.front.length ? twin : c;
      } else {
        const pairKey = [c.id, twin.id].sort().join('|');
        if (!picks[pairKey]) picks[pairKey] = Math.random() < 0.5 ? c.id : twin.id;
        rep = byId.get(picks[pairKey]);
      }
      entries.push({ id: rep.id, due });
    }
    return entries.sort((x, y) => x.due - y.due).map((e) => e.id);
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

  const FlashLogic = { buildTwinMap, reviewQueue, similarity, rankDistractors, buildChoices };
  if (typeof window !== 'undefined') window.FlashLogic = FlashLogic;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlashLogic;
})();

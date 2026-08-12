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
    const namesTerm = (p) => itemTerm.length > 3
      && (norm(p.term).includes(itemTerm) || norm(p.definition).includes(itemTerm));
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

  const FlashLogic = { buildTwinMap, reviewQueue, similarity, rankDistractors };
  if (typeof window !== 'undefined') window.FlashLogic = FlashLogic;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlashLogic;
})();

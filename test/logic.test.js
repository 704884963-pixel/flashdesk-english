const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewQueue, similarity, rankDistractors, buildChoices, isWeakCard,
  effectiveReviewStep, gradeReviewCard, REVIEW_INTERVAL_DAYS } = require('../public/logic.js');

const card = (id, front, back, due = 0, deck = 'D') => ({ id, front, back, due, deck });

const pairA = () => card('a', 'Transparency', 'Understand how the system works', 0);
const pairB = () => card('b', 'Understand how the system works', 'Transparency', 0);

test('current weak status requires historical lapses and a zero streak', () => {
  assert.equal(isWeakCard({ lapses: 1, streak: 0 }), true);
  assert.equal(isWeakCard({ lapses: 1, streak: 1 }), false);
  assert.equal(isWeakCard({ lapses: 3, streak: 2 }), false);
  assert.equal(isWeakCard({ lapses: 0, streak: 0 }), false);
});

test('legacy streak maps to the old 1/3/7/14/30/60-day review steps', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 12].map((streak) => effectiveReviewStep({ streak })), [0, 0, 1, 2, 3, 4, 5, 5]);
  assert.equal(effectiveReviewStep({ streak: 1, reviewStep: 7 }), 7);
});

test('ordinary remember advances streak and reviewStep through the long ladder', () => {
  const day = 86400000;
  const card = { streak: 0, lapses: 0, due: 0 };
  gradeReviewCard(card, 'got', 1000);
  assert.deepEqual({ streak: card.streak, step: card.reviewStep, due: card.due }, { streak: 1, step: 0, due: 1000 + day });
  gradeReviewCard(card, 'got', 2000);
  assert.deepEqual({ streak: card.streak, step: card.reviewStep, due: card.due }, { streak: 2, step: 1, due: 2000 + 3 * day });
  gradeReviewCard(card, 'got', 3000);
  assert.deepEqual({ streak: card.streak, step: card.reviewStep, due: card.due }, { streak: 3, step: 2, due: 3000 + 7 * day });
  assert.equal(card.streak >= 3, true);
});

test('easy skips early steps, increments streak once and never increases lapses', () => {
  const day = 86400000;
  const cases = [
    [{ streak: 0 }, 1, 3, 14],
    [{ streak: 1 }, 2, 3, 14],
    [{ streak: 2 }, 3, 3, 14],
    [{ streak: 3 }, 4, 3, 14],
    [{ streak: 4 }, 5, 4, 30],
    [{ streak: 5 }, 6, 5, 60],
    [{ streak: 6 }, 7, 6, 120],
    [{ streak: 7, reviewStep: 6 }, 8, 7, 240],
    [{ streak: 8, reviewStep: 7 }, 9, 8, 365],
    [{ streak: 9, reviewStep: 8 }, 10, 8, 365],
  ];
  for (const [fields, streak, step, days] of cases) {
    const card = { lapses: 2, ...fields };
    gradeReviewCard(card, 'easy', 5000);
    assert.deepEqual({ streak: card.streak, step: card.reviewStep, days: (card.due - 5000) / day, lapses: card.lapses },
      { streak, step, days, lapses: 2 });
  }
  assert.deepEqual(REVIEW_INTERVAL_DAYS, [1, 3, 7, 14, 30, 60, 120, 240, 365]);
});

test('again resets scheduling but keeps weak/new/mastered definitions unchanged', () => {
  const card = { streak: 4, lapses: 1, reviewStep: 5 };
  gradeReviewCard(card, 'again', 9000);
  assert.equal(card.streak, 0);
  assert.equal(card.lapses, 2);
  assert.equal(card.reviewStep, 0);
  assert.equal(card.due, 9000 + 10 * 60 * 1000);
  assert.equal(isWeakCard(card), true);
});

test('reviewQueue keeps both due reversed cards as independent entities', () => {
  assert.deepEqual(reviewQueue([pairA(), pairB()], 1), ['a', 'b']);
});

test('reviewQueue includes only the reversed card that is actually due', () => {
  const a = card('a', 'Transparency', 'Understand how the system works', 999);
  const b = card('b', 'Understand how the system works', 'Transparency', 0);
  assert.deepEqual(reviewQueue([a, b], 1), ['b']);
});

test('Word and Sentence cards keep their authored direction and non-due cards stay out', () => {
  const scenario = card('s', 'A long scenario about predicting chicken demand', 'Regression', 0);
  const sentence = card('sentence', 'A complete sentence.', '一个完整句子。', 0, 'Sentences');
  const notDue = card('n', 'Not due yet', 'Nope', 99);
  assert.deepEqual(reviewQueue([scenario, sentence, notDue], 1), ['s', 'sentence']);
});

test('queue sorts every due entity by its own due time', () => {
  const early = card('e', 'Early single', 'Def', 5);
  const a = card('a', 'Transparency', 'Understand how the system works', 40);
  const b = card('b', 'Understand how the system works', 'Transparency', 10);
  assert.deepEqual(reviewQueue([a, early, b], 50), ['e', 'b', 'a']);
});

test('99 due entities remain 99 queue items even with nine reversed pairs', () => {
  const cards = [];
  for (let i = 0; i < 9; i += 1) {
    cards.push(card(`a${i}`, `term ${i}`, `definition ${i}`, i));
    cards.push(card(`b${i}`, `definition ${i}`, `term ${i}`, i));
  }
  for (let i = 18; i < 99; i += 1) cards.push(card(`c${i}`, `term ${i}`, `definition ${i}`, i));
  assert.equal(reviewQueue(cards, 100).length, 99);
});

const stemming = {
  cardId: '1',
  term: 'Stemming vs lemmatization',
  definition: 'Stemming chops word endings; lemmatization uses linguistic rules to reach a dictionary form',
};
const tokenization = {
  cardId: '2',
  term: 'Tokenization',
  definition: 'Breaking text down into smaller word units for linguistic analysis',
};
const encryption = {
  cardId: '3',
  term: 'Encryption in transit',
  definition: 'Data protected while moving over the network',
};

test('similarity ranks related items above unrelated ones', () => {
  assert.ok(similarity(stemming, tokenization) > similarity(stemming, encryption));
});

test('similarity is 0 when no meaningful tokens overlap', () => {
  assert.equal(similarity(stemming, encryption), 0);
});

test('rankDistractors excludes the item itself and duplicate definitions', () => {
  const dupDef = { cardId: '4', term: 'Tokenizing', definition: tokenization.definition };
  const ranked = rankDistractors([stemming, tokenization, dupDef, encryption], stemming, 6);
  assert.ok(!ranked.some((p) => p.cardId === '1'));
  const defs = ranked.map((p) => p.definition);
  assert.equal(new Set(defs).size, defs.length);
  assert.equal(ranked[0].cardId, '2');
});

test('rankDistractors drops candidates that name the asked term', () => {
  const seg = { cardId: 's1', term: 'Segmentation', definition: 'Outlines the object at the pixel level' };
  const segScenario = { cardId: 's2', term: 'Segmentation is the pixel-level outline', definition: 'Marketing needs the exact pixel outline of the product' };
  const segMention = { cardId: 's3', term: 'Some other card', definition: 'Unlike segmentation, detection draws a box around the object' };
  const det = { cardId: 's4', term: 'Object detection', definition: 'Labels an object AND locates it with a bounding box' };
  const ranked = rankDistractors([seg, segScenario, segMention, det], seg, 6);
  assert.deepEqual(ranked.map((p) => p.cardId), ['s4']);
});

test('rankDistractors drops term-variant twins in both directions', () => {
  const scenario = {
    cardId: 'b1',
    term: 'Batch transcription and async, high volume, Blob input',
    definition: 'Ten thousand recorded calls need transcripts overnight',
  };
  const vocab = {
    cardId: 'b2',
    term: 'Batch transcription',
    definition: 'Pre-recorded files in Blob Storage, high volume, async.',
  };
  const other = {
    cardId: 'b3',
    term: 'Real-time speech to text',
    definition: 'Live streaming audio for interactive transcription apps',
  };
  // Asking about the long-term scenario item must not offer the short vocab
  // term (it would also be correct) — and vice versa.
  assert.ok(!rankDistractors([scenario, vocab, other], scenario, 6).some((p) => p.cardId === 'b2'));
  assert.ok(!rankDistractors([scenario, vocab, other], vocab, 6).some((p) => p.cardId === 'b1'));
});

const lenPool = [
  { cardId: 'v1', term: 'Regression', definition: 'Predicts a continuous number.' },
  { cardId: 'v2', term: 'Classification', definition: 'Predicts a category.' },
  { cardId: 'v3', term: 'Clustering', definition: 'Groups similar items with no labels.' },
  { cardId: 'v4', term: 'Supervised learning', definition: 'Labeled data. Learns the mapping from input to output.' },
  { cardId: 'v5', term: 'Long scenario', definition: 'A supermarket chain wants to estimate how many rotisserie chickens each store will sell next week, predicts numbers from three years of past sales data and predicts demand.' },
];

test('buildChoices keeps choices length-compatible with the correct answer', () => {
  for (let i = 0; i < 10; i += 1) {
    const choices = buildChoices(lenPool, lenPool[0], 'definition');
    assert.equal(choices.length, 3);
    assert.ok(!choices.includes(lenPool[0].definition));
    // v5's 170-char definition is a length tell against the 29-char correct
    // answer, and three compatible candidates exist - it must never appear.
    assert.ok(!choices.includes(lenPool[4].definition));
  }
});

test('buildChoices term side returns terms, never the correct one', () => {
  const choices = buildChoices(lenPool, lenPool[0], 'term');
  assert.equal(choices.length, 3);
  assert.ok(!choices.includes('Regression'));
  const allTerms = lenPool.map((p) => p.term);
  for (const c of choices) assert.ok(allTerms.includes(c));
});

test('buildChoices fills to n even when few similar candidates exist', () => {
  const item = { cardId: 'x1', term: 'Phoneme', definition: 'The smallest unit of sound in speech.' };
  const pool = [item,
    { cardId: 'x2', term: 'Prosody', definition: 'Natural rhythm and cadence in speech.' },
    { cardId: 'x3', term: 'Azure Backup', definition: 'Disaster recovery and data protection.' },
    { cardId: 'x4', term: 'RBAC', definition: 'Controls who can access resources.' },
  ];
  const choices = buildChoices(pool, item, 'definition');
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices).size, 3);
});

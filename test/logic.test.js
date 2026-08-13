const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTwinMap, reviewQueue, similarity, rankDistractors, buildChoices } = require('../public/logic.js');

const card = (id, front, back, due = 0, deck = 'D') => ({ id, front, back, due, deck });

// A reversed pair used throughout: 'a' has the short (keyword) front,
// 'b' the long (description) front.
const pairA = () => card('a', 'Transparency', 'Understand how the system works', 0);
const pairB = () => card('b', 'Understand how the system works', 'Transparency', 0);

test('buildTwinMap pairs reversed cards in the same deck', () => {
  const single = card('c', 'Fairness', 'No bias across groups');
  const twins = buildTwinMap([pairA(), pairB(), single]);
  assert.equal(twins.get('a'), 'b');
  assert.equal(twins.get('b'), 'a');
  assert.equal(twins.has('c'), false);
});

test('buildTwinMap ignores would-be twins in another deck', () => {
  const a = card('a', 'X', 'Y', 0, 'D1');
  const b = card('b', 'Y', 'X', 0, 'D2');
  assert.equal(buildTwinMap([a, b]).size, 0);
});

test('buildTwinMap matching is trim- and case-insensitive', () => {
  const a = card('a', ' Transparency ', 'DEF');
  const b = card('b', 'def', 'transparency');
  assert.equal(buildTwinMap([a, b]).get('a'), 'b');
});

test('reviewQueue collapses a due pair to one keyword-first entry', () => {
  assert.deepEqual(reviewQueue([pairA(), pairB()], 1, 'keyword', {}), ['a']);
});

test('reviewQueue description mode queues the long-front twin', () => {
  assert.deepEqual(reviewQueue([pairA(), pairB()], 1, 'description', {}), ['b']);
});

test('a pair is due when either twin is due', () => {
  const a = card('a', 'Transparency', 'Understand how the system works', 999);
  const b = card('b', 'Understand how the system works', 'Transparency', 0);
  assert.deepEqual(reviewQueue([a, b], 1, 'keyword', {}), ['a']);
});

test('mixed mode memoizes its pick across rebuilds', () => {
  const picks = {};
  const first = reviewQueue([pairA(), pairB()], 1, 'mixed', picks);
  assert.equal(first.length, 1);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(reviewQueue([pairA(), pairB()], 1, 'mixed', picks), first);
  }
});

test('singles keep their authored direction; non-due cards stay out', () => {
  const scenario = card('s', 'A long scenario about predicting chicken demand', 'Regression', 0);
  const notDue = card('n', 'Not due yet', 'Nope', 99);
  assert.deepEqual(reviewQueue([scenario, notDue], 1, 'description', {}), ['s']);
});

test('queue sorts by earliest due (pair uses its earlier twin)', () => {
  const early = card('e', 'Early single', 'Def', 5);
  const a = card('a', 'Transparency', 'Understand how the system works', 40);
  const b = card('b', 'Understand how the system works', 'Transparency', 10);
  assert.deepEqual(reviewQueue([a, early, b], 50, 'keyword', {}), ['e', 'a']);
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

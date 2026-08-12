const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTwinMap, reviewQueue, similarity, rankDistractors } = require('../public/logic.js');

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

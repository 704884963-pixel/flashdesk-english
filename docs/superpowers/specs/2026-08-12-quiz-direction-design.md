# Quiz direction picker (Keyword / Definition / Mixed)

**Date:** 2026-08-12
**Status:** Approved (user pre-approved implementation through to PWA push)

## Problem

Every quiz question is forced into "term → pick the definition"
(`quizPool()` normalizes shorter-side-as-term). Two consequences Abdiel hit:

1. **Predictable** — one fixed question shape per fact, every round.
2. **Nonsensical** — scenario cards quiz backwards: their short side is the
   *answer* text ("Segmentation — pixel-level outline…"), so it becomes the
   question front while the scenario story becomes a "definition" choice.

## Decision (made with Abdiel)

Three modes, **default Mixed**: Keyword (term → definitions), Definition
(definition/scenario → terms, exam-shaped), Mixed (random orientation per
question). Mixed covers "both" — no double-length Both mode.

## 1. UI — quiz start screen

A **Direction** row above/next to the existing Length row, same pill pattern
(`.quiz-len` recipe): **Keyword · Definition · Mixed**. Stored in
localStorage key `flashdesk-quiz-direction`, default `mixed`, independent of
the review switch. Clicking a pill updates `state.quiz.direction` and
re-renders the start screen; the value is read when questions build.

## 2. Question building (`startQuiz`)

Each question resolves `orientation` at build time: the picked mode, or a
50/50 flip per question in Mixed.

- **Keyword:** `front = item.term`, correct choice = `item.definition`,
  distractor choices = candidate **definitions** (today's behavior).
- **Definition:** `front = item.definition`, correct choice = `item.term`,
  distractor choices = candidate **terms**, deduped by term text.

Distractor selection moves into a new pure helper so it is unit-testable:

`FlashLogic.buildChoices(pool, item, side, n = 3) -> string[]`
(`side` ∈ `'definition' | 'term'` — the text rendered as choices):

1. Rank candidates with `rankDistractors(pool, item, 8)` (8, not 6, for more
   length options to choose from).
2. Map to the chosen side's text, dedupe, drop any equal to the correct text.
3. **Length matching (Abdiel's requirement — no length tells):** a candidate
   is *length-compatible* with the correct choice when both are in the short
   class (≤ 45 chars — single words / short phrases) or their lengths are
   within roughly 2× of each other (`min/max ≥ 0.45`). Prefer
   length-compatible candidates: random-pick `n` among them first.
4. If short, fill in strict priority order: length-compatible from the rest
   of the pool, then ranked candidates of any length, then anything — a
   length tell defeats the question outright, an off-topic option only
   weakens it; and a full choice row beats a perfectly uniform one.

The question object keeps its shape (`{cardId, front, correct, choices}`) so
render/answer/results code is untouched; the missed-answers panel shows
`front` + `correct`, which remains coherent in both orientations.

## 3. Symmetric two-correct-answers guard (`rankDistractors`)

Current guard: drop candidates whose term or definition **contains** the
asked item's term. Definition mode exposes the mirror: asking about the
scenario item whose term is "Batch transcription — async, high volume…"
could offer the vocab term "Batch transcription" as a term-choice — also
correct. Extend the guard to drop candidates when **either term contains the
other** (both normalized, both with the existing >3-char length guard).
Applies to both modes (it also tightens keyword mode). Unit-tested.

## 4. Ships to the phone

All changes in `public/app.js`, `public/logic.js`, `test/logic.test.js` —
no new files, service worker precache list unchanged. `node build.js`,
commit `docs/`, push (user approved).

## Out of scope

- Review switch untouched (its "Description" label stays as is).
- No changes to quiz length options, scoring, missed-card requeueing,
  server API, or `~/drills/log.txt` formats.

## Verification

- `npm test` green (new guard test + existing 13).
- Browser: Definition mode shows a scenario/definition front with 4 term
  choices, exactly one correct; Keyword mode matches today's shape; Mixed
  round contains both shapes; pill choice survives reload.
- No question offers two defensible answers for term-variant pairs
  (e.g. "Batch transcription" vs "Batch transcription — async…").
- Choice rows are length-uniform: simulated rounds over the real deck show
  no question whose correct answer is the length outlier (longest or
  shortest by a wide margin) when compatible candidates existed.

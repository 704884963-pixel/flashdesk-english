# Review direction switch + similarity quiz distractors

**Date:** 2026-08-11
**Status:** Approved

## Problem

1. **Double review.** Facts stored as reversed pairs (e.g., `Transparency` ↔ its
   definition — 6 RAI pairs from the original seed) appear twice per review
   session, once per direction. Abdiel feels he is "reviewing twice."
2. **Obvious quizzes.** Quiz distractors are 3 random definitions from the deck,
   so unrelated options (encryption vs. an NLP question) make the correct answer
   guessable by elimination.

## Decisions (made with Abdiel)

- Review: **collapse pairs + orientation toggle** (not deletion, not a "both" mode).
- Quiz: **similarity-scored distractors** (not manual topic tags).

## 1. Shared logic module — `public/logic.js`

Pure functions used by both review and quiz, in a plain script that attaches
`window.FlashLogic` in the browser and sets `module.exports` when `module`
exists, so Node can require it for tests.

- **Pair detection:** cards A and B are a reversed pair when, after
  trim + lowercase, `A.front == B.back && A.back == B.front` and
  `A.deck == B.deck`. Build a map `cardId → twinId` per card list.
- **Keyword/description convention:** within a pair (or any card), the shorter
  side is the *keyword*, the longer side the *description* — same convention
  `quizPool()` already uses.
- **Similarity scoring:** word overlap between two items' `term + definition`
  text: lowercase, split on non-letters, drop a small stopword list, score by
  Jaccard overlap. Tie-breaker: closer definition length scores slightly higher
  (kills the "longest answer is correct" tell).

Tests: `test/logic.test.js` run with `node --test` (first tests in the repo;
zero dependencies preserved). Cover: pair detection (match, non-match,
cross-deck), keyword-side selection, similarity ranking (NLP items outrank
encryption for an NLP target), length tie-breaker.

## 2. Review direction switch

**UI:** three-way segmented control in the Review view header:
**Keyword · Description · Mixed**. Persisted in `localStorage`
(`flashdesk-direction`), default **Mixed**. Rendered only when the current
filter's cards contain at least one pair; otherwise hidden (nothing to switch).

**Queue building (`buildQueue`):**
- Collapse each reversed pair to ONE queue entry. No display-side swapping:
  choosing an orientation means queueing the twin whose stored front already
  faces that way (Keyword → the twin with the shorter front; Description → the
  longer-front twin; Mixed → random per fact, chosen once per session so
  stepping ‹ › doesn't reshuffle).
- A fact is **due if either twin is due**; queue position uses the earlier due.
- Singles (scenario cards, one-direction cards) always show their authored
  front, in every mode.

**Grading (`grade`):** grade the shown card via the existing endpoint, then
grade the twin with the same result (second call to `POST /api/cards/grade` /
the store adapter). Both twins' local state update from the responses.
Schedules converge after the first synced grade; the twin never comes due
separately again.

**Session stats:** reviewed/correct/again count facts (queue entries), not
twin cards. `hardest` still reads lapses from graded shown-cards.

**Error handling:** if the twin's grade call fails after the first succeeds,
show the existing "Save failed" toast and continue; the twin stays on its old
schedule and simply appears in a later session. No rollback needed — grading
twice is idempotent enough for a two-button scheduler.

## 3. Quiz similarity distractors

In `startQuiz()`, replace random distractor sampling:

1. Score every other pool item against the correct item with
   `FlashLogic.similarity`.
2. Take the top 6 candidates with score > 0; randomly pick 3 (keeps repeat
   quizzes varied).
3. If fewer than 3 qualify, fill the remainder randomly (current behavior).

Distractor texts remain deduped and exclude the correct definition, as today.
`quizPool()`'s pair-dedup stays as is.

## 4. PWA parity

All changes live in `public/` (`app.js`, `index.html` + one script tag,
new `logic.js`) — `build.js` copies `public/` into `docs/`, so one
`node build.js` + commit + push ships review switch, harder quiz, AND the 60
new exam-style cards to the phone. Add `logic.js` to the service worker
precache list (`pwa/sw.js`); the content-hash cache name handles invalidation.
`pwa/store-local.js` needs no changes (grade-per-id already exists; the second
grade call goes through the same adapter seam).

## Out of scope

- No changes to the interval ladder, history/stats shape, Browse, Add form,
  or the server API.
- No deletion of the reversed twin cards (collapse is display/schedule-level).
- No changes to `~/drills/log.txt` line formats.

## Verification

- `node --test` green.
- Manual: Review with AI-901 filter shows 6 fewer due facts than raw due-card
  count when RAI pairs are due; toggling Keyword/Description flips which side
  shows; grading marks both twins (check Browse due column); quiz on an NLP
  card shows NLP-flavored distractors.

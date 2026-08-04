# FlashDesk

A local spaced-repetition flashcard web app built with zero npm dependencies. One Node process serves a vanilla JS front end and a small JSON API, and persists everything to a single JSON file next to the server.

**Features**

- **Review mode** with tap-to-reveal cards, previous/next navigation, and two-button grading ("Again" / "Got it"). Full keyboard support: space to reveal, arrow keys to move, 1/2 or Enter to grade.
- **Quiz mode**: 10 multiple-choice questions per round, with distractors drawn from other cards in the same deck. Missed cards go straight back into the review queue.
- **Decks**: cards belong to named decks, with a global deck filter across every view.
- **Add and browse**: a quick-add form (Cmd/Ctrl+Enter to submit) and a browse table showing due time, streak, and lapse count per card, with two-click delete.
- **Copy stats**: one button copies a compact plain-text summary (deck sizes, cards due today, 7-day accuracy, most-lapsed cards) to the clipboard, formatted for pasting into an AI tutor chat.
- **Session log**: each finished review session or quiz appends one summary line to `~/drills/log.txt`.

## How the scheduling works

This is deliberately simpler than SM-2: no ease factors, no self-rated difficulty, just two buttons and a fixed interval ladder.

- **"Got it"** increments the card's streak and schedules it `[1, 3, 7, 14, 30, 60]` days out by streak count. Streaks past 6 stay at 60 days.
- **"Again"** resets the streak to 0, increments the card's lapse count, and brings it back in 10 minutes.
- **Quiz misses** make a card due immediately but leave streak and lapses untouched, so quiz rounds never distort the spaced-repetition stats.

## Tech stack

- Node.js standard library only (`node:http`, `node:fs`, `node:path`, `node:os`). No npm packages, no framework, no build step.
- Vanilla JavaScript, HTML, and CSS on the front end.
- Persistence: one JSON file (`flashdesk-data.json`), written atomically (write to a temp file, then rename). A corrupt data file is moved aside and the app re-seeds instead of crashing.

## Setup

Requires Node.js 16 or newer. There are no dependencies to install.

```sh
node server.js
```

Then open http://localhost:5902.

On first run the server seeds 26 sample cards (an AI-901 exam prep deck defined in `seed.js`) and creates `flashdesk-data.json`. That data file is gitignored; delete it any time to reset to the seed deck. Note that finished sessions are logged to `~/drills/log.txt` in your home directory.

## Screenshot

<!-- TODO: add screenshot of the review view -->
<!-- ![FlashDesk review view](docs/screenshot.png) -->

## Design notes

- **Seed-on-first-run instead of a seed script.** `seed.js` just exports the starter cards; the server seeds automatically whenever the data file is missing. A fresh clone works with plain `node server.js`, and the same path doubles as recovery when the data file is unreadable.
- **Atomic saves.** Every write goes to `flashdesk-data.json.tmp` and is then renamed over the real file, so a crash mid-write cannot leave a half-written data file.
- **Keeping the quiz honest.** Quiz misses only move a card's due date; they never touch streak or lapse counts. That split keeps the interval ladder driven purely by real recall grades from review sessions.
- **Zero dependencies on purpose.** The whole app is an exercise in how far `node:http` plus vanilla JS gets you: routing, JSON body parsing with a size limit, static file serving with a path traversal guard, all in one readable file.

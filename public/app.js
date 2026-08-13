// FlashDesk client — state, review session machine, add/browse views, stats copy.

const $ = (sel) => document.querySelector(sel);

const state = {
  cards: [],
  history: [],
  deckFilter: 'All',
  view: 'review',
  session: null,
  quiz: null,
};

function freshSession() {
  return {
    active: false,
    queue: [],
    pos: 0,
    currentId: null,
    revealed: false,
    grading: false,
    reviewed: 0,
    correct: 0,
    again: 0,
    gradedIds: new Set(),
    picks: {}, // mixed-direction memo: 'idA|idB' -> shown card id, stable per session
    complete: false,
    logged: null, // null = pending, true/false = /api/session outcome
  };
}
state.session = freshSession();

const DIRECTIONS = ['keyword', 'description', 'mixed'];
state.direction = (() => {
  try {
    const d = localStorage.getItem('flashdesk-direction');
    return DIRECTIONS.includes(d) ? d : 'mixed';
  } catch { return 'mixed'; }
})();
state.twinMap = new Map();

/* ---------- helpers ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function decks() {
  return [...new Set(state.cards.map((c) => c.deck))].sort();
}

const inFilter = (card) => state.deckFilter === 'All' || card.deck === state.deckFilter;
const dueNow = (card) => card.due <= Date.now();

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtRelative(due) {
  const diff = due - Date.now();
  if (diff <= 0) return 'now';
  const m = Math.round(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `in ${d}d`;
  return `in ${Math.round(d / 30)}mo`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

/* ---------- deck controls ---------- */

function renderDeckControls() {
  const names = decks();
  if (state.deckFilter !== 'All' && !names.includes(state.deckFilter)) state.deckFilter = 'All';
  const sel = $('#deck-filter');
  sel.innerHTML = ['All', ...names]
    .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
    .join('');
  sel.value = state.deckFilter;
  $('#deck-names').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ---------- review session ---------- */

function buildQueue() {
  const s = state.session;
  const pool = state.cards.filter(inFilter);
  state.twinMap = FlashLogic.buildTwinMap(pool);
  s.queue = FlashLogic.reviewQueue(pool, Date.now(), state.direction, s.picks);
  if (s.pos >= s.queue.length) s.pos = 0;
  renderDirSwitch();
}

function renderDirSwitch() {
  const el = $('#dir-switch');
  el.hidden = state.twinMap.size === 0; // nothing to switch without pairs
  el.querySelectorAll('.dir-opt').forEach((b) =>
    b.classList.toggle('active', b.dataset.dir === state.direction));
}

function stepCard(dir) {
  const s = state.session;
  if (s.complete || s.queue.length < 2) return;
  s.pos = (s.pos + dir + s.queue.length) % s.queue.length;
  s.revealed = false;
  renderReview();
}

function deckLabel() {
  return state.deckFilter === 'All' ? 'any deck' : state.deckFilter;
}

function renderReview() {
  const s = state.session;
  const area = $('#review-area');
  $('#due-count').textContent = s.complete ? '' : `Due: ${s.queue.length}`;

  if (s.complete) {
    const pct = Math.round((s.correct / s.reviewed) * 100);
    const logNote = FlashStore.logNote(s.logged);
    area.innerHTML = `
      <div class="panel complete-panel">
        <div class="micro-label">Session complete · ${esc(deckLabel())}</div>
        <p class="complete-stats">${s.reviewed} reviewed · ${s.correct} got it · ${s.again} again · ${pct}% accuracy</p>
        <div class="micro-label lognote${s.logged === false ? ' warn' : ''}">${logNote}</div>
        <div class="complete-actions">
          <button class="btn btn-primary" id="copy-stats-complete">Copy stats for Claude</button>
          <button class="btn" id="review-again">Review again</button>
        </div>
        <pre id="stats-fallback-complete" class="stats-pre" hidden></pre>
      </div>`;
    return;
  }

  if (!s.queue.length) {
    const pool = state.cards.filter(inFilter);
    const upcoming = pool.filter((c) => !dueNow(c)).sort((a, b) => a.due - b.due)[0];
    const hint = pool.length === 0
      ? 'No cards in this deck yet — add some.'
      : upcoming ? `Next card due ${fmtRelative(upcoming.due)}.` : '';
    area.innerHTML = `
      <div class="panel empty-panel">
        <div class="micro-label">All clear</div>
        <p>Nothing due in ${esc(deckLabel())}.</p>
        <p class="muted">${esc(hint)}</p>
      </div>`;
    return;
  }

  const card = state.cards.find((c) => c.id === s.queue[s.pos]);
  s.currentId = card.id;
  const arrowsOff = s.queue.length < 2 ? 'disabled' : '';
  area.innerHTML = `
    <div class="review-stage">
      <button class="card-arrow" id="card-prev" title="Previous card (←)" aria-label="Previous card" ${arrowsOff}>‹</button>
      <button class="card-flip${s.revealed ? ' flipped' : ' revealable'}" id="card-face">
        <div class="card-flip-inner">
          <div class="card-face face-front" aria-hidden="${s.revealed}">
            <div class="card-front">${esc(card.front)}</div>
            <div class="micro-label">Tap to reveal · space</div>
          </div>
          <div class="card-face face-back" aria-hidden="${!s.revealed}">
            <div class="card-front">${esc(card.front)}</div>
            <div class="card-back">${esc(card.back)}</div>
            <div class="micro-label">Tap to flip back · space</div>
          </div>
        </div>
      </button>
      <button class="card-arrow" id="card-next" title="Next card (→)" aria-label="Next card" ${arrowsOff}>›</button>
      <div class="grade-row" ${s.revealed ? '' : 'hidden'}>
        <button class="btn-grade btn-again" id="grade-again" title="Back in 10 minutes (key: 1)">Again</button>
        <button class="btn-grade btn-got" id="grade-got" title="Streak climbs the interval ladder (key: 2)">Got it</button>
      </div>
    </div>`;
}

function setFlipped(flipped) {
  // Flip in place — a re-render here would cut the CSS transition short.
  const face = $('#card-face');
  if (!face) return;
  state.session.revealed = flipped;
  face.classList.toggle('flipped', flipped);
  face.classList.toggle('revealable', !flipped);
  face.querySelector('.face-front').setAttribute('aria-hidden', String(flipped));
  face.querySelector('.face-back').setAttribute('aria-hidden', String(!flipped));
  $('#review-area .grade-row').hidden = !flipped;
}

function reveal() {
  if (state.session.complete || state.session.revealed || !state.session.queue.length) return;
  setFlipped(true);
}

function toggleFlip() {
  const s = state.session;
  if (s.complete || !s.queue.length) return;
  setFlipped(!s.revealed);
}

async function grade(kind) {
  const s = state.session;
  if (s.grading || s.complete || !s.revealed) return;
  const id = s.currentId;
  if (!id || !state.cards.some((c) => c.id === id)) {
    buildQueue();
    renderReview();
    return;
  }
  s.grading = true;
  let card;
  try {
    ({ card } = await FlashStore.gradeCard(id, kind));
  } catch (err) {
    toast(`Save failed: ${err.message}`);
    s.grading = false;
    return;
  }
  s.grading = false;
  s.active = true;
  s.reviewed += 1;
  if (kind === 'got') s.correct += 1;
  else s.again += 1;
  s.gradedIds.add(id);
  const idx = state.cards.findIndex((c) => c.id === id);
  if (idx !== -1) state.cards[idx] = card;

  // The queue collapsed this card's reversed twin into this review — grade it
  // identically so the same fact never comes due twice.
  const twinId = state.twinMap.get(id);
  if (twinId && state.cards.some((c) => c.id === twinId)) {
    try {
      const { card: twinCard } = await FlashStore.gradeCard(twinId, kind);
      const tIdx = state.cards.findIndex((c) => c.id === twinId);
      if (tIdx !== -1) state.cards[tIdx] = twinCard;
    } catch (err) {
      // Not fatal: the twin keeps its old schedule and surfaces next session.
      toast(`Twin card save failed: ${err.message}`);
    }
  }

  s.revealed = false;
  buildQueue();
  if (!s.queue.length) return completeSession();
  renderReview();
}

async function completeSession() {
  const s = state.session;
  s.complete = true;
  const hardest = [...s.gradedIds]
    .map((id) => state.cards.find((c) => c.id === id))
    .filter((c) => c && c.lapses > 0)
    .sort((a, b) => b.lapses - a.lapses)
    .slice(0, 2)
    .map((c) => c.front);
  renderReview();
  try {
    const res = await FlashStore.logSession({
      deck: state.deckFilter,
      reviewed: s.reviewed,
      correct: s.correct,
      again: s.again,
      hardest,
    });
    s.logged = res.logged;
    state.history.push({ date: localDate(), deck: state.deckFilter, reviewed: s.reviewed, correct: s.correct });
  } catch (err) {
    s.logged = false;
  }
  if (state.view === 'review') renderReview();
}

/* ---------- stats ---------- */

function statsText() {
  const now = new Date();
  const names = decks();
  const deckLine = names.length
    ? names.map((d) => {
        const cs = state.cards.filter((c) => c.deck === d);
        return `${d} ${cs.length} cards (${cs.filter(dueNow).length} due)`;
      }).join(' · ')
    : 'no cards';

  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const dueToday = state.cards.filter((c) => c.due < endOfToday).length;

  const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const recent = state.history.filter((h) => h.date >= cutoff);
  const rev = recent.reduce((n, h) => n + h.reviewed, 0);
  const cor = recent.reduce((n, h) => n + h.correct, 0);
  const accLine = rev ? `${Math.round((cor / rev) * 100)}% (${rev} reviews)` : 'no reviews yet';

  const lapsed = state.cards
    .filter((c) => c.lapses > 0)
    .sort((a, b) => b.lapses - a.lapses)
    .slice(0, 5);
  const lapsedLine = lapsed.length
    ? lapsed.map((c) => `"${c.front}" ×${c.lapses}`).join(', ')
    : 'none yet';

  return [
    `FlashDesk stats — ${localDate(now)}`,
    `Decks: ${deckLine}`,
    `Due today (all decks): ${dueToday}`,
    `Accuracy last 7 days: ${accLine}`,
    `Most-lapsed: ${lapsedLine}`,
  ].join('\n');
}

async function copyStats(btn, fallbackPre) {
  const text = statsText();
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* fall through */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* fall through */ }
    ta.remove();
  }
  if (ok) {
    const orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } else if (fallbackPre) {
    fallbackPre.textContent = text;
    fallbackPre.hidden = false;
  }
}

/* ---------- quiz ---------- */

const QUIZ_LENGTHS = [10, 20, 'All'];
const DEFAULT_QUIZ_SIZE = 20;
const QUIZ_DIRECTIONS = ['keyword', 'definition', 'mixed'];
const QUIZ_DIR_LABELS = { keyword: 'Keyword', definition: 'Definition', mixed: 'Mixed' };

function quizDirection() {
  try {
    const d = localStorage.getItem('flashdesk-quiz-direction');
    return QUIZ_DIRECTIONS.includes(d) ? d : 'mixed';
  } catch { return 'mixed'; }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshQuiz() {
  return { phase: 'start', questions: [], idx: 0, correct: 0, missedIds: [], answered: null, logged: null, size: DEFAULT_QUIZ_SIZE, direction: quizDirection() };
}

// Normalize each card to { term, definition } — shorter side is the term, longer side
// the definition — then dedupe by term so reversed pairs collapse to one question.
// This makes every quiz "here is the word, pick its definition" with all-definition choices.
function quizPool() {
  const seen = new Set();
  const items = [];
  for (const c of state.cards.filter(inFilter)) {
    const [term, definition] = c.front.length <= c.back.length ? [c.front, c.back] : [c.back, c.front];
    const key = term.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ cardId: c.id, term, definition });
  }
  return items;
}

function startQuiz() {
  const q = state.quiz;
  const pool = quizPool();
  if (pool.length < 4) return;
  const count = q.size === 'All' ? pool.length : Math.min(q.size, pool.length);
  q.questions = shuffle(pool).slice(0, count).map((item) => {
    // keyword: word front, definition choices. definition: definition front,
    // term choices (exam-shaped). mixed: coin flip per question.
    const orientation = q.direction === 'mixed'
      ? (Math.random() < 0.5 ? 'keyword' : 'definition')
      : q.direction;
    const side = orientation === 'keyword' ? 'definition' : 'term';
    const front = orientation === 'keyword' ? item.term : item.definition;
    const correct = orientation === 'keyword' ? item.definition : item.term;
    const distractors = FlashLogic.buildChoices(pool, item, side);
    return { cardId: item.cardId, front, correct, choices: shuffle([correct, ...distractors]) };
  });
  q.phase = 'question';
  q.idx = 0;
  q.correct = 0;
  q.missedIds = [];
  q.answered = null;
  renderQuiz();
}

function answerQuiz(i) {
  const q = state.quiz;
  if (q.phase !== 'question' || q.answered !== null) return;
  q.answered = i;
  const question = q.questions[q.idx];
  if (question.choices[i] === question.correct) q.correct += 1;
  else q.missedIds.push(question.cardId);
  renderQuiz();
}

function nextQuizQuestion() {
  const q = state.quiz;
  if (q.answered === null) return;
  if (q.idx + 1 < q.questions.length) {
    q.idx += 1;
    q.answered = null;
    renderQuiz();
  } else {
    finishQuiz();
  }
}

async function finishQuiz() {
  const q = state.quiz;
  q.phase = 'done';
  renderQuiz();
  try {
    const res = await FlashStore.logQuiz({
      deck: state.deckFilter,
      questions: q.questions.length,
      correct: q.correct,
      missedIds: q.missedIds,
    });
    q.logged = res.logged;
  } catch {
    q.logged = false;
  }
  try {
    const { cards, history } = await FlashStore.load(); // missed cards are due now
    state.cards = cards;
    state.history = history;
  } catch { /* keep the local copy */ }
  if (state.view === 'quiz') renderQuiz();
}

function renderQuiz() {
  const q = state.quiz;
  const area = $('#quiz-area');
  if (q.phase === 'start') {
    const pool = quizPool();
    if (pool.length < 4) {
      area.innerHTML = `
        <div class="panel quiz-start">
          <div class="micro-label">Quiz</div>
          <p>Need at least 4 distinct words in ${esc(deckLabel())} to build a quiz.</p>
        </div>`;
      return;
    }
    area.innerHTML = `
      <div class="panel quiz-start">
        <div class="micro-label">Quiz · ${esc(deckLabel())}</div>
        <p>Questions are drawn at random; missed cards go straight back into your Review queue.</p>
        <div class="quiz-length">
          <span class="micro-label">Direction</span>
          <div class="quiz-length-opts">
            ${QUIZ_DIRECTIONS.map((d) => {
              const active = q.direction === d ? ' active' : '';
              return `<button class="quiz-len${active}" data-quizdir="${d}">${QUIZ_DIR_LABELS[d]}</button>`;
            }).join('')}
          </div>
        </div>
        <div class="quiz-length">
          <span class="micro-label">Length</span>
          <div class="quiz-length-opts">
            ${QUIZ_LENGTHS.map((len) => {
              const active = q.size === len ? ' active' : '';
              const label = len === 'All' ? `All (${pool.length})` : len;
              return `<button class="quiz-len${active}" data-size="${len}">${label}</button>`;
            }).join('')}
          </div>
        </div>
        <button class="btn btn-primary" id="quiz-start-btn">Start quiz</button>
      </div>`;
    return;
  }

  if (q.phase === 'question') {
    const question = q.questions[q.idx];
    const answered = q.answered !== null;
    area.innerHTML = `
      <div class="micro-label quiz-progress">Question ${q.idx + 1}/${q.questions.length}</div>
      <div class="quiz-question"><div class="card-front">${esc(question.front)}</div></div>
      <div class="quiz-choices">
        ${question.choices.map((choice, i) => {
          let cls = 'quiz-choice';
          if (answered) {
            if (choice === question.correct) cls += ' correct';
            else if (i === q.answered) cls += ' wrong';
          }
          return `<button class="${cls}" data-choice="${i}" ${answered ? 'disabled' : ''}><span class="quiz-key">${i + 1}</span><span class="quiz-choice-text">${esc(choice)}</span></button>`;
        }).join('')}
      </div>
      ${answered
        ? `<div class="quiz-next-row"><button class="btn btn-primary" id="quiz-next">${q.idx + 1 < q.questions.length ? 'Next' : 'See results'}</button></div>`
        : ''}`;
    return;
  }

  const total = q.questions.length;
  const pct = Math.round((q.correct / total) * 100);
  const missed = q.missedIds.map((id) => q.questions.find((qq) => qq.cardId === id)).filter(Boolean);
  const logNote = FlashStore.logNote(q.logged);
  area.innerHTML = `
    <div class="panel quiz-done">
      <div class="micro-label">Quiz complete · ${esc(deckLabel())}</div>
      <div class="quiz-score">${q.correct}/${total} · ${pct}%</div>
      <div class="micro-label lognote${q.logged === false ? ' warn' : ''}">${logNote}</div>
      ${missed.length
        ? `<div class="quiz-missed">
            ${missed.map((m) => `
              <div class="quiz-missed-item">
                <div>${esc(m.front)}</div>
                <div class="answer">${esc(m.correct)}</div>
              </div>`).join('')}
          </div>
          <p class="muted">These cards are back in your Review queue.</p>`
        : '<p class="muted">Perfect round — nothing missed.</p>'}
      <button class="btn btn-primary" id="quiz-restart">New quiz</button>
    </div>`;
}

/* ---------- browse ---------- */

function renderBrowse() {
  const cards = state.cards.filter(inFilter).sort((a, b) => a.due - b.due);
  const scope = state.deckFilter === 'All' ? '' : ` · ${state.deckFilter}`;
  $('#browse-count').textContent = `${cards.length} card${cards.length === 1 ? '' : 's'}${scope}`;
  $('#browse-table tbody').innerHTML = cards.map((c) => `
    <tr>
      <td class="cell-text" title="${esc(c.front)}">${esc(c.front)}</td>
      <td class="cell-text" title="${esc(c.back)}">${esc(c.back)}</td>
      <td class="num">${esc(c.deck)}</td>
      <td class="num">${fmtRelative(c.due)}</td>
      <td class="num">${c.streak}</td>
      <td class="num">${c.lapses}</td>
      <td><button class="x-btn" data-del="${esc(c.id)}" title="Delete card">✕</button></td>
    </tr>`).join('');
}

/* ---------- views ---------- */

function switchView(name) {
  state.view = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('btn-active', b.dataset.view === name));
  for (const v of ['review', 'quiz', 'add', 'browse']) $(`#view-${v}`).hidden = v !== name;
  if (name === 'review') {
    state.session = freshSession();
    buildQueue();
    renderReview();
  } else if (name === 'quiz') {
    state.quiz = freshQuiz();
    renderQuiz();
  } else if (name === 'browse') {
    renderBrowse();
    if (FlashStore.exportData) $('#data-panel').hidden = false;
  } else if (name === 'add') {
    if (!$('#add-deck').value.trim()) {
      $('#add-deck').value = state.deckFilter === 'All' ? 'AI-901' : state.deckFilter;
    }
    $('#add-front').focus();
  }
}

/* ---------- events ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view)));

  $('#deck-filter').addEventListener('change', (e) => {
    state.deckFilter = e.target.value;
    switchView(state.view); // resets any in-progress session against the new filter
  });

  $('#dir-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dir]');
    if (!b || b.dataset.dir === state.direction) return;
    state.direction = b.dataset.dir;
    try { localStorage.setItem('flashdesk-direction', state.direction); } catch { /* private mode */ }
    state.session = freshSession(); // orientation changes the queue — start clean
    buildQueue();
    renderReview();
  });

  $('#review-area').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'card-face') toggleFlip();
    else if (b.id === 'card-prev') stepCard(-1);
    else if (b.id === 'card-next') stepCard(1);
    else if (b.id === 'grade-again') grade('again');
    else if (b.id === 'grade-got') grade('got');
    else if (b.id === 'copy-stats-complete') copyStats(b, $('#stats-fallback-complete'));
    else if (b.id === 'review-again') {
      state.session = freshSession();
      buildQueue();
      renderReview();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'review' || state.session.complete) return;
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === ' ') {
      if (e.target.matches('button')) return; // native activation covers it
      e.preventDefault();
      toggleFlip();
    } else if (e.key === 'ArrowLeft') {
      stepCard(-1);
    } else if (e.key === 'ArrowRight') {
      stepCard(1);
    } else if (state.session.revealed) {
      if (e.key === '1') grade('again');
      else if (e.key === '2') grade('got');
      else if (e.key === 'Enter' && !e.target.matches('button')) grade('got');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'quiz') return;
    if (e.target.matches('input, textarea, select')) return;
    const q = state.quiz;
    if (!q || q.phase !== 'question') return;
    if (q.answered === null) {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= q.questions[q.idx].choices.length) {
        e.preventDefault();
        answerQuiz(n - 1);
      }
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      if (e.target.matches('button')) return; // native button activation handles it
      e.preventDefault();
      nextQuizQuestion();
    }
  });

  $('#quiz-area').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.quizdir !== undefined) {
      state.quiz.direction = b.dataset.quizdir;
      try { localStorage.setItem('flashdesk-quiz-direction', state.quiz.direction); } catch { /* private mode */ }
      renderQuiz();
    } else if (b.dataset.size !== undefined) {
      state.quiz.size = b.dataset.size === 'All' ? 'All' : Number(b.dataset.size);
      renderQuiz();
    } else if (b.id === 'quiz-start-btn') startQuiz();
    else if (b.id === 'quiz-next') nextQuizQuestion();
    else if (b.id === 'quiz-restart') {
      const size = state.quiz.size;
      state.quiz = freshQuiz();
      state.quiz.size = size;
      renderQuiz();
    } else if (b.dataset.choice !== undefined) answerQuiz(Number(b.dataset.choice));
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const front = $('#add-front').value.trim();
    const back = $('#add-back').value.trim();
    const deck = $('#add-deck').value.trim();
    if (!front || !back || !deck) return;
    try {
      const { card } = await FlashStore.addCard({ front, back, deck });
      state.cards.push(card);
      renderDeckControls();
      $('#add-front').value = '';
      $('#add-back').value = '';
      const flash = $('#add-flash');
      flash.hidden = false;
      clearTimeout(flash._t);
      flash._t = setTimeout(() => { flash.hidden = true; }, 1800);
      $('#add-front').focus();
    } catch (err) {
      toast(`Add failed: ${err.message}`);
    }
  });

  $('#add-form').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#add-form').requestSubmit();
  });

  $('#browse-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'sure?';
      btn.classList.add('confirm');
      return;
    }
    const id = btn.dataset.del;
    try {
      await FlashStore.deleteCard(id);
      state.cards = state.cards.filter((c) => c.id !== id);
      renderDeckControls();
      renderBrowse();
    } catch (err) {
      toast(`Delete failed: ${err.message}`);
    }
  });

  $('#copy-stats-browse').addEventListener('click', (e) =>
    copyStats(e.target, $('#stats-fallback')));

  // Data panel (backup / transfer) — only wired when the adapter supports it.
  $('#export-data').addEventListener('click', async (e) => {
    if (!FlashStore.exportData) return;
    const text = FlashStore.exportData();
    $('#data-json').value = text;
    $('#data-msg').textContent = 'Exported. Copy this somewhere safe (Notes works well).';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        $('#data-msg').textContent = 'Exported and copied to clipboard.';
      }
    } catch { /* textarea copy is enough */ }
  });

  $('#import-data').addEventListener('click', () => {
    if (!FlashStore.importData) return;
    const text = $('#data-json').value.trim();
    if (!text) {
      $('#data-msg').textContent = 'Paste exported JSON above first.';
      return;
    }
    try {
      const summary = FlashStore.importData(text);
      $('#data-msg').textContent = `${summary} Reloading…`;
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      $('#data-msg').textContent = `Import failed: ${err.message}`;
    }
  });
}

/* ---------- init ---------- */

async function init() {
  bindEvents();
  try {
    const { cards, history } = await FlashStore.load();
    state.cards = cards;
    state.history = history;
  } catch (err) {
    $('#review-area').innerHTML = `<div class="panel empty-panel"><p>Could not load cards: ${esc(err.message)}</p></div>`;
    $('#view-review').hidden = false;
    return;
  }
  renderDeckControls();
  switchView('review');
}

init();

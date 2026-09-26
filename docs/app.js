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

function wordDetails(card) {
  return {
    wordNumber: Number.isSafeInteger(card.wordNumber) && card.wordNumber > 0 ? card.wordNumber : null,
    memoryReading: typeof card.memoryReading === 'string' ? card.memoryReading : '',
    chineseReading: typeof card.chineseReading === 'string' ? card.chineseReading : '',
    forms: Array.isArray(card.forms) ? card.forms.filter((form) => typeof form === 'string') : [],
  };
}

function parseForms(text) {
  return [...new Set(text.split(/[,，\r\n]+/).map((form) => form.trim()).filter(Boolean))];
}

function wordBackHtml(card) {
  const details = wordDetails(card);
  const section = (label, value) => value
    ? `<div class="word-detail"><span class="micro-label">${label}</span><div>${esc(value)}</div></div>` : '';
  return `<div class="word-back">
    ${details.wordNumber === null ? '' : `<div class="micro-label">#${details.wordNumber}</div>`}
    ${section('🧠 好记读法', details.memoryReading)}
    ${section('🗣 简单中文读法', details.chineseReading)}
    ${section('🇨🇳 中文意思', card.back)}
    ${section('词形变化', details.forms.join(' / '))}
  </div>`;
}

function speakEnglish(text) {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
  const value = String(text || '').trim();
  if (!value) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = 'en-US';
  window.speechSynthesis.speak(utterance);
}

function deckDisplayName(deck) {
  if (deck === 'Words') return '单词';
  if (deck === 'Sentences') return '长句';
  return deck;
}

function localizedLogNote(logged) {
  const note = FlashStore.logNote(logged);
  const labels = {
    'Logging…': '正在记录…',
    'Logged to ~/drills/log.txt': '已记录到 ~/drills/log.txt',
    'Could not write ~/drills/log.txt': '无法写入 ~/drills/log.txt',
    'Saving…': '正在保存…',
    'Saved on this device': '已保存在本机',
    'Could not save on this device': '无法保存在本机',
  };
  return labels[note] || note;
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
  if (diff <= 0) return '现在';
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分钟后`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时后`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} 天后`;
  return `${Math.round(d / 30)} 个月后`;
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
    .map((n) => `<option value="${esc(n)}">${esc(n === 'All' ? '全部' : deckDisplayName(n))}</option>`)
    .join('');
  sel.value = state.deckFilter;
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
  return state.deckFilter === 'All' ? '全部分类' : deckDisplayName(state.deckFilter);
}

function renderReview() {
  const s = state.session;
  const area = $('#review-area');
  $('#due-count').textContent = s.complete ? '' : `待复习：${s.queue.length} 张卡片`;

  if (s.complete) {
    const pct = Math.round((s.correct / s.reviewed) * 100);
    const logNote = localizedLogNote(s.logged);
    area.innerHTML = `
      <div class="panel complete-panel">
        <div class="micro-label">本轮完成 · ${esc(deckLabel())}</div>
        <p class="complete-stats">已复习 ${s.reviewed} 张卡片 · 记住了 ${s.correct} 张 · 再来一次 ${s.again} 张 · 正确率 ${pct}%</p>
        <div class="micro-label lognote${s.logged === false ? ' warn' : ''}">${logNote}</div>
        <div class="complete-actions">
          <button class="btn btn-primary" id="copy-stats-complete">复制学习统计</button>
          <button class="btn" id="review-again">再次复习</button>
        </div>
        <pre id="stats-fallback-complete" class="stats-pre" hidden></pre>
      </div>`;
    return;
  }

  if (!s.queue.length) {
    const pool = state.cards.filter(inFilter);
    const upcoming = pool.filter((c) => !dueNow(c)).sort((a, b) => a.due - b.due)[0];
    const hint = pool.length === 0
      ? '这个分类还没有卡片，去新增一些吧。'
      : upcoming ? `下张卡片复习时间：${fmtRelative(upcoming.due)}。` : '';
    area.innerHTML = `
      <div class="panel empty-panel">
        <div class="micro-label">暂无待复习卡片</div>
        <p>${esc(deckLabel())}当前没有待复习卡片。</p>
        <p class="muted">${esc(hint)}</p>
      </div>`;
    return;
  }

  const card = state.cards.find((c) => c.id === s.queue[s.pos]);
  s.currentId = card.id;
  const arrowsOff = s.queue.length < 2 ? 'disabled' : '';
  area.innerHTML = `
    <div class="review-stage">
      <button class="card-arrow" id="card-prev" title="上一张（←）" aria-label="上一张" ${arrowsOff}>‹</button>
      <div class="card-slot">
        <button class="card-flip${s.revealed ? ' flipped' : ' revealable'}" id="card-face">
          <div class="card-flip-inner">
            <div class="card-face face-front" aria-hidden="${s.revealed}">
              <div class="card-front">${esc(card.front)}</div>
              <div class="micro-label">点击查看答案 · 空格键</div>
            </div>
            <div class="card-face face-back" aria-hidden="${!s.revealed}">
              ${card.deck === 'Words' ? wordBackHtml(card) : `<div class="card-front">${esc(card.front)}</div><div class="card-back">${esc(card.back)}</div>`}
              <div class="micro-label">点击返回正面 · 空格键</div>
            </div>
          </div>
        </button>
        <button type="button" class="speak-front" id="speak-front"
          title="美式发音" aria-label="美式发音"
          ${s.revealed ? 'hidden' : ''}>🔊</button>
      </div>
      <button class="card-arrow" id="card-next" title="下一张（→）" aria-label="下一张" ${arrowsOff}>›</button>
      <div class="grade-row" ${s.revealed ? '' : 'hidden'}>
        <button class="btn-grade btn-again" id="grade-again" title="10 分钟后再复习（按键：1）">再来一次</button>
        <button class="btn-grade btn-got" id="grade-got" title="延长下次复习间隔（按键：2）">记住了</button>
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
  const speak = $('#speak-front');
  if (speak) speak.hidden = flipped;
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
    toast(`保存失败： ${err.message}`);
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
      toast(`关联卡片保存失败： ${err.message}`);
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
        return `${deckDisplayName(d)} ${cs.length} 张卡片（${cs.filter(dueNow).length} 张待复习）`;
      }).join(' · ')
    : '暂无卡片';

  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const dueToday = state.cards.filter((c) => c.due < endOfToday).length;

  const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const recent = state.history.filter((h) => h.date >= cutoff);
  const rev = recent.reduce((n, h) => n + h.reviewed, 0);
  const cor = recent.reduce((n, h) => n + h.correct, 0);
  const accLine = rev ? `${Math.round((cor / rev) * 100)}%（复习 ${rev} 次）` : '暂无复习记录';

  const lapsed = state.cards
    .filter((c) => c.lapses > 0)
    .sort((a, b) => b.lapses - a.lapses)
    .slice(0, 5);
  const lapsedLine = lapsed.length
    ? lapsed.map((c) => `"${c.front}" ×${c.lapses}`).join(', ')
    : '暂无';

  return [
    `FlashDesk 学习统计 — ${localDate(now)}`,
    `分类： ${deckLine}`,
    `今日待复习（全部分类）： ${dueToday}`,
    `近 7 天正确率： ${accLine}`,
    `遗忘最多的卡片： ${lapsedLine}`,
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
    btn.textContent = '已复制 ✓';
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
const QUIZ_DIR_LABELS = { keyword: '关键词', definition: '释义', mixed: '随机混合' };

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
          <div class="micro-label">测验</div>
          <p>${esc(deckLabel())}至少需要 4 个不同词条才能开始测验。</p>
        </div>`;
      return;
    }
    area.innerHTML = `
      <div class="panel quiz-start">
        <div class="micro-label">测验 · ${esc(deckLabel())}</div>
        <p>题目随机抽取；答错的卡片会立即回到复习队列。</p>
        <div class="quiz-length">
          <span class="micro-label">出题方向</span>
          <div class="quiz-length-opts">
            ${QUIZ_DIRECTIONS.map((d) => {
              const active = q.direction === d ? ' active' : '';
              return `<button class="quiz-len${active}" data-quizdir="${d}">${QUIZ_DIR_LABELS[d]}</button>`;
            }).join('')}
          </div>
        </div>
        <div class="quiz-length">
          <span class="micro-label">题数</span>
          <div class="quiz-length-opts">
            ${QUIZ_LENGTHS.map((len) => {
              const active = q.size === len ? ' active' : '';
              const label = len === 'All' ? `全部（${pool.length} 题）` : len;
              return `<button class="quiz-len${active}" data-size="${len}">${label}</button>`;
            }).join('')}
          </div>
        </div>
        <button class="btn btn-primary" id="quiz-start-btn">开始测验</button>
      </div>`;
    return;
  }

  if (q.phase === 'question') {
    const question = q.questions[q.idx];
    const answered = q.answered !== null;
    area.innerHTML = `
      <div class="micro-label quiz-progress">第 ${q.idx + 1} / ${q.questions.length} 题</div>
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
        ? `<div class="quiz-next-row"><button class="btn btn-primary" id="quiz-next">${q.idx + 1 < q.questions.length ? '下一题' : '查看结果'}</button></div>`
        : ''}`;
    return;
  }

  const total = q.questions.length;
  const pct = Math.round((q.correct / total) * 100);
  const missed = q.missedIds.map((id) => q.questions.find((qq) => qq.cardId === id)).filter(Boolean);
  const logNote = localizedLogNote(q.logged);
  area.innerHTML = `
    <div class="panel quiz-done">
      <div class="micro-label">测验完成 · ${esc(deckLabel())}</div>
      <div class="quiz-score">得分：${q.correct}/${total} · 正确率 ${pct}%</div>
      <div class="micro-label lognote${q.logged === false ? ' warn' : ''}">${logNote}</div>
      ${missed.length
        ? `<div class="quiz-missed">
            ${missed.map((m) => `
              <div class="quiz-missed-item">
                <div>${esc(m.front)}</div>
                <div class="answer">${esc(m.correct)}</div>
              </div>`).join('')}
          </div>
          <p class="muted">这些卡片已回到复习队列。</p>`
        : '<p class="muted">全部答对，继续保持！</p>'}
      <button class="btn btn-primary" id="quiz-restart">再测一次</button>
    </div>`;
}

/* ---------- browse ---------- */

function renderBrowse() {
  const cards = state.cards.filter(inFilter).sort((a, b) => a.due - b.due);
  const scope = state.deckFilter === 'All' ? '' : ` · ${deckDisplayName(state.deckFilter)}`;
  $('#browse-count').textContent = `${cards.length} 张卡片${scope}`;

  const groups = new Map();
  for (const card of cards) {
    if (!groups.has(card.deck)) groups.set(card.deck, []);
    groups.get(card.deck).push(card);
  }

  const priority = { Words: 0, Sentences: 1 };
  const deckNames = [...groups.keys()].sort((a, b) => {
    const rankA = priority[a] ?? 2;
    const rankB = priority[b] ?? 2;
    return rankA - rankB || a.localeCompare(b);
  });

  $('#browse-table tbody').innerHTML = deckNames.map((deck) => {
    const group = groups.get(deck);
    const label = `${deckDisplayName(deck)} · ${group.length} 张`;
    const rows = group.map((c) => `
      <tr>
        <td class="cell-text" title="${esc(c.front)}">${c.deck === 'Words' ? `<div class="micro-label">#${wordDetails(c).wordNumber ?? '未编号'}</div>` : ''}${esc(c.front)}</td>
        <td class="cell-text" title="${esc(c.back)}">${esc(c.back)}</td>
        <td class="num">${esc(deckDisplayName(c.deck))}</td>
        <td class="num">${fmtRelative(c.due)}</td>
        <td class="num">${c.streak}</td>
        <td class="num">${c.lapses}</td>
        <td><button type="button" class="btn" data-edit="${esc(c.id)}">编辑</button> <button class="x-btn" data-del="${esc(c.id)}" title="删除卡片">✕</button></td>
      </tr>`).join('');
    return `<tr class="browse-group-row"><th colspan="7" scope="rowgroup">${esc(label)}</th></tr>${rows}`;
  }).join('');
}

/* ---------- add form ---------- */

function updateAddForm() {
  const isSentence = $('#add-type').value === 'Sentences';
  $('#add-front-label').textContent = isSentence ? '英文长句' : '英文单词';
  $('#add-front').placeholder = isSentence ? '例如：Could you help me with this?' : '例如：apple';
  $('#add-back-label').textContent = isSentence ? '中文理解 / 学习备注' : '中文意思';
  $('#add-back').placeholder = isSentence ? '填写句子的中文理解或学习备注' : '例如：苹果；可填写用法备注';
  $('#add-submit').textContent = isSentence ? '添加长句' : '添加单词';
  document.querySelectorAll('[data-word-field]').forEach((field) => { field.hidden = isSentence; });
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
    updateAddForm();
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
    if (b.id === 'speak-front') {
      e.stopPropagation();
      const card = state.cards.find((c) => c.id === state.session.currentId);
      if (card) speakEnglish(card.front);
    } else if (b.id === 'card-face') toggleFlip();
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

  $('#add-type').addEventListener('change', updateAddForm);

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const front = $('#add-front').value.trim();
    const back = $('#add-back').value.trim();
    const deck = $('#add-type').value;
    if (!front || !back || !deck) return;
    const submit = $('#add-submit');
    if (submit.disabled) return;
    const fields = { front, back, deck };
    if (deck === 'Words') {
      fields.memoryReading = $('#add-memory-reading').value.trim();
      fields.chineseReading = $('#add-chinese-reading').value.trim();
      fields.forms = parseForms($('#add-forms').value);
    }
    submit.disabled = true;
    try {
      const { card } = await FlashStore.addCard(fields);
      state.cards.push(card);
      renderDeckControls();
      $('#add-front').value = '';
      $('#add-back').value = '';
      if (deck === 'Words') {
        $('#add-memory-reading').value = '';
        $('#add-chinese-reading').value = '';
        $('#add-forms').value = '';
      }
      const flash = $('#add-flash');
      flash.hidden = false;
      clearTimeout(flash._t);
      flash._t = setTimeout(() => { flash.hidden = true; }, 1800);
      $('#add-front').focus();
    } catch (err) {
      toast(`添加失败： ${err.message}`);
    } finally {
      submit.disabled = false;
    }
  });

  $('#add-form').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#add-form').requestSubmit();
  });

  $('#browse-table').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const card = state.cards.find((c) => c.id === edit.dataset.edit);
      if (!card) return;
      const form = $('#edit-form');
      form.dataset.cardId = card.id;
      $('#edit-front').value = card.front;
      $('#edit-back').value = card.back;
      const isWord = card.deck === 'Words';
      const details = wordDetails(card);
      form.querySelectorAll('[data-edit-word]').forEach((field) => { field.hidden = !isWord; });
      $('#edit-number').textContent = details.wordNumber === null ? '未编号' : `#${details.wordNumber}`;
      $('#edit-front-label').textContent = isWord ? '英文单词' : '英文';
      $('#edit-back-label').textContent = isWord ? '中文意思' : '中文 / 学习备注';
      $('#edit-memory-reading').value = details.memoryReading;
      $('#edit-chinese-reading').value = details.chineseReading;
      $('#edit-forms').value = details.forms.join('\n');
      $('#edit-dialog').showModal();
      $('#edit-front').focus();
      return;
    }
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '确认删除？';
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
      toast(`删除失败： ${err.message}`);
    }
  });

  $('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
  $('#edit-dialog').addEventListener('cancel', (e) => {
    if ($('#edit-save').disabled) e.preventDefault();
  });
  $('#edit-dialog').addEventListener('close', () => {
    // Keep the existing toast visible after it leaves the modal top layer.
    document.body.appendChild($('#toast'));
  });
  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const id = form.dataset.cardId;
    const front = $('#edit-front').value.trim();
    const back = $('#edit-back').value.trim();
    const save = $('#edit-save');
    if (save.disabled || !id || !front || !back) return;
    const fields = { front, back };
    if (state.cards.find((card) => card.id === id)?.deck === 'Words') {
      fields.memoryReading = $('#edit-memory-reading').value.trim();
      fields.chineseReading = $('#edit-chinese-reading').value.trim();
      fields.forms = parseForms($('#edit-forms').value);
    }
    save.disabled = true;
    $('#edit-cancel').disabled = true;
    try {
      const { card } = await FlashStore.updateCard(id, fields);
      const index = state.cards.findIndex((c) => c.id === card.id);
      if (index !== -1) state.cards[index] = card;
      renderBrowse();
      // A body-level toast would be behind the modal; restore it before closing.
      document.body.appendChild($('#toast'));
      $('#edit-dialog').close();
      toast('已保存');
    } catch (err) {
      $('#edit-toast-slot').appendChild($('#toast'));
      toast(`保存失败：${err.message}`);
    } finally {
      save.disabled = false;
      $('#edit-cancel').disabled = false;
    }
  });

  $('#copy-stats-browse').addEventListener('click', (e) =>
    copyStats(e.target, $('#stats-fallback')));

  // Data panel (backup / transfer) — only wired when the adapter supports it.
  $('#export-data').addEventListener('click', async (e) => {
    if (!FlashStore.exportData) return;
    const text = FlashStore.exportData();
    $('#data-json').value = text;
    $('#data-msg').textContent = '已导出，请复制并保存到安全的位置。';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        $('#data-msg').textContent = '已导出并复制到剪贴板。';
      }
    } catch { /* textarea copy is enough */ }
  });

  $('#import-data').addEventListener('click', () => {
    if (!FlashStore.importData) return;
    const text = $('#data-json').value.trim();
    if (!text) {
      $('#data-msg').textContent = '请先在上方粘贴导出的 JSON。';
      return;
    }
    try {
      const summary = FlashStore.importData(text);
      const summaryLabel = summary
        .replace(/^Merged (\d+) new cards? \((\d+) duplicates? skipped\)\.$/, '已合并 $1 张新卡片（跳过 $2 张重复卡片）。')
        .replace(/^Imported (\d+) cards \(full replace\)\.$/, '已导入 $1 张卡片（替换全部数据）。');
      $('#data-msg').textContent = `${summaryLabel} 正在重新加载…`;
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      $('#data-msg').textContent = `导入失败： ${err.message}`;
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
    $('#review-area').innerHTML = `<div class="panel empty-panel"><p>无法加载卡片： ${esc(err.message)}</p></div>`;
    $('#view-review').hidden = false;
    return;
  }
  renderDeckControls();
  switchView('review');
}

init();

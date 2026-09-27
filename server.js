// FlashDesk — zero-dependency local flashcard server.
// Serves public/ and a small JSON API; persists to flashdesk-data.json;
// appends one line per finished review session to ~/drills/log.txt.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const seed = require('./seed.js');

const PORT = 5902;
const DATA_FILE = path.join(__dirname, 'flashdesk-data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(os.homedir(), 'drills', 'log.txt');

const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const LADDER = [1, 3, 7, 14, 30, 60]; // days by streak; streak ≥ 6 stays at 60

let data;

function makeId() {
  return 'c_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6);
}

function toCard({ front, back, deck }) {
  const now = Date.now();
  return { id: makeId(), front, back, deck, due: now, streak: 0, lapses: 0, created: now };
}

function wordDefaults(card) {
  if (card.deck !== 'Words') return card;
  return {
    ...card,
    wordNumber: card.wordNumber ?? null,
    memoryReading: card.memoryReading ?? '',
    chineseReading: card.chineseReading ?? '',
    forms: card.forms ?? [],
  };
}

function wordFields(fields) {
  const memoryReading = fields.memoryReading === undefined ? '' : fields.memoryReading;
  const chineseReading = fields.chineseReading === undefined ? '' : fields.chineseReading;
  if (typeof memoryReading !== 'string' || typeof chineseReading !== 'string') {
    throw new Error('发音拆解和中文近似必须是字符串');
  }
  const forms = fields.forms === undefined ? [] : fields.forms;
  if (!Array.isArray(forms) || forms.some((form) => typeof form !== 'string')) {
    throw new Error('词形变化必须是字符串数组');
  }
  return {
    memoryReading: memoryReading.trim(),
    chineseReading: chineseReading.trim(),
    forms: [...new Set(forms.map((form) => form.trim()).filter(Boolean))],
  };
}

function nextWordNumber() {
  let max = 0;
  for (const card of data.cards) {
    if (Number.isSafeInteger(card.wordNumber) && card.wordNumber > max) max = card.wordNumber;
  }
  const saved = data.meta?.nextWordNumber;
  const next = Math.max(max + 1, Number.isSafeInteger(saved) && saved > 0 ? saved : 1);
  if (!Number.isSafeInteger(next) || !Number.isSafeInteger(next + 1)) {
    throw new Error('单词编号已超出安全范围');
  }
  return next;
}

function prepareWord(fields) {
  if (typeof fields.front !== 'string' || !fields.front.trim()
      || typeof fields.back !== 'string' || !fields.back.trim()) {
    throw new Error('英文单词和中文意思必须是非空字符串');
  }
  const front = fields.front.trim();
  if (data.cards.some((card) => card.deck === 'Words'
      && card.front.trim().toLowerCase() === front.toLowerCase())) {
    throw new Error('该单词已存在，请勿重复添加');
  }
  return { ...wordFields(fields), wordNumber: nextWordNumber() };
}

function addCardInMemory(fields) {
  const deck = String(fields?.deck || '').trim();
  const extra = deck === 'Words' ? prepareWord(fields) : {};
  const front = String(fields?.front || '').trim();
  const back = String(fields?.back || '').trim();
  if (!front || !back || !deck) throw new Error('front, back, and deck are all required');
  const card = toCard({ front, back, deck });
  if (deck === 'Words') Object.assign(card, extra);
  if (deck === 'Words') data.meta = { ...data.meta, nextWordNumber: card.wordNumber + 1 };
  data.cards.push(card);
  return card;
}

const cloneData = (value) => JSON.parse(JSON.stringify(value));

function editableWordFields(card, fields) {
  if (card.deck !== 'Words') return {};
  if (data.cards.some((other) => other.id !== card.id && other.deck === 'Words'
      && other.front.trim().toLowerCase() === fields.front.trim().toLowerCase())) {
    throw new Error('该单词已存在，请勿重复添加');
  }
  const normalized = wordFields(fields);
  const changes = {};
  for (const key of ['memoryReading', 'chineseReading', 'forms']) {
    if (fields[key] !== undefined) changes[key] = normalized[key];
  }
  return changes;
}

function saveData() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    data = { cards: seed.map(toCard), history: [] };
    saveData();
    console.log(`FlashDesk: first run — seeded ${data.cards.length} cards`);
    return;
  }
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    const aside = DATA_FILE.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
    fs.renameSync(DATA_FILE, aside);
    console.error(`FlashDesk: data file unreadable (${err.message}); moved to ${aside}, re-seeding`);
    data = { cards: seed.map(toCard), history: [] };
    saveData();
  }
}

const pad = (n) => String(n).padStart(2, '0');

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function logStamp() {
  const d = new Date();
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sessionLogLine({ deck, reviewed, correct, again, hardest }) {
  const pct = Math.round((correct / reviewed) * 100);
  const hard = hardest.length ? hardest.join(', ') : 'none';
  return `[${logStamp()}] FlashDesk — deck: ${deck}, reviewed: ${reviewed}, got-it: ${correct}, again: ${again}, accuracy: ${pct}%, hardest cards: ${hard}`;
}

function quizLogLine({ deck, questions, correct, missedFronts }) {
  const pct = Math.round((correct / questions) * 100);
  const missed = missedFronts.length ? missedFronts.join(', ') : 'none';
  return `[${logStamp()}] FlashDesk quiz — deck: ${deck}, questions: ${questions}, correct: ${correct}, score: ${pct}%, missed: ${missed}`;
}

function appendLog(line) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/cards') {
    return sendJSON(res, 200, {
      cards: data.cards.map(wordDefaults), history: data.history,
      ...(data.meta ? { meta: data.meta } : {}),
    });
  }

  if (req.method === 'POST' && pathname === '/api/cards') {
    const body = await readBody(req);
    const previous = data;
    data = cloneData(data);
    let card;
    try {
      card = addCardInMemory(body);
      saveData();
    }
    catch (err) {
      data = previous;
      return sendJSON(res, 400, { error: err.message });
    }
    return sendJSON(res, 201, { card });
  }

  if (req.method === 'POST' && pathname === '/api/cards/batch') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.items)) return sendJSON(res, 400, { error: 'items must be an array' });
    const previous = data;
    data = cloneData(data);
    const cards = [];
    let addedWords = 0;
    let addedSentences = 0;
    let skipped = 0;
    try {
      for (const fields of body.items) {
        const deck = String(fields?.deck || '').trim();
        if (deck !== 'Words' && deck !== 'Sentences') throw new Error('batch items must be Words or Sentences');
        const front = typeof fields.front === 'string' ? fields.front.trim() : '';
        const back = typeof fields.back === 'string' ? fields.back.trim() : '';
        if (!front || !back) throw new Error('front and back must be non-empty strings');
        const duplicate = deck === 'Words'
          ? data.cards.some((card) => card.deck === 'Words' && card.front.trim().toLowerCase() === front.toLowerCase())
          : data.cards.some((card) => card.deck === 'Sentences' && card.front.trim() === front);
        if (duplicate) { skipped += 1; continue; }
        const card = addCardInMemory({ ...fields, front, back, deck });
        cards.push(card);
        if (deck === 'Words') addedWords += 1;
        else addedSentences += 1;
      }
      saveData();
    } catch (err) {
      data = previous;
      return sendJSON(res, 400, { error: err.message });
    }
    return sendJSON(res, 201, {
      cards, addedWords, addedSentences, skipped,
      ...(data.meta ? { meta: data.meta } : {}),
    });
  }

  if (req.method === 'POST' && pathname === '/api/cards/grade') {
    const body = await readBody(req);
    const card = data.cards.find((c) => c.id === body.id);
    if (!card) return sendJSON(res, 404, { error: 'card not found' });
    if (body.grade === 'again') {
      card.due = Date.now() + TEN_MINUTES;
      card.streak = 0;
      card.lapses += 1;
    } else if (body.grade === 'got') {
      card.streak += 1;
      card.due = Date.now() + LADDER[Math.min(card.streak, LADDER.length) - 1] * DAY;
    } else {
      return sendJSON(res, 400, { error: 'grade must be "again" or "got"' });
    }
    saveData();
    return sendJSON(res, 200, { card });
  }

  const update = pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (req.method === 'PATCH' && update) {
    const card = data.cards.find((c) => c.id === update[1]);
    if (!card) return sendJSON(res, 404, { error: 'card not found' });
    const body = await readBody(req);
    if (!body || typeof body.front !== 'string' || !body.front.trim()
        || typeof body.back !== 'string' || !body.back.trim()) {
      return sendJSON(res, 400, { error: 'front and back must be non-empty strings' });
    }
    let changes;
    try { changes = editableWordFields(card, body); }
    catch (err) { return sendJSON(res, 400, { error: err.message }); }
    const previous = { ...card };
    card.front = body.front.trim();
    card.back = body.back.trim();
    for (const key of Object.keys(changes)) card[key] = changes[key];
    try { saveData(); }
    catch (err) {
      for (const key of Object.keys(changes)) delete card[key];
      Object.assign(card, previous);
      throw err;
    }
    return sendJSON(res, 200, { card });
  }

  const del = pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (req.method === 'DELETE' && del) {
    const idx = data.cards.findIndex((c) => c.id === del[1]);
    if (idx === -1) return sendJSON(res, 404, { error: 'card not found' });
    // Capture legacy numbering before removing a numbered card.
    if (Number.isSafeInteger(data.cards[idx].wordNumber) && data.cards[idx].wordNumber > 0) {
      data.meta = { ...data.meta, nextWordNumber: nextWordNumber() };
    }
    data.cards.splice(idx, 1);
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/session') {
    const body = await readBody(req);
    const reviewed = Number(body.reviewed);
    const correct = Number(body.correct) || 0;
    const again = Number(body.again) || 0;
    const deck = String(body.deck || 'All');
    const hardest = Array.isArray(body.hardest) ? body.hardest.slice(0, 2).map(String) : [];
    if (!Number.isFinite(reviewed) || reviewed < 1) return sendJSON(res, 400, { error: 'reviewed must be >= 1' });
    data.history.push({ date: localDate(), deck, reviewed, correct });
    saveData();
    try {
      appendLog(sessionLogLine({ deck, reviewed, correct, again, hardest }));
      return sendJSON(res, 200, { ok: true, logged: true });
    } catch (err) {
      return sendJSON(res, 200, { ok: true, logged: false, logError: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/quiz') {
    const body = await readBody(req);
    const questions = Number(body.questions);
    const correct = Number(body.correct) || 0;
    const deck = String(body.deck || 'All');
    const missedIds = Array.isArray(body.missedIds) ? body.missedIds.map(String) : [];
    if (!Number.isFinite(questions) || questions < 1) return sendJSON(res, 400, { error: 'questions must be >= 1' });
    // Missed cards come due immediately; streak/lapses stay untouched so the
    // quiz never distorts the spaced-repetition stats.
    const now = Date.now();
    const missedFronts = [];
    for (const id of missedIds) {
      const card = data.cards.find((c) => c.id === id);
      if (!card) continue;
      if (card.due > now) card.due = now;
      missedFronts.push(card.front);
    }
    saveData();
    try {
      appendLog(quizLogLine({ deck, questions, correct, missedFronts }));
      return sendJSON(res, 200, { ok: true, logged: true });
    } catch (err) {
      return sendJSON(res, 200, { ok: true, logged: false, logError: err.message });
    }
  }

  sendJSON(res, 404, { error: 'not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJSON(res, 400, { error: 'bad url' });
  }
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    serveStatic(res, pathname);
  } catch (err) {
    sendJSON(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`FlashDesk: port ${PORT} already in use — is another FlashDesk running? (lsof -i :${PORT})`);
    process.exit(1);
  }
  throw err;
});

loadData();
server.listen(PORT, () => {
  console.log(`FlashDesk → http://localhost:${PORT}`);
  console.log(`  data: ${DATA_FILE}`);
  console.log(`  log:  ${LOG_FILE}`);
});

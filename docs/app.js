// FlashDesk client — state, review session machine, add/browse views, stats copy.

const $ = (sel) => document.querySelector(sel);

const state = {
  cards: [],
  history: [],
  deckFilter: 'All',
  view: 'review',
  session: null,
  quiz: null,
  wordLibrary: {
    query: '',
    filter: 'all',
    selectedId: null,
  },
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
    ${section('🧠 发音拆解', details.memoryReading)}
    ${section('🗣 中文近似', details.chineseReading)}
    ${section('🇨🇳 中文意思', card.back)}
    ${section('词形变化', details.forms.join(' / '))}
  </div>`;
}

function sentenceFrontHtml(text) {
  const value = String(text || '');
  const pattern = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g;
  let html = '';
  let pos = 0;
  for (const match of value.matchAll(pattern)) {
    html += esc(value.slice(pos, match.index));
    const word = match[0];
    html += `<span class="speakable-word" data-speak-word="${esc(word)}">${esc(word)}</span>`;
    pos = match.index + word.length;
  }
  return html + esc(value.slice(pos));
}

const SPEECH_SETTINGS_KEY = 'flashdesk-speech-settings';
const SPEECH_RATES = [0.75, 0.85, 0.9, 1, 1.1];
const DEFAULT_SPEECH_RATE = 0.9;

function loadSpeechSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SPEECH_SETTINGS_KEY) || '{}');
    return {
      voiceURI: typeof saved.voiceURI === 'string' ? saved.voiceURI : '',
      rate: SPEECH_RATES.includes(Number(saved.rate)) ? Number(saved.rate) : DEFAULT_SPEECH_RATE,
    };
  } catch {
    return { voiceURI: '', rate: DEFAULT_SPEECH_RATE };
  }
}

const speechSettings = loadSpeechSettings();
let speechVoices = [];
let speechVoiceListenerBound = false;

function saveSpeechSettings() {
  try { localStorage.setItem(SPEECH_SETTINGS_KEY, JSON.stringify(speechSettings)); } catch { /* private mode */ }
}

function voiceNameRank(voice) {
  const name = String(voice.name || '').toLowerCase();
  if (name.includes('google')) return 0;
  if (name.includes('us english') || name.includes('united states')) return 1;
  return 2;
}

function voiceLanguageRank(voice) {
  const lang = String(voice.lang || '').toLowerCase();
  if (lang === 'en-us') return 0;
  if (lang.startsWith('en-us')) return 1;
  if (lang.startsWith('en-')) return 2;
  return 3;
}

function rankEnglishVoices(voices) {
  return [...voices]
    .filter((voice) => voiceLanguageRank(voice) < 3)
    .sort((a, b) => voiceLanguageRank(a) - voiceLanguageRank(b)
      || voiceNameRank(a) - voiceNameRank(b)
      || String(a.name || '').localeCompare(String(b.name || ''), 'en'));
}

function speechSupported() {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined';
}

function selectedSpeechVoice() {
  return speechVoices.find((voice) => voice.voiceURI === speechSettings.voiceURI)
    || speechVoices[0]
    || null;
}

function renderSpeechSettings() {
  const select = $('#speech-voice');
  const status = $('#speech-status');
  const rate = $('#speech-rate');
  const test = $('#speech-test');
  if (!select || !status || !rate || !test) return;

  rate.value = String(speechSettings.rate);
  if (!speechSupported()) {
    select.innerHTML = '<option value="">语音不可用</option>';
    select.disabled = true;
    rate.disabled = true;
    test.disabled = true;
    status.hidden = false;
    status.textContent = '当前浏览器不支持语音朗读，请使用 Chrome 或支持 Web Speech API 的浏览器。';
    return;
  }

  rate.disabled = false;
  test.disabled = false;
  if (!speechVoices.length) {
    select.innerHTML = '<option value="">系统默认英语声音 · en-US</option>';
    select.disabled = true;
    status.hidden = false;
    status.textContent = '正在读取设备声音；仍可使用系统默认美式发音。';
    return;
  }

  select.disabled = false;
  select.innerHTML = speechVoices.map((voice) =>
    `<option value="${esc(voice.voiceURI)}">${esc(voice.name || 'English')} · ${esc(voice.lang || 'en')}</option>`).join('');
  const selected = selectedSpeechVoice();
  select.value = selected ? selected.voiceURI : '';
  status.hidden = true;
}

function refreshSpeechVoices() {
  if (!speechSupported()) {
    speechVoices = [];
  } else {
    try { speechVoices = rankEnglishVoices(window.speechSynthesis.getVoices()); } catch { speechVoices = []; }
  }
  renderSpeechSettings();
}

function initSpeechSettings() {
  renderSpeechSettings();
  if (!speechSupported()) return;
  refreshSpeechVoices();
  if (speechVoiceListenerBound) return;
  const synthesis = window.speechSynthesis;
  if (typeof synthesis.addEventListener === 'function') {
    synthesis.addEventListener('voiceschanged', refreshSpeechVoices);
  } else {
    synthesis.onvoiceschanged = refreshSpeechVoices;
  }
  speechVoiceListenerBound = true;
}

function speakEnglish(text, options = {}) {
  if (!speechSupported()) return false;
  const value = String(text || '').trim();
  if (!value) return false;

  try {
    const synthesis = window.speechSynthesis;
    if (!speechVoices.length) refreshSpeechVoices();
    synthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = 'en-US';
    const voice = selectedSpeechVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = Number.isFinite(options.rate) ? options.rate : speechSettings.rate;
    utterance.pitch = 1;
    if (typeof synthesis.resume === 'function') synthesis.resume();
    synthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

function previewSpeech() {
  speakEnglish('Hello, this is a pronunciation test.');
}

const TTS_SETTINGS_KEY = 'flashdesk-tts-settings';
const TTS_SAMPLE = 'Hello, this is a pronunciation test.';

function normalizeTtsEndpoint(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return '';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/tts$/, '') || '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function loadTtsSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(TTS_SETTINGS_KEY) || '{}');
    return {
      endpoint: normalizeTtsEndpoint(saved.endpoint),
      token: typeof saved.token === 'string' ? saved.token : '',
    };
  } catch {
    return { endpoint: '', token: '' };
  }
}

const ttsSettings = loadTtsSettings();
const ttsAudioCache = new Map();
const ttsPendingAudio = new Map();
const ttsVoiceByEndpoint = new Map();
const loadingSpeechButtons = new Set();
let currentEnglishAudio = null;
let englishPlaybackRequest = 0;

function ttsConfigured() {
  return Boolean(ttsSettings.endpoint && ttsSettings.token);
}

function saveTtsSettings() {
  try { localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(ttsSettings)); } catch { /* private mode */ }
}

function setTtsStatus(message, isError = false) {
  const status = $('#tts-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('warn', isError);
}

function renderTtsSettings() {
  const endpoint = $('#tts-endpoint');
  const token = $('#tts-token');
  if (!endpoint || !token) return;
  endpoint.value = ttsSettings.endpoint;
  token.value = ttsSettings.token;
  setTtsStatus(ttsConfigured() ? '高质量发音已配置。' : '未配置时自动使用系统发音。');
}

function saveTtsSettingsFromForm() {
  const endpointInput = $('#tts-endpoint').value.trim();
  const token = $('#tts-token').value.trim();
  if (!endpointInput && !token) {
    ttsSettings.endpoint = '';
    ttsSettings.token = '';
    saveTtsSettings();
    setTtsStatus('已清除高质量发音设置，将使用系统发音。');
    return true;
  }
  const endpoint = normalizeTtsEndpoint(endpointInput);
  if (!endpoint || !token) {
    setTtsStatus('请填写有效的 HTTPS Worker 地址和访问密钥。', true);
    return false;
  }
  ttsSettings.endpoint = endpoint;
  ttsSettings.token = token;
  saveTtsSettings();
  $('#tts-endpoint').value = endpoint;
  setTtsStatus('高质量发音设置已保存。');
  return true;
}

function ttsCacheKey(text, voice = ttsVoiceByEndpoint.get(ttsSettings.endpoint) || 'worker-default') {
  return JSON.stringify([ttsSettings.endpoint, voice, text]);
}

function ttsRequestUrl() {
  return `${ttsSettings.endpoint}/tts`;
}

async function fetchTtsAudio(text) {
  const key = ttsCacheKey(text);
  if (ttsAudioCache.has(key)) return ttsAudioCache.get(key);
  if (ttsPendingAudio.has(key)) return ttsPendingAudio.get(key);

  const pending = (async () => {
    const response = await fetch(ttsRequestUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ttsSettings.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`TTS request failed (${response.status})`);
    const voice = response.headers.get('X-FlashDesk-Voice-ID') || 'worker-default';
    ttsVoiceByEndpoint.set(ttsSettings.endpoint, voice);
    const blob = await response.blob();
    if (!blob || !String(blob.type || '').startsWith('audio/')) throw new Error('TTS response is not audio');
    const objectUrl = URL.createObjectURL(blob);
    ttsAudioCache.set(ttsCacheKey(text, voice), objectUrl);
    return objectUrl;
  })();

  ttsPendingAudio.set(key, pending);
  try {
    return await pending;
  } finally {
    ttsPendingAudio.delete(key);
  }
}

function setSpeechButtonLoading(button, loading) {
  if (!button) return;
  if (loading) {
    if (!button.dataset.speechLabel) button.dataset.speechLabel = button.textContent;
    button.textContent = '加载中…';
    button.disabled = true;
    loadingSpeechButtons.add(button);
  } else {
    if (button.dataset.speechLabel) button.textContent = button.dataset.speechLabel;
    button.disabled = false;
    loadingSpeechButtons.delete(button);
  }
}

function stopEnglishPlayback() {
  englishPlaybackRequest += 1;
  if (currentEnglishAudio) {
    try { currentEnglishAudio.pause(); currentEnglishAudio.currentTime = 0; } catch { /* already stopped */ }
    currentEnglishAudio = null;
  }
  if (speechSupported()) {
    try { window.speechSynthesis.cancel(); } catch { /* unavailable */ }
  }
  for (const button of [...loadingSpeechButtons]) setSpeechButtonLoading(button, false);
}

async function playEnglish(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return 'failed';
  const rate = Number(options.rate) === 0.75 ? 0.75 : 1;
  const button = options.button || null;
  stopEnglishPlayback();
  const requestId = englishPlaybackRequest;

  if (ttsConfigured() && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    setSpeechButtonLoading(button, true);
    try {
      const objectUrl = await fetchTtsAudio(value);
      if (requestId !== englishPlaybackRequest) return 'cancelled';
      const audio = new Audio(objectUrl);
      audio.playbackRate = rate;
      currentEnglishAudio = audio;
      await audio.play();
      if (requestId !== englishPlaybackRequest) return 'cancelled';
      setTtsStatus('正在使用 ElevenLabs 高质量发音。');
      return 'elevenlabs';
    } catch {
      if (requestId !== englishPlaybackRequest) return 'cancelled';
      setTtsStatus('高质量发音暂时不可用，已切换到系统发音。', true);
    } finally {
      setSpeechButtonLoading(button, false);
    }
  }

  if (speakEnglish(value, { rate })) return 'system';
  setTtsStatus('发音失败，请检查网络或语音设置。', true);
  toast('发音失败，请检查网络或语音设置。');
  return 'failed';
}

function previewHighQualitySpeech(button) {
  return playEnglish(TTS_SAMPLE, { rate: 1, button });
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

const WORD_LIBRARY_FILTERS = ['all', 'due', 'new', 'lapsed', 'mastered'];
const WORD_LIBRARY_LABELS = {
  all: '全部',
  due: '待复习',
  new: '新词',
  lapsed: '易错',
  mastered: '已掌握',
};

function wordLibraryMatches(card, filter, now = Date.now()) {
  if (card.deck !== 'Words') return false;
  if (filter === 'due') return Number(card.due) <= now;
  if (filter === 'new') return Number(card.streak || 0) === 0 && Number(card.lapses || 0) === 0;
  if (filter === 'lapsed') return Number(card.lapses || 0) > 0;
  if (filter === 'mastered') return Number(card.streak || 0) >= 3 && Number(card.lapses || 0) === 0;
  return true;
}

function wordLibrarySearchMatches(card, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  const number = wordDetails(card).wordNumber;
  return String(card.front || '').toLocaleLowerCase().includes(needle)
    || String(card.back || '').toLocaleLowerCase().includes(needle)
    || (number !== null && String(number).includes(needle.replace(/^#/, '')));
}

function compareWordNumbersNewest(a, b) {
  const numberA = wordDetails(a).wordNumber;
  const numberB = wordDetails(b).wordNumber;
  if (numberA !== null && numberB !== null && numberA !== numberB) return numberB - numberA;
  if (numberA !== null) return -1;
  if (numberB !== null) return 1;
  const createdDiff = Number(b.created || 0) - Number(a.created || 0);
  return createdDiff || String(a.front || '').localeCompare(String(b.front || ''), 'en');
}

function wordLibraryCards(cards, { query = '', filter = 'all', now = Date.now() } = {}) {
  const normalizedFilter = WORD_LIBRARY_FILTERS.includes(filter) ? filter : 'all';
  const result = cards
    .filter((card) => wordLibraryMatches(card, normalizedFilter, now))
    .filter((card) => wordLibrarySearchMatches(card, query));
  return result.sort((a, b) => {
    if (normalizedFilter === 'due') return Number(a.due) - Number(b.due) || compareWordNumbersNewest(a, b);
    if (normalizedFilter === 'lapsed') return Number(b.lapses || 0) - Number(a.lapses || 0) || compareWordNumbersNewest(a, b);
    return compareWordNumbersNewest(a, b);
  });
}

function wordLibraryStats(cards, now = Date.now()) {
  const words = cards.filter((card) => card.deck === 'Words');
  return Object.fromEntries(WORD_LIBRARY_FILTERS.map((filter) => [
    filter,
    words.filter((card) => wordLibraryMatches(card, filter, now)).length,
  ]));
}

function formatWordDue(due, now = Date.now()) {
  const value = Number(due);
  if (!Number.isFinite(value)) return '未安排';
  const today = new Date(now);
  const target = new Date(value);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const days = Math.round((targetStart - todayStart) / 86400000);
  if (days < 0) return '已逾期';
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  return `${days}天后`;
}

function wordLearningStatus(card, now = Date.now()) {
  if (Number(card.lapses || 0) > 0) return { key: 'lapsed', label: '易错' };
  if (Number(card.streak || 0) >= 3) return { key: 'mastered', label: '已掌握' };
  if (Number(card.due) <= now) return { key: 'due', label: '待复习' };
  if (Number(card.streak || 0) === 0) return { key: 'new', label: '新词' };
  return { key: 'learning', label: '学习中' };
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
  const sentence = card.deck === 'Sentences';
  const frontHtml = sentence ? sentenceFrontHtml(card.front) : esc(card.front);
  const normalLabel = sentence ? '🔊 整句' : '🔊 正常';
  const slowLabel = sentence ? '🐢 慢速整句' : '🐢 慢速';
  area.innerHTML = `
    <div class="review-stage">
      <button class="card-arrow" id="card-prev" title="上一张（←）" aria-label="上一张" ${arrowsOff}>‹</button>
      <div class="card-slot">
        <button class="card-flip${s.revealed ? ' flipped' : ' revealable'}" id="card-face">
          <div class="card-flip-inner">
            <div class="card-face face-front" aria-hidden="${s.revealed}">
              <div class="card-front${sentence ? ' sentence-front' : ''}">${frontHtml}</div>
              <div class="micro-label">点击查看答案 · 空格键</div>
            </div>
            <div class="card-face face-back" aria-hidden="${!s.revealed}">
              ${card.deck === 'Words' ? wordBackHtml(card) : `<div class="card-front">${esc(card.front)}</div><div class="card-back">${esc(card.back)}</div>`}
              <div class="micro-label">点击返回正面 · 空格键</div>
            </div>
          </div>
        </button>
        <div class="speech-actions" ${s.revealed ? 'hidden' : ''}>
          <button type="button" class="speak-front" id="speak-front" data-speak-rate="1"
            title="美式英语正常发音" aria-label="${normalLabel}">${normalLabel}</button>
          <button type="button" class="speak-front" id="speak-front-slow" data-speak-rate="0.75"
            title="美式英语慢速发音" aria-label="${slowLabel}">${slowLabel}</button>
        </div>
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
  const speechActions = $('#review-area .speech-actions');
  if (speechActions) speechActions.hidden = flipped;
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

/* ---------- Word Library ---------- */

function wordSpeechButtons(card) {
  const id = esc(card.id);
  return `<div class="word-speech-actions">
    <button type="button" class="speak-front" data-word-speak="${id}" data-speak-rate="1"
      aria-label="正常朗读 ${esc(card.front)}">🔊 正常</button>
    <button type="button" class="speak-front" data-word-speak="${id}" data-speak-rate="0.75"
      aria-label="慢速朗读 ${esc(card.front)}">🐢 慢速</button>
  </div>`;
}

function wordListItemHtml(card, now = Date.now()) {
  const details = wordDetails(card);
  const number = details.wordNumber === null ? '#未编号' : `#${details.wordNumber}`;
  const status = wordLearningStatus(card, now);
  return `<article class="word-list-item" data-word-card="${esc(card.id)}">
    <button type="button" class="word-list-main" data-word-open="${esc(card.id)}">
      <span class="word-list-heading"><span class="word-number">${number}</span><strong>${esc(card.front)}</strong></span>
      <span class="word-list-meaning">${esc(card.back)}</span>
      <span class="word-list-meta">
        <span class="word-list-meta-main">${details.forms.length ? `<span class="word-list-forms">${esc(details.forms.join(' · '))}</span><span aria-hidden="true"> · </span>` : ''}<span class="word-status word-status-${status.key}">● ${status.label}</span></span>
        <span class="word-list-due">· ${formatWordDue(card.due, now)}</span>
      </span>
    </button>
    ${wordSpeechButtons(card)}
  </article>`;
}

function wordDetailHtml(card, now = Date.now()) {
  const details = wordDetails(card);
  const number = details.wordNumber === null ? '未编号' : `#${details.wordNumber}`;
  const optionalSection = (label, value) => value
    ? `<section class="word-detail-section"><div class="micro-label">${label}</div><div>${esc(value)}</div></section>`
    : '';
  return `<div class="word-library-detail">
    <button type="button" class="word-library-back" data-word-back>← 返回单词库</button>
    <article class="panel word-detail-card">
      <div class="word-detail-number">${number}</div>
      <div class="word-detail-title-row">
        <h2>${esc(card.front)}</h2>
        ${wordSpeechButtons(card)}
      </div>
      <div class="word-detail-meaning">${esc(card.back)}</div>
      <div class="word-detail-sections">
        ${optionalSection('🧠 发音拆解', details.memoryReading)}
        ${optionalSection('🗣 中文近似', details.chineseReading)}
        ${details.memoryReading || details.chineseReading ? '<p class="pronunciation-note">中文仅作近似提示，标准发音以音频为准。</p>' : ''}
        <section class="word-detail-section"><div class="micro-label">词形变化</div><div class="${details.forms.length ? '' : 'muted'}">${details.forms.length ? esc(details.forms.join(' · ')) : '暂无'}</div></section>
      </div>
      <section class="word-study-panel">
        <div class="micro-label">学习状态</div>
        <dl>
          <div><dt>当前状态</dt><dd>${wordLearningStatus(card, now).label}</dd></div>
          <div><dt>连续答对</dt><dd>${Number(card.streak || 0)}</dd></div>
          <div><dt>错误次数</dt><dd>${Number(card.lapses || 0)}</dd></div>
          <div><dt>下次复习</dt><dd>${formatWordDue(card.due, now)}</dd></div>
        </dl>
      </section>
      <div class="word-detail-actions">
        <button type="button" class="btn btn-primary" data-word-review>开始复习</button>
        <button type="button" class="btn" data-word-edit="${esc(card.id)}">编辑</button>
      </div>
    </article>
  </div>`;
}

function renderWordLibrary() {
  const root = $('#word-library');
  if (!root) return;
  const selected = state.wordLibrary.selectedId
    ? state.cards.find((card) => card.id === state.wordLibrary.selectedId && card.deck === 'Words')
    : null;
  if (selected) {
    root.innerHTML = wordDetailHtml(selected);
    return;
  }
  state.wordLibrary.selectedId = null;
  const stats = wordLibraryStats(state.cards);
  const cards = wordLibraryCards(state.cards, state.wordLibrary);
  const summary = state.wordLibrary.query
    ? `搜索结果 · ${cards.length} 个单词`
    : state.wordLibrary.filter === 'all'
      ? `${stats.all} 个单词`
      : `${WORD_LIBRARY_LABELS[state.wordLibrary.filter]} · ${cards.length} 个单词`;
  root.innerHTML = `<div class="word-library-home">
    <header class="word-library-header">
      <h2>单词库</h2>
      <div class="word-library-summary">${esc(summary)}</div>
    </header>
    <div class="word-library-tools">
      <label class="word-search"><span aria-hidden="true">🔍</span><input id="word-search" type="search" value="${esc(state.wordLibrary.query)}" placeholder="搜索单词、中文或编号" autocomplete="off"></label>
      <div class="word-filter-chips" role="group" aria-label="单词状态筛选">
        ${WORD_LIBRARY_FILTERS.map((filter) => `<button type="button" class="word-filter-chip${state.wordLibrary.filter === filter ? ' active' : ''}" data-word-filter="${filter}">${WORD_LIBRARY_LABELS[filter]} <span>${stats[filter]}</span></button>`).join('')}
      </div>
    </div>
    <div class="word-list">
      ${cards.length ? cards.map((card) => wordListItemHtml(card)).join('') : '<div class="panel empty-panel"><p>没有找到符合条件的单词。</p></div>'}
    </div>
  </div>`;
}

function openEditDialog(card) {
  const form = $('#edit-form');
  form.dataset.cardId = card.id;
  form.dataset.returnView = state.view;
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
}

function handleWordLibraryClick(e) {
  const speech = e.target.closest('[data-word-speak]');
  if (speech) {
    e.preventDefault();
    e.stopPropagation();
    const card = state.cards.find((item) => item.id === speech.dataset.wordSpeak && item.deck === 'Words');
    if (card) playEnglish(card.front, { rate: Number(speech.dataset.speakRate), button: speech });
    return;
  }
  const filter = e.target.closest('[data-word-filter]');
  if (filter) {
    state.wordLibrary.filter = WORD_LIBRARY_FILTERS.includes(filter.dataset.wordFilter) ? filter.dataset.wordFilter : 'all';
    renderWordLibrary();
    return;
  }
  const open = e.target.closest('[data-word-open]');
  if (open) {
    state.wordLibrary.selectedId = open.dataset.wordOpen;
    renderWordLibrary();
    return;
  }
  if (e.target.closest('[data-word-back]')) {
    state.wordLibrary.selectedId = null;
    renderWordLibrary();
    return;
  }
  const edit = e.target.closest('[data-word-edit]');
  if (edit) {
    const card = state.cards.find((item) => item.id === edit.dataset.wordEdit && item.deck === 'Words');
    if (card) openEditDialog(card);
    return;
  }
  if (e.target.closest('[data-word-review]')) {
    state.deckFilter = 'Words';
    renderDeckControls();
    switchView('review');
  }
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
  stopEnglishPlayback();
  state.view = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('btn-active', b.dataset.view === name));
  for (const v of ['review', 'quiz', 'add', 'words', 'browse']) $(`#view-${v}`).hidden = v !== name;
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
  } else if (name === 'words') {
    renderWordLibrary();
  } else if (name === 'add') {
    updateAddForm();
    $('#add-front').focus();
  }
}

/* ---------- events ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.view === 'words') state.wordLibrary.selectedId = null;
      switchView(b.dataset.view);
    }));

  $('#deck-filter').addEventListener('change', (e) => {
    state.deckFilter = e.target.value;
    switchView(state.view); // resets any in-progress session against the new filter
  });

  $('#speech-voice').addEventListener('change', (e) => {
    speechSettings.voiceURI = e.target.value;
    saveSpeechSettings();
  });

  $('#speech-rate').addEventListener('change', (e) => {
    const rate = Number(e.target.value);
    speechSettings.rate = SPEECH_RATES.includes(rate) ? rate : DEFAULT_SPEECH_RATE;
    e.target.value = String(speechSettings.rate);
    saveSpeechSettings();
  });

  $('#speech-test').addEventListener('click', () => {
    previewSpeech();
  });

  $('#tts-save').addEventListener('click', () => {
    saveTtsSettingsFromForm();
  });

  $('#tts-test').addEventListener('click', (e) => {
    if (saveTtsSettingsFromForm()) previewHighQualitySpeech(e.currentTarget);
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
    const word = e.target.closest('.speakable-word');
    if (word) {
      e.preventDefault();
      e.stopPropagation();
      word.classList.add('speaking');
      setTimeout(() => word.classList.remove('speaking'), 450);
      playEnglish(word.dataset.speakWord, { rate: 1 });
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-speak-rate]')) {
      e.stopPropagation();
      const card = state.cards.find((c) => c.id === state.session.currentId);
      if (card) playEnglish(card.front, { rate: Number(b.dataset.speakRate), button: b });
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

  $('#word-library').addEventListener('input', (e) => {
    if (e.target.id !== 'word-search') return;
    state.wordLibrary.query = e.target.value;
    if (e.isComposing) return;
    renderWordLibrary();
    const search = $('#word-search');
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  });

  $('#word-library').addEventListener('compositionend', (e) => {
    if (e.target.id !== 'word-search') return;
    state.wordLibrary.query = e.target.value;
    renderWordLibrary();
  });

  $('#word-library').addEventListener('click', handleWordLibraryClick);

  $('#browse-table').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const card = state.cards.find((c) => c.id === edit.dataset.edit);
      if (!card) return;
      openEditDialog(card);
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
      if (form.dataset.returnView === 'words') renderWordLibrary();
      else renderBrowse();
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
  initSpeechSettings();
  renderTtsSettings();
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

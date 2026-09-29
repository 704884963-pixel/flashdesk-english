// FlashDesk client — state, review session machine, add/browse views, stats copy.

const $ = (sel) => document.querySelector(sel);

const state = {
  cards: [],
  history: [],
  meta: {},
  deckFilter: 'All',
  view: 'review',
  session: null,
  quiz: null,
  wordLibrary: {
    query: '',
    filter: 'all',
    selectedId: null,
  },
  addMode: 'single',
  batchPreview: null,
  articles: [],
  article: {
    mode: 'list', current: null, parsed: null, error: '',
    cache: new Map(), observer: null, saveTimer: null, pendingProgress: null,
    returnToId: null, unknownWords: new Set(),
    revealedParagraphs: new Set(),
    narrationId: 0, narrationRate: null, narrationParagraphIndex: null,
  },
  ai: {
    mode: 'home', loading: false, error: '', preview: null, targets: [], candidateCount: 0,
    lastSecondary: '', lastSecondaryCombo: '',
    revealed: new Set(), revealedParagraphs: new Set(), service: null, topic: 'auto', difficulty: 'medium',
    lookupCache: new Map(), requestTiming: null,
    narrationId: 0, narrationRate: null, narrationSpeed: 1,
    narrationMode: null, narrationParagraphIndex: null, narrationSentenceIndex: null,
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
    easy: 0,
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

function newCardFields({ deck, front, back, memoryReading = '', chineseReading = '', formsText = '' }) {
  const fields = {
    deck: String(deck || '').trim(),
    front: String(front || '').trim(),
    back: String(back || '').trim(),
  };
  if (!fields.deck || !fields.front || !fields.back) throw new Error('英文和中文内容不能为空');
  if (fields.deck === 'Words') {
    fields.memoryReading = String(memoryReading || '').trim();
    fields.chineseReading = String(chineseReading || '').trim();
    fields.forms = parseForms(String(formsText || ''));
  }
  return fields;
}

async function saveNewCard(fields) {
  const { card } = await FlashStore.addCard(fields);
  state.cards.push(card);
  if (card.deck === 'Words' && Number.isSafeInteger(card.wordNumber)) {
    state.meta = { ...state.meta, nextWordNumber: Math.max(
      Number.isSafeInteger(state.meta?.nextWordNumber) ? state.meta.nextWordNumber : 1,
      card.wordNumber + 1,
    ) };
  }
  state.article.cache.clear();
  renderDeckControls();
  return card;
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
    if (typeof options.onEnd === 'function') utterance.onend = options.onEnd;
    if (typeof options.onError === 'function') utterance.onerror = options.onError;
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
const audioCacheApi = typeof window !== 'undefined' && window.FlashAudioCache
  ? window.FlashAudioCache
  : {
    normalizeText: (value) => String(value || '').trim().replace(/\s+/g, ' '),
    cacheKey: (endpoint, text) => JSON.stringify(['audio-v1', String(endpoint || '').trim(), String(text || '').trim().replace(/\s+/g, ' ')]),
    async get() { return null; },
    async put(record) { return record; },
    async getAll() { return []; },
    async clear() {},
  };
const ttsAudioCache = new Map();
const ttsPendingAudio = new Map();
const loadingSpeechButtons = new Set();
let currentEnglishAudio = null;
let currentEnglishObjectUrl = '';
let currentEnglishWaitResolve = null;
let englishPlaybackRequest = 0;
let audioCacheDownloading = false;

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
  refreshAudioCacheStats();
}

function saveTtsSettingsFromForm() {
  const endpointInput = $('#tts-endpoint').value.trim();
  const token = $('#tts-token').value.trim();
  if (!endpointInput && !token) {
    ttsSettings.endpoint = '';
    ttsSettings.token = '';
    saveTtsSettings();
    setTtsStatus('已清除高质量发音设置，将使用系统发音。');
    refreshAudioCacheStats();
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
  refreshAudioCacheStats();
  return true;
}

function normalizedTtsText(text) {
  return audioCacheApi.normalizeText(text);
}

function ttsCacheKey(text, endpoint = ttsSettings.endpoint) {
  return audioCacheApi.cacheKey(endpoint, normalizedTtsText(text));
}

function ttsRequestUrl() {
  return `${ttsSettings.endpoint}/tts`;
}

function validAudioBlob(blob) {
  return Boolean(blob && Number(blob.size) > 0 && String(blob.type || '').startsWith('audio/'));
}

function ttsRequestError(status) {
  const error = new Error(`TTS request failed (${status})`);
  error.status = status;
  return error;
}

async function fetchTtsAudio(text, options = {}) {
  const value = normalizedTtsText(text);
  const endpoint = ttsSettings.endpoint;
  const key = ttsCacheKey(value, endpoint);
  if (!value || !endpoint) return null;
  if (ttsAudioCache.has(key)) return { key, blob: ttsAudioCache.get(key), source: 'memory' };
  if (ttsPendingAudio.has(key)) return ttsPendingAudio.get(key);

  const pending = (async () => {
    try {
      const stored = await audioCacheApi.get(key);
      if (stored && validAudioBlob(stored.blob)) {
        ttsAudioCache.set(key, stored.blob);
        return { key, blob: stored.blob, source: 'indexeddb' };
      }
    } catch { /* IndexedDB may be unavailable; network/system fallback still works. */ }

    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (options.allowNetwork === false || !online || !ttsConfigured()) return null;
    const response = await fetch(ttsRequestUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ttsSettings.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: value }),
    });
    if (!response.ok) throw ttsRequestError(response.status);
    const blob = await response.blob();
    if (!validAudioBlob(blob)) throw new Error('TTS response is not audio');
    ttsAudioCache.set(key, blob);
    let persisted = false;
    try {
      await audioCacheApi.put({
        key,
        text: value,
        blob,
        mimeType: blob.type || 'audio/mpeg',
        endpoint,
        createdAt: Date.now(),
        size: blob.size,
      });
      persisted = true;
    } catch { /* Playback can continue even when storage is unavailable. */ }
    return { key, blob, source: 'network', persisted };
  })();

  ttsPendingAudio.set(key, pending);
  try {
    return await pending;
  } finally {
    ttsPendingAudio.delete(key);
  }
}

function releaseCurrentObjectUrl() {
  if (!currentEnglishObjectUrl) return;
  try {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(currentEnglishObjectUrl);
  } catch { /* URL already released */ }
  currentEnglishObjectUrl = '';
}

async function playAudioBlob(blob, rate, callbacks = {}) {
  const objectUrl = URL.createObjectURL(blob);
  currentEnglishObjectUrl = objectUrl;
  const audio = new Audio(objectUrl);
  audio.playbackRate = rate;
  currentEnglishAudio = audio;
  const release = () => {
    if (currentEnglishAudio === audio) currentEnglishAudio = null;
    if (currentEnglishObjectUrl === objectUrl) releaseCurrentObjectUrl();
  };
  audio.onended = () => { release(); callbacks.onEnd?.(); };
  audio.onerror = () => { release(); callbacks.onError?.(); };
  await audio.play();
  return audio;
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
  if (currentEnglishWaitResolve) currentEnglishWaitResolve('cancelled');
  if (currentEnglishAudio) {
    try { currentEnglishAudio.pause(); currentEnglishAudio.currentTime = 0; } catch { /* already stopped */ }
    currentEnglishAudio = null;
  }
  releaseCurrentObjectUrl();
  if (speechSupported()) {
    try { window.speechSynthesis.cancel(); } catch { /* unavailable */ }
  }
  for (const button of [...loadingSpeechButtons]) setSpeechButtonLoading(button, false);
}

async function playEnglish(text, options = {}) {
  const value = normalizedTtsText(text);
  if (!value) return 'failed';
  const rate = Number(options.rate) === 0.75 ? 0.75 : 1;
  const button = options.button || null;
  stopEnglishPlayback();
  const requestId = englishPlaybackRequest;
  let completion = null;
  let finishPlayback = () => {};
  if (options.waitForEnd) {
    completion = new Promise((resolve) => {
      let settled = false;
      const resolver = (status) => {
        if (settled) return;
        settled = true;
        if (currentEnglishWaitResolve === resolver) currentEnglishWaitResolve = null;
        resolve(status);
      };
      currentEnglishWaitResolve = resolver;
      finishPlayback = resolver;
    });
  }

  if (ttsSettings.endpoint) {
    setSpeechButtonLoading(button, true);
    try {
      const cached = await fetchTtsAudio(value);
      if (requestId !== englishPlaybackRequest) return 'cancelled';
      if (cached) {
        await playAudioBlob(cached.blob, rate, { onEnd: () => finishPlayback('ended'), onError: () => finishPlayback('failed') });
        if (requestId !== englishPlaybackRequest) return 'cancelled';
        setTtsStatus(cached.source === 'network'
          ? '正在使用 ElevenLabs 高质量发音。'
          : '正在播放本机缓存的高质量发音。');
        if (cached.source === 'network') refreshAudioCacheStats();
        if (completion) {
          const status = await completion;
          if (status !== 'ended') return status;
        }
        return 'elevenlabs';
      }
    } catch {
      if (requestId !== englishPlaybackRequest) return 'cancelled';
      setTtsStatus('高质量发音暂时不可用，已切换到系统发音。', true);
    } finally {
      setSpeechButtonLoading(button, false);
    }
  }

  if (speakEnglish(value, { rate, onEnd: () => finishPlayback('ended'), onError: () => finishPlayback('failed') })) {
    if (completion) {
      const status = await completion;
      if (status !== 'ended') return status;
    }
    return 'system';
  }
  finishPlayback('failed');
  setTtsStatus('发音失败，请检查网络或语音设置。', true);
  toast('发音失败，请检查网络或语音设置。');
  return 'failed';
}

function previewHighQualitySpeech(button) {
  return playEnglish(TTS_SAMPLE, { rate: 1, button });
}

function formatAudioBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function currentWordPronunciations() {
  const unique = new Map();
  state.cards.filter((card) => card.deck === 'Words').forEach((card) => {
    const text = normalizedTtsText(card.front);
    if (text && !unique.has(text)) unique.set(text, text);
  });
  return [...unique.values()];
}

async function audioCacheRecords() {
  try { return (await audioCacheApi.getAll()).filter((record) => validAudioBlob(record.blob)); } catch { return []; }
}

async function refreshAudioCacheStats() {
  const wordCount = $('#audio-cache-word-count');
  const totalNode = $('#audio-cache-total');
  const sizeNode = $('#audio-cache-size');
  if (!wordCount || !totalNode || !sizeNode) return null;
  const records = await audioCacheRecords();
  const recordKeys = new Set(records.map((record) => record.key));
  const words = currentWordPronunciations();
  const cachedWords = ttsSettings.endpoint
    ? words.filter((text) => recordKeys.has(ttsCacheKey(text))).length : 0;
  const size = records.reduce((sum, record) => sum + (Number(record.blob?.size) || Number(record.size) || 0), 0);
  wordCount.textContent = `${cachedWords} / ${words.length}`;
  totalNode.textContent = `${records.length} 条`;
  sizeNode.textContent = formatAudioBytes(size);
  return { cachedWords, words: words.length, total: records.length, size };
}

function setAudioCacheStatus(message, isError = false) {
  const node = $('#audio-cache-status');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('warn', isError);
}

function renderAudioDownloadProgress(progress) {
  const wrap = $('#audio-cache-progress-wrap');
  const bar = $('#audio-cache-progress');
  const text = $('#audio-cache-progress-text');
  if (!wrap || !bar || !text) return;
  wrap.hidden = false;
  bar.max = Math.max(progress.total, 1);
  bar.value = progress.processed;
  text.textContent = `正在下载 ${progress.processed} / ${progress.total} · 成功 ${progress.success} · 跳过 ${progress.skipped} · 失败 ${progress.failed}`;
}

function waitForRetry(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureWordAudioCached(text) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await fetchTtsAudio(text, { allowNetwork: true });
      if (!result) throw new Error('Audio unavailable');
      if (result.source === 'indexeddb' || result.persisted) {
        return result.source === 'network' ? 'success' : 'skipped';
      }
      const existing = await audioCacheApi.get(result.key);
      if (existing && validAudioBlob(existing.blob)) return 'skipped';
      await audioCacheApi.put({
        key: result.key,
        text: normalizedTtsText(text),
        blob: result.blob,
        mimeType: result.blob.type || 'audio/mpeg',
        endpoint: ttsSettings.endpoint,
        createdAt: Date.now(),
        size: result.blob.size,
      });
      return 'success';
    } catch (error) {
      lastError = error;
      if (error.status === 401 || error.status === 403) throw error;
      const retryable = error.status === 429 || Number(error.status) >= 500;
      if (!retryable || attempt === 2) break;
      await waitForRetry(400 * (attempt + 1));
    }
  }
  throw lastError || new Error('Audio download failed');
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch { /* Browser-managed storage is still usable. */ }
  return false;
}

async function downloadMissingWordAudio() {
  if (audioCacheDownloading) return;
  const words = currentWordPronunciations();
  const records = await audioCacheRecords();
  const cachedKeys = new Set(records.map((record) => record.key));
  const missing = words.filter((text) => !cachedKeys.has(ttsCacheKey(text)));
  const progress = { total: words.length, processed: words.length - missing.length, success: 0, skipped: words.length - missing.length, failed: 0 };
  renderAudioDownloadProgress(progress);

  if (!missing.length) {
    setAudioCacheStatus('单词发音已全部保存到本机。');
    await refreshAudioCacheStats();
    return;
  }
  if (!ttsConfigured()) {
    setAudioCacheStatus('请先配置并保存 Worker 地址和访问 Token。', true);
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setAudioCacheStatus('当前离线；已缓存内容仍可播放，联网后可继续下载缺失发音。', true);
    return;
  }

  audioCacheDownloading = true;
  const downloadButton = $('#audio-cache-download');
  const clearButton = $('#audio-cache-clear');
  downloadButton.disabled = true;
  clearButton.disabled = true;
  const persistent = await requestPersistentStorage();
  setAudioCacheStatus(persistent ? '本机持久化存储已启用，正在下载…' : '正在下载；存储空间由浏览器管理。');
  let cursor = 0;
  let authError = null;

  async function worker() {
    while (!authError) {
      const index = cursor;
      cursor += 1;
      if (index >= missing.length) return;
      try {
        const outcome = await ensureWordAudioCached(missing[index]);
        if (outcome === 'success') progress.success += 1;
        else progress.skipped += 1;
      } catch (error) {
        progress.failed += 1;
        if (error.status === 401 || error.status === 403) authError = error;
      } finally {
        progress.processed += 1;
        renderAudioDownloadProgress(progress);
      }
    }
  }

  try {
    await Promise.all([worker(), worker()]);
    if (authError) {
      setAudioCacheStatus('下载已停止：访问 Token 或 Worker 配置可能有问题。', true);
    } else if (progress.processed === progress.total && progress.failed === 0) {
      setAudioCacheStatus('单词发音已全部保存到本机。');
    } else {
      setAudioCacheStatus('部分发音下载失败；已保存内容会保留，下次可继续补齐。', true);
    }
  } finally {
    audioCacheDownloading = false;
    downloadButton.disabled = false;
    clearButton.disabled = false;
    await refreshAudioCacheStats();
  }
}

async function clearAudioCache() {
  if (audioCacheDownloading) return;
  if (!confirm('确定删除本机所有高质量发音缓存吗？\n删除后需要重新联网下载。')) return;
  try {
    stopEnglishPlayback();
    ttsAudioCache.clear();
    await audioCacheApi.clear();
    $('#audio-cache-progress-wrap').hidden = true;
    setAudioCacheStatus('本机发音缓存已清除。');
    await refreshAudioCacheStats();
  } catch {
    setAudioCacheStatus('清除失败，请稍后重试。', true);
  }
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

const WORD_LIBRARY_FILTERS = ['all', 'due', 'new', 'lapsed', 'forgotten', 'mastered'];
const WORD_LIBRARY_LABELS = {
  all: '全部',
  due: '待复习',
  new: '新词',
  lapsed: '易错',
  forgotten: '曾经忘记',
  mastered: '已掌握',
};

function hasHistoricalLapse(card) {
  return Number(card?.lapses || 0) > 0;
}

function wordLibraryMatches(card, filter, now = Date.now()) {
  if (card.deck !== 'Words') return false;
  if (filter === 'due') return Number(card.due) <= now;
  if (filter === 'new') return Number(card.streak || 0) === 0 && Number(card.lapses || 0) === 0;
  if (filter === 'lapsed') return FlashLogic.isWeakCard(card);
  if (filter === 'forgotten') return hasHistoricalLapse(card);
  if (filter === 'mastered') return Number(card.streak || 0) >= 3;
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
  if (FlashLogic.isWeakCard(card)) return { key: 'lapsed', label: '易错' };
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
  const options = ['All', ...names]
    .map((n) => `<option value="${esc(n)}">${esc(n === 'All' ? '全部' : deckDisplayName(n))}</option>`)
    .join('');
  ['#deck-filter', '#browse-deck-filter'].forEach((selector) => {
    const sel = $(selector);
    if (!sel) return;
    sel.innerHTML = options;
    sel.value = state.deckFilter;
  });
}

/* ---------- review session ---------- */

function buildQueue() {
  const s = state.session;
  const pool = state.cards.filter(inFilter);
  s.queue = FlashLogic.reviewQueue(pool, Date.now());
  if (s.pos >= s.queue.length) s.pos = 0;
  $('#dir-switch').hidden = true;
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
        <p class="complete-stats">已复习 ${s.reviewed} 张卡片 · 记住了 ${s.correct - s.easy} 张 · 很熟 ${s.easy} 张 · 再来一次 ${s.again} 张 · 正确率 ${pct}%</p>
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
        <button class="btn-grade btn-easy" id="grade-easy" title="跳过前期密集复习（按键：3）">很熟</button>
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
  if (kind === 'again') s.again += 1;
  else {
    s.correct += 1;
    if (kind === 'easy') s.easy += 1;
  }
  s.gradedIds.add(id);
  const idx = state.cards.findIndex((c) => c.id === id);
  if (idx !== -1) state.cards[idx] = card;

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
      remember: s.correct - s.easy,
      easy: s.easy,
      hardest,
    });
    s.logged = res.logged;
    state.history.push({ date: localDate(), deck: state.deckFilter, reviewed: s.reviewed, correct: s.correct,
      remember: s.correct - s.easy, easy: s.easy, again: s.again });
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

const QUIZ_LENGTHS = [10, 20, 30];
const DEFAULT_QUIZ_SIZE = 20;
const QUIZ_TYPE_LABELS = { 'zh-en': '中文 → 英文', 'en-zh': '英文 → 中文', 'audio-en': '听音 → 英文' };
const QUIZ_SCOPE_LABELS = { smart: '智能混合', new: '新词优先', lapsed: '易错词优先', random: '全部随机' };

function freshQuiz() {
  return {
    phase: 'start', questions: [], idx: 0, correct: 0, wrong: 0,
    missedIds: [], retryScheduledIds: [], answered: null,
    size: DEFAULT_QUIZ_SIZE,
    types: { 'zh-en': true, 'en-zh': true, 'audio-en': true },
    scope: 'smart', baseSize: 0, mode: 'normal', settingsError: '',
  };
}

function quizPool() {
  return state.cards.filter((card) => card.deck === 'Words'
    && String(card.front || '').trim() && String(card.back || '').trim());
}

function enabledQuizTypes(q = state.quiz) {
  return FlashLogic.WORD_QUIZ_TYPES.filter((type) => q.types[type]);
}

function quizQuestionFor(card, type) {
  return FlashLogic.buildWordQuizQuestion(quizPool(), card, type, Math.random);
}

function beginQuizWithCards(cards, mode = 'normal') {
  const q = state.quiz;
  const enabled = enabledQuizTypes(q);
  if (!enabled.length) {
    q.settingsError = '请至少选择一种题型。';
    renderQuiz();
    return;
  }
  const types = FlashLogic.mixedWordQuizTypes(enabled, cards.length, Math.random);
  q.questions = cards.map((card, index) => quizQuestionFor(card, types[index]));
  q.phase = 'question';
  q.idx = 0;
  q.correct = 0;
  q.wrong = 0;
  q.missedIds = [];
  q.retryScheduledIds = [];
  q.answered = null;
  q.baseSize = cards.length;
  q.mode = mode;
  q.settingsError = '';
  renderQuiz();
}

function startQuiz() {
  const q = state.quiz;
  const pool = quizPool();
  if (pool.length < 4) return;
  const cards = FlashLogic.selectWordQuizCards(pool, q.size, q.scope, Date.now(), Math.random);
  beginQuizWithCards(cards);
}

function quizCard(id) {
  return state.cards.find((card) => card.id === id);
}

function quizChoiceCard(question, choice) {
  const key = String(choice).trim().toLowerCase();
  return quizPool().find((card) => {
    const text = question.type === 'en-zh' ? card.back : card.front;
    return String(text).trim().toLowerCase() === key;
  });
}

function answerQuiz(i) {
  const q = state.quiz;
  if (q.phase !== 'question' || q.answered !== null) return;
  const question = q.questions[q.idx];
  if (!question || i < 0 || i >= question.choices.length) return;
  const isCorrect = question.choices[i] === question.correct;
  q.answered = { index: i, correct: isCorrect };
  if (isCorrect) {
    q.correct += 1;
  } else {
    q.wrong += 1;
    if (!q.missedIds.includes(question.cardId)) q.missedIds.push(question.cardId);
    if (!question.retry && !q.retryScheduledIds.includes(question.cardId)) {
      const card = quizCard(question.cardId);
      if (card) {
        const type = FlashLogic.alternateWordQuizType(question.type, enabledQuizTypes(q), Math.random);
        const retry = quizQuestionFor(card, type);
        retry.retry = true;
        q.questions = FlashLogic.insertWordQuizRetry(q.questions, q.idx, retry, 4);
        q.retryScheduledIds.push(question.cardId);
      }
    }
  }
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

function finishQuiz() {
  const q = state.quiz;
  q.phase = 'done';
  renderQuiz();
}

function restartQuizSettings() {
  const previous = state.quiz;
  state.quiz = freshQuiz();
  state.quiz.size = previous.size;
  state.quiz.types = { ...previous.types };
  state.quiz.scope = previous.scope;
  renderQuiz();
}

function retestMissedQuiz() {
  const cards = state.quiz.missedIds.map(quizCard).filter(Boolean);
  if (!cards.length) return;
  beginQuizWithCards(cards, 'missed');
}

function quizSpeechButtons(card) {
  return `<div class="quiz-speech-actions">
    <button type="button" class="btn quiz-speech" data-quiz-speak="${esc(card.id)}" data-speak-rate="1">🔊 正常</button>
    <button type="button" class="btn quiz-speech" data-quiz-speak="${esc(card.id)}" data-speak-rate="0.75">🐢 慢速</button>
  </div>`;
}

function quizFeedbackHtml(question) {
  const q = state.quiz;
  if (!q.answered) return '';
  const card = quizCard(question.cardId);
  if (!card) return '';
  const selected = question.choices[q.answered.index];
  if (q.answered.correct) {
    return `<section class="panel quiz-feedback correct" aria-live="polite">
      <div class="quiz-feedback-title">✓ 正确</div>
      <div class="quiz-feedback-word">${esc(card.front)}</div>
      <div class="quiz-feedback-meaning">${esc(card.back)}</div>
      ${quizSpeechButtons(card)}
    </section>`;
  }
  const chosenCard = quizChoiceCard(question, selected);
  const details = wordDetails(card);
  return `<section class="panel quiz-feedback wrong" aria-live="polite">
    <div class="quiz-feedback-title">✕ 回答错误</div>
    <div class="quiz-answer-pair"><span>你选择</span><strong>${esc(chosenCard?.front || selected)}</strong><small>${esc(chosenCard?.back || '')}</small></div>
    <div class="quiz-answer-pair correct-answer"><span>正确答案</span><strong>${esc(card.front)}</strong><small>${esc(card.back)}</small></div>
    ${details.memoryReading ? `<div class="quiz-reading"><span>🧠 发音拆解</span>${esc(details.memoryReading)}</div>` : ''}
    ${details.chineseReading ? `<div class="quiz-reading"><span>🗣 中文近似</span>${esc(details.chineseReading)}</div>` : ''}
    ${quizSpeechButtons(card)}
  </section>`;
}

function renderQuiz() {
  const q = state.quiz;
  const area = $('#quiz-area');
  if (q.phase === 'start') {
    const pool = quizPool();
    if (pool.length < 4) {
      area.innerHTML = `
        <div class="panel quiz-start">
          <div class="micro-label">检测</div>
          <p>单词库至少需要 4 个不同单词才能开始检测。</p>
        </div>`;
      return;
    }
    area.innerHTML = `
      <div class="panel quiz-start">
        <div class="quiz-start-heading">
          <div class="micro-label">单词检测</div>
          <h2>检测</h2>
          <p>本次结果只用于检测，不改变复习进度。</p>
        </div>
        <fieldset class="quiz-setting-group">
          <legend>题量</legend>
          <div class="quiz-setting-options compact">
            ${QUIZ_LENGTHS.map((len) => `<button type="button" class="quiz-setting-btn${q.size === len ? ' active' : ''}" data-size="${len}" aria-pressed="${q.size === len}">${len}</button>`).join('')}
          </div>
        </fieldset>
        <fieldset class="quiz-setting-group">
          <legend>题型</legend>
          <div class="quiz-setting-options quiz-type-options">
            ${FlashLogic.WORD_QUIZ_TYPES.map((type) => `<button type="button" class="quiz-setting-btn quiz-check${q.types[type] ? ' active' : ''}" data-quiz-type="${type}" aria-pressed="${q.types[type]}">${q.types[type] ? '☑' : '☐'} ${QUIZ_TYPE_LABELS[type]}</button>`).join('')}
          </div>
        </fieldset>
        <fieldset class="quiz-setting-group">
          <legend>检测范围</legend>
          <div class="quiz-setting-options quiz-scope-options">
            ${Object.entries(QUIZ_SCOPE_LABELS).map(([scope, label]) => `<button type="button" class="quiz-setting-btn quiz-radio${q.scope === scope ? ' active' : ''}" data-quiz-scope="${scope}" aria-pressed="${q.scope === scope}">${q.scope === scope ? '●' : '○'} ${label}</button>`).join('')}
          </div>
        </fieldset>
        ${q.settingsError ? `<p class="quiz-settings-error" role="alert">${esc(q.settingsError)}</p>` : ''}
        <button class="btn btn-primary quiz-start-button" id="quiz-start-btn">开始检测</button>
      </div>`;
    return;
  }

  if (q.phase === 'question') {
    const question = q.questions[q.idx];
    const answered = q.answered !== null;
    const progress = Math.min(q.idx + (answered ? 1 : 0), q.questions.length);
    const typeLabel = QUIZ_TYPE_LABELS[question.type];
    area.innerHTML = `
      <div class="quiz-progress-head">
        <span><strong>${q.idx + 1} / ${q.questions.length}</strong>${q.questions.length > q.baseSize ? `<small>基础 ${q.baseSize}</small>` : ''}</span>
        <span>正确 ${q.correct} · 错误 ${q.wrong}</span>
      </div>
      <progress class="quiz-progress-bar" value="${progress}" max="${q.questions.length}"></progress>
      <div class="quiz-question">
        <div class="micro-label">${typeLabel}${question.retry ? ' · 错题再现' : ''}</div>
        ${question.type === 'audio-en'
          ? `<button type="button" class="btn btn-primary quiz-listen" data-quiz-listen="${esc(question.cardId)}">🔊 ${answered ? '再听一次' : '播放发音'}</button>`
          : `<div class="card-front">${esc(question.prompt)}</div>`}
      </div>
      <div class="quiz-choices">
        ${question.choices.map((choice, i) => {
          let cls = 'quiz-choice';
          let marker = String(i + 1);
          if (answered) {
            if (choice === question.correct) { cls += ' correct'; marker = '✓'; }
            else if (i === q.answered.index) { cls += ' wrong'; marker = '✕'; }
          }
          return `<button class="${cls}" data-choice="${i}" ${answered ? 'disabled' : ''}><span class="quiz-key">${marker}</span><span class="quiz-choice-text">${esc(choice)}</span></button>`;
        }).join('')}
      </div>
      ${quizFeedbackHtml(question)}
      ${answered
        ? `<div class="quiz-next-row"><button class="btn btn-primary" id="quiz-next">${q.idx + 1 < q.questions.length ? '下一题' : '查看结果'}</button></div>`
        : ''}`;
    return;
  }

  const result = FlashLogic.wordQuizResult(q.correct, q.correct + q.wrong);
  const missed = q.missedIds.map(quizCard).filter(Boolean);
  area.innerHTML = `
    <div class="panel quiz-done">
      <div class="micro-label">${q.mode === 'missed' ? '错题重测完成' : '本次检测'}</div>
      <div class="quiz-score">${result.correct} / ${result.total}</div>
      <div class="quiz-result-rate">正确率 ${result.percentage}%</div>
      <div class="quiz-result-counts"><span>答对：${result.correct}</span><span>答错：${result.wrong}</span></div>
      ${missed.length
        ? `<div class="quiz-missed">
            <div class="micro-label">错题</div>
            ${missed.map((card) => `
              <div class="quiz-missed-item">
                <div><strong>${esc(card.front)}</strong><div class="answer">${esc(card.back)}</div></div>
                <button type="button" class="btn quiz-missed-speak" data-quiz-speak="${esc(card.id)}" data-speak-rate="1" aria-label="朗读 ${esc(card.front)}">🔊</button>
              </div>`).join('')}
          </div>`
        : '<p class="muted">全部答对，继续保持！</p>'}
      <div class="quiz-result-actions">
        ${missed.length ? '<button class="btn btn-primary" id="quiz-retest">只重测错题</button>' : ''}
        <button class="btn" id="quiz-restart">再测一次</button>
        <button class="btn" id="quiz-to-review">返回复习</button>
      </div>
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
  const lapses = Number(card.lapses || 0);
  return `<article class="word-list-item" data-word-card="${esc(card.id)}">
    <button type="button" class="word-list-main" data-word-open="${esc(card.id)}">
      <span class="word-list-heading"><span class="word-number">${number}</span><strong>${esc(card.front)}</strong></span>
      <span class="word-list-meaning">${esc(card.back)}</span>
      <span class="word-list-meta">
        <span class="word-list-meta-main">${details.forms.length ? `<span class="word-list-forms">${esc(details.forms.join(' · '))}</span><span aria-hidden="true"> · </span>` : ''}<span class="word-status word-status-${status.key}">● ${status.label}</span></span>
        <span class="word-list-due">· ${formatWordDue(card.due, now)}</span>
        ${hasHistoricalLapse(card) ? `<span class="word-list-forgotten">· 曾忘 ${lapses} 次</span>` : ''}
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

function setAddMode(mode) {
  state.addMode = mode === 'batch' ? 'batch' : 'single';
  document.querySelectorAll('[data-add-mode]').forEach((button) => {
    const active = button.dataset.addMode === state.addMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#add-form').hidden = state.addMode !== 'single';
  $('#batch-import-panel').hidden = state.addMode !== 'batch';
  if (state.addMode === 'single') $('#add-front').focus();
  else $('#batch-import-text').focus();
}

function batchStatusInfo(item) {
  if (item.status === 'importable') return { label: '可导入', cls: 'ready' };
  if (item.status === 'existing') return { label: '已存在', cls: 'existing' };
  if (item.status === 'batch-duplicate') return { label: '批次内重复', cls: 'existing' };
  return { label: '错误', cls: 'error' };
}

function renderBatchPreview(preview) {
  const stats = preview.stats;
  $('#batch-preview-stats').innerHTML = `
    <span>可导入 <strong>${stats.importable}</strong></span>
    <span>已存在 <strong>${stats.existing}</strong></span>
    <span>批次重复 <strong>${stats.batchDuplicate}</strong></span>
    <span>错误 <strong>${stats.error}</strong></span>`;
  $('#batch-preview-list').innerHTML = preview.items.map((item) => {
    const status = batchStatusInfo(item);
    const type = item.rawType || '未知类型';
    const number = item.expectedWordNumber === null ? '' : ` #${item.expectedWordNumber}`;
    return `<article class="batch-preview-item ${status.cls}">
      <div class="batch-preview-top">
        <span class="batch-preview-type">${esc(type)}${number}</span>
        <span class="batch-status ${status.cls}">${status.label}</span>
      </div>
      ${item.front ? `<strong class="batch-preview-front">${esc(item.front)}</strong>` : ''}
      ${item.back ? `<div class="batch-preview-back">${esc(item.back)}</div>` : ''}
      ${item.reason ? `<div class="batch-preview-reason">原因：${esc(item.reason)}</div>` : ''}
    </article>`;
  }).join('');
  $('#batch-preview').hidden = false;
  $('#batch-confirm-btn').hidden = stats.importable === 0;
  $('#batch-confirm-btn').disabled = false;
}

function previewBatchImport() {
  const text = $('#batch-import-text').value;
  if (!text.trim()) {
    state.batchPreview = null;
    $('#batch-preview').hidden = true;
    $('#batch-confirm-btn').hidden = true;
    $('#batch-import-message').textContent = '请先粘贴要导入的文本。';
    return;
  }
  state.batchPreview = FlashBatchImport.previewBatchText(text, state.cards, state.meta);
  $('#batch-import-message').textContent = state.batchPreview.items.length
    ? '预览完成，尚未写入任何数据。'
    : '没有找到可解析的 block。';
  $('#batch-import-result').hidden = true;
  renderBatchPreview(state.batchPreview);
}

async function confirmBatchImport() {
  const preview = state.batchPreview;
  if (!preview || !preview.stats.importable) return;
  const button = $('#batch-confirm-btn');
  if (button.disabled) return;
  button.disabled = true;
  $('#batch-import-message').textContent = '正在保存…';
  try {
    const fields = FlashBatchImport.importableFields(preview);
    const result = await FlashStore.importBatch(fields);
    state.cards.push(...result.cards);
    if (result.meta) state.meta = result.meta;
    renderDeckControls();
    const skipped = preview.stats.existing + preview.stats.batchDuplicate + result.skipped;
    $('#batch-import-message').textContent = '';
    $('#batch-preview').hidden = true;
    button.hidden = true;
    $('#batch-import-result').hidden = false;
    $('#batch-import-result').innerHTML = `
      <h3>导入完成</h3>
      <div class="batch-result-grid">
        <span>新增单词 <strong>${result.addedWords}</strong></span>
        <span>新增长句 <strong>${result.addedSentences}</strong></span>
        <span>跳过重复 <strong>${skipped}</strong></span>
        <span>错误 <strong>${preview.stats.error}</strong></span>
      </div>
      <div class="form-actions batch-result-actions">
        <button type="button" class="btn btn-primary" id="batch-view-words">查看单词库</button>
        <button type="button" class="btn" id="batch-import-more">继续导入</button>
      </div>`;
    state.batchPreview = null;
  } catch (err) {
    button.disabled = false;
    $('#batch-import-message').textContent = `导入失败：${err.message}`;
  }
}

function resetBatchImport() {
  state.batchPreview = null;
  $('#batch-import-text').value = '';
  $('#batch-preview').hidden = true;
  $('#batch-import-result').hidden = true;
  $('#batch-confirm-btn').hidden = true;
  $('#batch-import-message').textContent = '';
  $('#batch-import-text').focus();
}

function updateAddForm() {
  const isSentence = $('#add-type').value === 'Sentences';
  $('#add-front-label').textContent = isSentence ? '英文长句' : '英文单词';
  $('#add-front').placeholder = isSentence ? '例如：Could you help me with this?' : '例如：apple';
  $('#add-back-label').textContent = isSentence ? '中文理解 / 学习备注' : '中文意思';
  $('#add-back').placeholder = isSentence ? '填写句子的中文理解或学习备注' : '例如：苹果；可填写用法备注';
  $('#add-submit').textContent = isSentence ? '添加长句' : '添加单词';
  document.querySelectorAll('[data-word-field]').forEach((field) => { field.hidden = isSentence; });
}

/* ---------- AI learning ---------- */

const AI_SETTINGS_KEY = 'flashdesk-ai-settings';
const AI_HISTORY_KEY = 'flashdesk-ai-history';

function loadAiSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}');
    return { endpoint: typeof value.endpoint === 'string' ? value.endpoint : '', token: typeof value.token === 'string' ? value.token : '' };
  } catch { return { endpoint: '', token: '' }; }
}

function loadAiHistory() {
  try { return FlashAiLearning.normalizeRecentGenerations(JSON.parse(localStorage.getItem(AI_HISTORY_KEY) || '{}')); }
  catch { return { generations: [] }; }
}

let aiSettings = loadAiSettings();
let aiHistory = loadAiHistory();

function saveAiSettings(endpoint, token) {
  aiSettings = { endpoint: String(endpoint || '').trim().replace(/\/+$/, ''), token: String(token || '').trim() };
  try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings)); } catch { /* private mode */ }
}

function rememberAiGeneration(type, targets, primary = '') {
  const targetWords = targets.map((item) => typeof item === 'string' ? item : item.front);
  const primaryWord = primary || (typeof targets[0] === 'string' ? targets[0] : targets[0]?.front) || '';
  aiHistory = FlashAiLearning.recordAiGeneration(aiHistory, { type, targetWords, primary: primaryWord });
  try { localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(aiHistory)); } catch { /* private mode */ }
}

function aiHeaders() {
  return { Authorization: `Bearer ${aiSettings.token}`, 'Content-Type': 'application/json' };
}

async function aiFetch(path, options = {}) {
  if (!aiSettings.endpoint || !aiSettings.token) throw Object.assign(new Error('请先配置 AI 服务。'), { code: 'NOT_CONFIGURED' });
  const response = await fetch(`${aiSettings.endpoint}${path}`, { ...options, headers: { ...aiHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const code = body?.error?.code || 'UPSTREAM_ERROR';
    const messages = { UNAUTHORIZED: '访问 Token 无效。', RATE_LIMITED: '请求过于频繁，请稍后再试。', INVALID_AI_OUTPUT: 'AI 输出格式错误，请重试。', TIMEOUT: 'AI 请求超时，请重试。', INVALID_REQUEST: 'AI 请求数据无效。' };
    throw Object.assign(new Error(messages[code] || 'AI 服务暂时不可用。'), { code });
  }
  return body;
}

let currentAiPronunciationAudio = null;
let currentAiPronunciationObjectUrl = '';

function releaseAiPronunciation() {
  if (currentAiPronunciationAudio) {
    try { currentAiPronunciationAudio.pause(); } catch { /* already stopped */ }
    currentAiPronunciationAudio = null;
  }
  if (currentAiPronunciationObjectUrl) {
    try { URL.revokeObjectURL(currentAiPronunciationObjectUrl); } catch { /* already released */ }
    currentAiPronunciationObjectUrl = '';
  }
}

async function playAiPronunciation(text, button) {
  const value = String(text || '').trim();
  if (!value || button?.disabled) return;
  const label = button?.dataset.aiPronunciationLabel || button?.textContent || 'AI发音';
  if (button) {
    button.dataset.aiPronunciationLabel = label;
    button.textContent = 'AI发音中…';
    button.disabled = true;
  }
  try {
    if (!aiSettings.endpoint || !aiSettings.token) throw new Error('AI pronunciation is not configured');
    releaseAiPronunciation();
    const response = await fetch(`${aiSettings.endpoint}/pronounce`, {
      method: 'POST',
      headers: aiHeaders(),
      body: JSON.stringify({ text: value, locale: 'en-US' }),
    });
    if (!response.ok) throw new Error(`AI pronunciation failed (${response.status})`);
    const blob = await response.blob();
    if (!validAudioBlob(blob)) throw new Error('AI pronunciation response is not audio');
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    currentAiPronunciationAudio = audio;
    currentAiPronunciationObjectUrl = objectUrl;
    const release = () => {
      if (currentAiPronunciationAudio === audio) currentAiPronunciationAudio = null;
      if (currentAiPronunciationObjectUrl === objectUrl) {
        URL.revokeObjectURL(objectUrl);
        currentAiPronunciationObjectUrl = '';
      }
    };
    audio.onended = release;
    audio.onerror = () => {
      release();
      if (button) { button.textContent = 'AI发音失败'; button.disabled = false; }
    };
    await audio.play();
    if (button) { button.textContent = label; button.disabled = false; }
  } catch {
    releaseAiPronunciation();
    if (button) { button.textContent = 'AI发音失败'; button.disabled = false; }
  }
}

function aiTargets(count, preferredWords = []) {
  return FlashAiLearning.selectAiTargetWords({ cards: state.cards, history: state.history, recentAiTargets: aiHistory.generations, preferredWords, count, now: Date.now() });
}

function aiContext(targets, extras = {}) {
  return FlashAiLearning.buildAiContext({ cards: state.cards, targetWords: targets, unknownWords: state.article.unknownWords, ...extras });
}

function aiUsageHtml(usage) {
  if (!usage || [usage.inputTokens, usage.outputTokens, usage.totalTokens].every((value) => value == null)) return '';
  const part = (label, value) => value == null ? '' : `<span>${label} ${Number(value).toLocaleString()} tokens</span>`;
  return `<div class="ai-usage">本次 AI 用量：${part('输入', usage.inputTokens)} ${part('输出', usage.outputTokens)} ${part('总计', usage.totalTokens)}</div>`;
}

function aiTargetHtml(targets, label) {
  return targets.length ? `<div class="ai-targets"><span class="micro-label">${label}</span><div>${targets.map((item) => `<span>${esc(item.front)}</span>`).join('')}</div></div>` : '';
}

function aiSentenceFocusHtml(targets, usedWords = []) {
  const practice = FlashAiLearning.sentencePracticeTargets(targets);
  const primary = practice[0];
  if (!primary) return '';
  const secondary = practice[1] || null;
  return `${aiTargetHtml([primary], '主目标词')}${secondary ? aiTargetHtml([secondary], '顺带复习') : ''}`;
}

function interactiveWordHtml(text, renderWord) {
  const value = String(text || '');
  const tokens = FlashArticleUtils.wordTokens(value);
  let html = ''; let position = 0;
  for (const token of tokens) {
    html += esc(value.slice(position, token.index));
    html += renderWord(token);
    position = token.index + token.text.length;
  }
  return html + esc(value.slice(position));
}

function aiSentenceTextHtml(sentence, index, lookup) {
  return interactiveWordHtml(sentence.english, (token) => {
    const learned = lookup.has(FlashArticleUtils.wordKey(token.text));
    return `<span class="article-word${learned ? ' learned' : ''}" data-ai-sentence-word="${esc(token.text)}" data-ai-sentence-index="${index}">${esc(token.text)}</span>`;
  });
}

// Paragraph translations travel with the generated Article, so the learner can
// reveal one paragraph at a time instead of the whole text. Each paragraph owns
// its own toggle: opening one never opens another, and translations start
// hidden so the English is read first.
function aiArticlePreviewContentHtml(content, lookup, translations = []) {
  const analysis = FlashArticleUtils.analyzeArticle(content);
  const aligned = FlashArticleUtils.normalizeParagraphTranslations(translations, analysis.paragraphs.length);
  return analysis.paragraphs.map((paragraph, paragraphIndex) => {
    const translationZh = aligned[paragraphIndex] || '';
    const expanded = Boolean(translationZh) && state.ai.revealedParagraphs.has(paragraphIndex);
    return `<section class="ai-translation-row">
    <div class="ai-article-paragraph${state.ai.narrationParagraphIndex === paragraphIndex ? ' is-narrating' : ''}" data-ai-article-paragraph="${paragraphIndex}">
      <div class="ai-paragraph-actions"><button class="btn ai-paragraph-narrate" type="button" data-ai-narrate-paragraph="${paragraphIndex}">${state.ai.narrationMode === 'paragraph' && state.ai.narrationParagraphIndex === paragraphIndex ? '■ 停止朗读' : '▶ 本段朗读'}</button>${translationZh ? `<button class="btn ai-paragraph-translate" type="button" data-ai-paragraph-translation="${paragraphIndex}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '收起本段翻译' : '查看本段翻译'}</button>` : ''}</div>
      <p>${paragraph.sentences.map((sentence) => interactiveWordHtml(sentence.text, (token) => {
    const learned = lookup.has(FlashArticleUtils.wordKey(token.text));
    return `<span class="article-word${learned ? ' learned' : ''}" data-ai-article-word="${esc(token.text)}" data-ai-article-sentence-index="${sentence.index}">${esc(token.text)}</span>`;
  })).join(' ')}</p>
    </div>
    ${expanded ? `<div class="ai-article-translation" lang="zh-CN" data-ai-paragraph-translation-body="${paragraphIndex}"><div class="micro-label">参考翻译 · 第 ${paragraphIndex + 1} 段</div><p>${esc(translationZh)}</p></div>` : ''}
  </section>`;
  }).join('');
}

function aiArticleSentenceAt(content, index) {
  return FlashArticleUtils.analyzeArticle(content).paragraphs
    .flatMap((paragraph) => paragraph.sentences)
    .find((sentence) => sentence.index === Number(index))?.text || '';
}

const AI_SENTENCE_PAUSE_MS = 350;
const AI_PARAGRAPH_PAUSE_MS = 800;
let cancelAiNarrationPause = null;

function refreshAiArticleNarrationUi() {
  if (state.view !== 'ai' || state.ai.mode !== 'article') return;
  document.querySelectorAll('[data-ai-article-paragraph]').forEach((element) => {
    element.classList.toggle('is-narrating', Number(element.dataset.aiArticleParagraph) === state.ai.narrationParagraphIndex);
  });
  document.querySelectorAll('[data-ai-narrate-paragraph]').forEach((button) => {
    const active = state.ai.narrationMode === 'paragraph'
      && Number(button.dataset.aiNarrateParagraph) === state.ai.narrationParagraphIndex;
    button.textContent = active ? '■ 停止朗读' : '▶ 本段朗读';
  });
  document.querySelectorAll('[data-ai-narrate-article]').forEach((button) => {
    const rate = Number(button.dataset.rate) === 0.75 ? 0.75 : 1;
    button.textContent = state.ai.narrationMode === 'article' && state.ai.narrationRate === rate
      ? '■ 停止朗读'
      : rate === 0.75 ? '🐢 慢速朗读' : '▶ 整篇朗读';
  });
}

function aiNarrationPause(ms, narrationId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelAiNarrationPause === cancel) cancelAiNarrationPause = null;
      resolve(completed && narrationId === state.ai.narrationId);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    cancelAiNarrationPause = cancel;
  });
}

function stopAiArticleNarration(rerender = false) {
  state.ai.narrationId += 1;
  state.ai.narrationRate = null;
  state.ai.narrationMode = null;
  state.ai.narrationParagraphIndex = null;
  state.ai.narrationSentenceIndex = null;
  cancelAiNarrationPause?.();
  cancelAiNarrationPause = null;
  stopEnglishPlayback();
  if (rerender) refreshAiArticleNarrationUi();
}

async function startAiArticleNarration(rate, paragraphIndex = null) {
  const preview = state.ai.preview;
  if (!preview || preview.type !== 'article') return;
  stopAiArticleNarration(false);
  const narrationId = state.ai.narrationId;
  state.ai.narrationRate = Number(rate) === 0.75 ? 0.75 : 1;
  state.ai.narrationSpeed = state.ai.narrationRate;
  state.ai.narrationMode = paragraphIndex === null ? 'article' : 'paragraph';
  const paragraphs = FlashArticleUtils.articleSpeechParagraphs(preview.data.content);
  const selected = paragraphIndex === null
    ? paragraphs.map((sentences, index) => ({ index, sentences }))
    : paragraphs[paragraphIndex] ? [{ index: paragraphIndex, sentences: paragraphs[paragraphIndex] }] : [];
  refreshAiArticleNarrationUi();
  try {
    for (let paragraphPosition = 0; paragraphPosition < selected.length; paragraphPosition += 1) {
      const paragraph = selected[paragraphPosition];
      if (narrationId !== state.ai.narrationId) return;
      state.ai.narrationParagraphIndex = paragraph.index;
      refreshAiArticleNarrationUi();
      for (let sentenceIndex = 0; sentenceIndex < paragraph.sentences.length; sentenceIndex += 1) {
        state.ai.narrationSentenceIndex = sentenceIndex;
        const result = await playEnglish(paragraph.sentences[sentenceIndex], { rate: state.ai.narrationRate, waitForEnd: true });
        if (narrationId !== state.ai.narrationId || ['cancelled', 'failed'].includes(result)) return;
        if (sentenceIndex < paragraph.sentences.length - 1
            && !await aiNarrationPause(AI_SENTENCE_PAUSE_MS, narrationId)) return;
      }
      if (paragraphPosition < selected.length - 1
          && !await aiNarrationPause(AI_PARAGRAPH_PAUSE_MS, narrationId)) return;
    }
  } finally {
    if (narrationId === state.ai.narrationId) {
      state.ai.narrationRate = null;
      state.ai.narrationMode = null;
      state.ai.narrationParagraphIndex = null;
      state.ai.narrationSentenceIndex = null;
      refreshAiArticleNarrationUi();
    }
  }
}

function aiSettingsHtml() {
  const service = state.ai.service;
  return `<details class="panel ai-settings">
    <summary>AI 服务</summary>
    <div class="ai-settings-grid">
      <label class="field"><span class="micro-label">Worker 地址</span><input id="ai-endpoint" type="url" value="${esc(aiSettings.endpoint)}" placeholder="https://your-ai-worker.workers.dev"></label>
      <label class="field"><span class="micro-label">访问 Token</span><input id="ai-token" type="password" value="${esc(aiSettings.token)}" autocomplete="off"></label>
    </div>
    <div class="form-actions"><button type="button" class="btn" data-ai-save-settings>保存</button><button type="button" class="btn" data-ai-test>测试连接</button></div>
    <p class="ai-service-status" id="ai-service-status">${aiServiceStatusHtml(service)}</p>
  </details>`;
}

function aiServiceStatusHtml(service = state.ai.service) {
  const connection = service ? `Provider：${esc(service.provider)} · Model：${esc(service.model)} · 已连接` : '尚未测试连接';
  const timing = state.ai.requestTiming;
  if (!timing) return connection;
  const taskLabel = { generate_sentences: '今日长句', generate_article: '今日短文', translate_article: '短文翻译', lookup_word: '单词查询' }[timing.task] || timing.task;
  const wordCounts = timing.initialWordCount == null || timing.finalWordCount == null
    ? ''
    : `<br>首次词数：${timing.initialWordCount}<br>最终词数：${timing.finalWordCount}`;
  return `${connection}<br><span class="micro-label">最近请求：${esc(taskLabel)}<br>总耗时：${(timing.totalMs / 1000).toFixed(1)} 秒<br>Provider：${(timing.providerTotalMs / 1000).toFixed(1)} 秒<br>Provider 调用：${timing.providerCalls} 次<br>网络重试：${timing.networkRetries} 次<br>长度重写：${timing.lengthRewrite ? '是' : '否'}${wordCounts}</span>`;
}

function rememberAiTiming(task, response, started) {
  const ended = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  const timing = response.timing || {};
  state.ai.requestTiming = {
    task,
    totalMs: Math.max(0, ended - started),
    providerTotalMs: Math.max(0, Number(timing.providerTotalMs ?? timing.providerMs) || 0),
    providerCalls: Math.max(1, Number(timing.providerCalls ?? timing.attempts) || 1),
    networkRetries: Math.max(0, Number(timing.networkRetries) || 0),
    lengthRewrite: timing.lengthRewrite === true,
    initialWordCount: timing.initialWordCount == null ? null : Math.max(0, Number(timing.initialWordCount) || 0),
    finalWordCount: timing.finalWordCount == null ? null : Math.max(0, Number(timing.finalWordCount) || 0),
  };
}

function refreshAiServiceStatus() {
  const element = $('#ai-service-status');
  if (element) element.innerHTML = aiServiceStatusHtml();
}

function renderAiHome() {
  $('#ai-root').innerHTML = `<div class="ai-page">
    <header class="ai-head"><div><h2>AI 个性化学习</h2><p>AI 只生成候选内容，保存始终由你确认。</p></div></header>
    <div class="ai-home-actions">
      <button type="button" class="panel ai-entry" data-ai-mode="sentences"><strong>今日长句</strong><span>用新词、易错词和久未练习词生成自然长句</span></button>
      <button type="button" class="panel ai-entry" data-ai-mode="article"><strong>今日短文</strong><span>生成约 200～300 words 的个性化阅读材料</span></button>
    </div>${aiSettingsHtml()}</div>`;
}

function renderAiSentences() {
  const preview = state.ai.preview?.type === 'sentences' ? state.ai.preview : null;
  const lookup = FlashArticleUtils.buildWordLookup(state.cards);
  const sentence = preview?.data.sentences[0] || null;
  const card = sentence ? (() => {
    const index = 0;
    const exists = FlashArticleUtils.sentenceExists(state.cards, sentence.english);
    return `<article class="panel ai-sentence-card"><p>${aiSentenceTextHtml(sentence, index, lookup)}</p>
      ${aiSentenceFocusHtml(state.ai.targets, sentence.targetWordsUsed)}
      <div class="ai-card-actions"><button class="btn" type="button" data-ai-speak="${esc(sentence.english)}" data-rate="1">🔊 正常</button><button class="btn" type="button" data-ai-speak="${esc(sentence.english)}" data-rate="0.75">🐢 慢速</button><button class="btn" type="button" data-ai-pronounce="${esc(sentence.english)}">AI发音</button>
      <button class="btn" type="button" data-ai-reveal="${index}">${state.ai.revealed.has(index) ? '隐藏参考翻译' : '查看参考翻译'}</button>
      ${exists ? '<span class="ai-exists">已存在于长句库</span>' : `<button class="btn btn-primary" type="button" data-ai-add-sentence="${index}">加入长句库</button>`}</div>
      ${state.ai.revealed.has(index) ? `<p class="ai-translation">${esc(sentence.referenceChinese)}</p>` : ''}</article>`;
  })() : '';
  $('#ai-root').innerHTML = `<div class="ai-page"><button class="article-back" type="button" data-ai-home>← 返回</button><header class="ai-head"><h2>今日长句</h2><p>优先使用你的新词、易错词和久未练习词。</p></header>
    ${preview ? '' : aiSentenceFocusHtml(state.ai.targets)}
    ${preview ? '' : `<div class="form-actions"><button type="button" class="btn btn-primary" data-ai-generate-sentences ${state.ai.loading ? 'disabled' : ''}>${state.ai.loading ? '正在生成…' : '生成今日长句'}</button></div>`}
    ${state.ai.error ? `<p class="ai-error">${esc(state.ai.error)}</p>` : ''}<div class="ai-results">${card}</div>${preview ? `${aiUsageHtml(preview.usage)}<div class="form-actions"><button type="button" class="btn" data-ai-generate-sentences>换一句</button></div>` : ''}${aiSettingsHtml()}</div>`;
}

function renderAiArticle() {
  const preview = state.ai.preview?.type === 'article' ? state.ai.preview : null;
  const words = preview ? FlashArticleUtils.wordTokens(preview.data.content).length : 0;
  const lookup = FlashArticleUtils.buildWordLookup(state.cards);
  $('#ai-root').innerHTML = `<div class="ai-page"><button class="article-back" type="button" data-ai-home>← 返回</button><header class="ai-head"><h2>今日短文</h2><p>生成自然、完整的个性化英文阅读材料。</p></header>
    <div class="panel ai-options"><label class="field"><span class="micro-label">Topic</span><select id="ai-topic"><option value="auto">自动</option><option value="ai-tech">AI与科技</option><option value="work">工作</option><option value="travel">旅行</option><option value="daily">日常生活</option><option value="business">商业经济</option></select></label>
    <label class="field"><span class="micro-label">Difficulty</span><select id="ai-difficulty"><option value="easy">简单</option><option value="medium">适中</option></select></label></div>
    ${preview ? '' : aiTargetHtml(state.ai.targets, '本篇重点词')}
    <div class="form-actions"><button type="button" class="btn btn-primary" data-ai-generate-article ${state.ai.loading ? 'disabled' : ''}>${state.ai.loading ? '正在生成…' : preview ? '重新生成' : '生成短文'}</button></div>
    ${state.ai.error ? `<p class="ai-error">${esc(state.ai.error)}</p>` : ''}
    ${preview ? `<article class="panel ai-article-preview"><h3>${esc(preview.data.title)}</h3><div class="micro-label">约 ${words} words</div>${aiTargetHtml(preview.data.targetWordsUsed.map((front) => ({ front })), '本篇重点词')}<div class="ai-article-content">${aiArticlePreviewContentHtml(preview.data.content, lookup, preview.data.paragraphTranslations)}</div>

      <div class="form-actions"><button class="btn btn-primary" type="button" data-ai-narrate-article data-rate="1">${state.ai.narrationMode === 'article' && state.ai.narrationRate === 1 ? '■ 停止朗读' : '▶ 整篇朗读'}</button><button class="btn" type="button" data-ai-narrate-article data-rate="0.75">${state.ai.narrationMode === 'article' && state.ai.narrationRate === 0.75 ? '■ 停止朗读' : '🐢 慢速朗读'}</button><button class="btn" type="button" data-ai-save-article>保存到阅读库</button><button class="btn" type="button" data-ai-generate-article>重新生成</button></div>
      </article>${aiUsageHtml(preview.usage)}` : ''}${aiSettingsHtml()}</div>`;
  const topic = $('#ai-topic'); const difficulty = $('#ai-difficulty');
  if (topic) topic.value = state.ai.topic; if (difficulty) difficulty.value = state.ai.difficulty;
}

function renderAiView() {
  if (state.ai.mode === 'sentences') renderAiSentences();
  else if (state.ai.mode === 'article') renderAiArticle();
  else renderAiHome();
}

async function generateAi(type) {
  if (state.ai.loading) return;
  if (type === 'article') stopAiArticleNarration(false);
  state.ai.loading = true; state.ai.error = ''; state.ai.preview = null; state.ai.revealed = new Set();
  // A fresh Article starts with every paragraph translation collapsed.
  if (type === 'article') state.ai.revealedParagraphs = new Set();
  const article = type === 'article';
  // Today Sentence rotates its primary through the existing AI history; Today
  // Article picks up where the latest Sentence round left off so the learner
  // meets the same word again in reading.
  const recentPrimary = article ? FlashAiLearning.latestSentencePrimaryTarget(aiHistory) : '';
  if (article) {
    state.ai.targets = aiTargets(FlashAiLearning.articleTargetCount());
    state.ai.candidateCount = state.ai.targets.length;
  } else {
    const selection = FlashAiLearning.sentencePracticeSelection({
      cards: state.cards, history: state.history, recentAiTargets: aiHistory.generations,
      now: Date.now(), today: { lastSecondary: state.ai.lastSecondary, lastSecondaryCombo: state.ai.lastSecondaryCombo },
    });
    state.ai.targets = selection.practice;
    state.ai.candidateCount = selection.candidateCount;
  }
  const requestTargets = article
    ? FlashAiLearning.selectArticleFocusWords({ targets: state.ai.targets, recentAiTargets: aiHistory.generations, topic: state.ai.topic, articlePrimary: recentPrimary })
    : FlashAiLearning.sentencePracticeTargets(state.ai.targets);
  renderAiView();
  try {
    const task = article ? 'generate_article' : 'generate_sentences';
    const context = aiContext(requestTargets, article ? { topic: state.ai.topic, difficulty: state.ai.difficulty } : {});
    const request = FlashAiLearning.buildAiRequest(task, context, article ? { wordRange: [200, 300] } : { count: 1 });
    const started = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    const result = await aiFetch('/ai', { method: 'POST', body: JSON.stringify(request) });
    rememberAiTiming(task, result, started);
    state.ai.preview = { type, data: result.data, usage: result.usage };
    state.ai.service = { provider: result.provider, model: result.model };
    const usedTargets = article ? result.data.targetWordsUsed : result.data.sentences[0]?.targetWordsUsed;
    const historyTargets = article
      ? (usedTargets?.length ? usedTargets : requestTargets)
      : FlashAiLearning.sentenceHistoryTargets(usedTargets, requestTargets);
    rememberAiGeneration(type, historyTargets, article ? '' : requestTargets[0]?.front);
    if (!article && requestTargets[0]) {
      state.ai.lastSecondary = requestTargets[1]?.front || '';
      state.ai.lastSecondaryCombo = requestTargets[1] ? `${requestTargets[0].front}+${requestTargets[1].front}` : '';
    }
  } catch (err) { state.ai.error = err.message; }
  finally { state.ai.loading = false; renderAiView(); }
}

/* ---------- articles ---------- */

function articleWordVersion() {
  return state.cards.filter((card) => card.deck === 'Words')
    .map((card) => `${card.id}:${card.front}:${(card.forms || []).join(',')}`).join('|');
}

function articleMetrics(article) {
  const unknownVersion = [...state.article.unknownWords].sort().join('|');
  const cacheKey = `${article.updatedAt}:${article.content}:${articleWordVersion()}:${unknownVersion}`;
  const cached = state.article.cache.get(article.id);
  if (cached?.key === cacheKey) return cached.value;
  const analysis = FlashArticleUtils.analyzeArticle(article.content);
  const lookup = FlashArticleUtils.buildWordLookup(state.cards);
  const coverage = FlashArticleUtils.articleCoverage(article.content, lookup);
  const recognition = FlashArticleUtils.recognitionRate(article.content, state.article.unknownWords);
  const value = { analysis, lookup, coverage, recognition };
  state.article.cache.set(article.id, { key: cacheKey, value });
  return value;
}

function articlePercent(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}

function articleIsMissing(error) {
  return /(?:article\s+)?not found|文章不存在|已删除/i.test(String(error?.message || error || ''));
}

function articleDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-CN');
}

function sortedArticles() {
  return [...state.articles].sort((a, b) => {
    const aRead = Number(a.lastReadAt) || 0;
    const bRead = Number(b.lastReadAt) || 0;
    if (aRead || bRead) return bRead - aRead || Number(b.createdAt) - Number(a.createdAt);
    return Number(b.createdAt) - Number(a.createdAt);
  });
}

function renderArticleHome() {
  const root = $('#article-root');
  if (state.article.error) {
    root.innerHTML = `<div class="article-page-head"><div><h2>阅读</h2></div></div>
      <div class="panel empty-panel"><p>无法加载文章：${esc(state.article.error)}</p></div>`;
    return;
  }
  const cards = sortedArticles().map((article) => {
    const { analysis, coverage, recognition } = articleMetrics(article);
    const sourceLine = [article.source, articleDate(article.publishedAt)].filter(Boolean).join(' · ');
    const progress = Math.min(100, Math.max(0, Number(article.progressPercent) || 0));
    return `<article class="article-list-card">
      <div class="article-card-main">
        <h3>${esc(article.title)}</h3>
        ${sourceLine ? `<div class="article-source">${esc(sourceLine)}</div>` : ''}
        <div class="article-card-stats">
          <span class="article-recognition-stat">当前认识率 ${articlePercent(recognition.percent)}%</span>
          <span>${analysis.wordCount.toLocaleString()} words</span>
          <span>FlashDesk 命中率 ${coverage.percent}%</span>
          <span>阅读进度 ${progress}%</span>
        </div>
        <div class="article-recognition-note">基于你标记的不认识词</div>
        <div class="article-progress"><span style="width:${progress}%"></span></div>
      </div>
      <div class="article-card-actions">
        <button type="button" class="btn btn-primary" data-article-open="${esc(article.id)}">${progress ? '继续阅读' : '开始阅读'}</button>
        <button type="button" class="btn btn-danger" data-article-delete="${esc(article.id)}">删除</button>
      </div>
    </article>`;
  }).join('');
  root.innerHTML = `<div class="article-page-head">
      <div><h2>阅读</h2><p>${state.articles.length} 篇文章</p></div>
      <button type="button" class="btn btn-primary" data-article-add>+ 添加文章</button>
    </div>
    <div class="article-list">${cards || '<div class="panel empty-panel"><p>还没有文章。可以粘贴一篇英文新闻或长文章开始阅读。</p></div>'}</div>`;
}

function renderArticleAdd() {
  $('#article-root').innerHTML = `<div class="article-page-head">
      <div><button type="button" class="article-back" data-article-list>← 返回</button><h2>添加文章</h2></div>
    </div>
    <form id="article-form" class="panel form-panel article-form">
      <label class="field"><span class="micro-label">标题 *</span><input id="article-title" required></label>
      <div class="article-form-grid">
        <label class="field"><span class="micro-label">来源</span><input id="article-source" placeholder="例如：Reuters"></label>
        <label class="field"><span class="micro-label">发布时间</span><input id="article-published" type="date"></label>
      </div>
      <label class="field"><span class="micro-label">原文链接</span><input id="article-source-url" type="url" inputmode="url" placeholder="https://..."></label>
      <label class="field"><span class="micro-label">正文 *</span><textarea id="article-content" rows="18" required placeholder="粘贴纯英文文章正文；空行会保留为段落边界"></textarea></label>
      <div id="article-form-stats" class="article-form-stats">0 words · 0 段</div>
      <p id="article-long-note" class="pronunciation-note" hidden>文章较长，阅读页面可能需要更多加载时间。</p>
      <div class="form-actions"><button type="submit" class="btn btn-primary" id="article-save">保存并阅读</button></div>
      <p id="article-form-message" class="batch-import-message" role="status"></p>
    </form>`;
}

function articleSentenceHtml(sentence, lookup) {
  const tokens = FlashArticleUtils.wordTokens(sentence.text);
  let html = '';
  let position = 0;
  for (const token of tokens) {
    html += esc(sentence.text.slice(position, token.index));
    const key = FlashArticleUtils.wordKey(token.text);
    const learned = lookup.has(key);
    const unknown = state.article.unknownWords.has(key);
    html += `<span class="article-word${learned ? ' learned' : ''}${unknown ? ' unknown' : ''}" data-article-word="${esc(token.text)}" data-word-key="${esc(key)}">${esc(token.text)}</span>`;
    position = token.index + token.text.length;
  }
  html += esc(sentence.text.slice(position));
  return `<span class="article-sentence" data-sentence-index="${sentence.index}" data-sentence-text="${esc(sentence.text)}">${html}</span>`;
}

// Reading paragraphs share the exact same splitter as the AI Today Article, so a
// four-paragraph article stays four paragraphs after it is saved to the library.
// Each paragraph carries its own lightweight toolbar; the Chinese help is only
// offered when the Article actually stored an aligned translation for it.
function articleParagraphToolbarHtml(paragraphIndex, hasTranslation) {
  const narrating = state.article.narrationParagraphIndex === paragraphIndex;
  return `<div class="article-paragraph-actions">
      <button type="button" class="btn article-paragraph-narrate" data-article-narrate-paragraph="${paragraphIndex}" data-rate="1">${narrating && state.article.narrationRate === 1 ? '■ 停止' : '▶ 本段朗读'}</button>
      <button type="button" class="btn article-paragraph-narrate" data-article-narrate-paragraph="${paragraphIndex}" data-rate="0.75">🐢 慢速</button>
      ${hasTranslation ? `<button type="button" class="btn article-paragraph-translate" data-article-paragraph-translation="${paragraphIndex}" aria-expanded="${state.article.revealedParagraphs.has(paragraphIndex) ? 'true' : 'false'}">${state.article.revealedParagraphs.has(paragraphIndex) ? '收起本段翻译' : '查看本段翻译'}</button>` : ''}
    </div>`;
}

function articleParagraphRowHtml(paragraph, paragraphIndex, lookup, translations) {
  const translationZh = translations[paragraphIndex] || '';
  const expanded = Boolean(translationZh) && state.article.revealedParagraphs.has(paragraphIndex);
  const english = paragraph.sentences
    .map((sentence) => articleSentenceHtml(sentence, lookup)).join(' ');
  return `<section class="article-paragraph-row">
    <div class="article-paragraph${state.article.narrationParagraphIndex === paragraphIndex ? ' is-narrating' : ''}" data-article-paragraph="${paragraphIndex}">
      <p class="article-paragraph-text">${english}</p>
      ${articleParagraphToolbarHtml(paragraphIndex, Boolean(translationZh))}
    </div>
    ${expanded ? `<div class="article-paragraph-translation" lang="zh-CN" data-article-paragraph-translation-body="${paragraphIndex}"><div class="micro-label">参考翻译 · 第 ${paragraphIndex + 1} 段</div><p>${esc(translationZh)}</p></div>` : ''}
  </section>`;
}

function renderArticleReader() {
  const article = state.article.current;
  if (!article) return renderArticleHome();
  const metrics = articleMetrics(article);
  state.article.parsed = metrics.analysis;
  const sourceLine = [article.source, articleDate(article.publishedAt)].filter(Boolean).join(' · ');
  const progress = Math.min(100, Math.max(0, Number(article.progressPercent) || 0));
  const translations = FlashArticleUtils.normalizeParagraphTranslations(article.paragraphTranslations, metrics.analysis.paragraphs.length);
  const paragraphs = metrics.analysis.paragraphs
    .map((paragraph, index) => articleParagraphRowHtml(paragraph, index, metrics.lookup, translations)).join('');
  $('#article-root').innerHTML = `<article class="article-reader">
    <header class="article-reader-head">
      <button type="button" class="article-back" data-article-list>← 返回</button>
      <h2>${esc(article.title)}</h2>
      ${sourceLine ? `<div class="article-source">${esc(sourceLine)}</div>` : ''}
      <div class="article-reader-meta">
        <span class="article-recognition-stat">当前认识率 <strong id="article-recognition-rate">${articlePercent(metrics.recognition.percent)}%</strong></span>
        <span>${metrics.analysis.wordCount.toLocaleString()} words</span>
        <span>FlashDesk 命中率 <span id="article-hit-rate">${metrics.coverage.percent}%</span></span>
        ${article.sourceUrl ? `<a href="${esc(article.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : ''}
      </div>
      <div class="article-recognition-note">基于你标记的不认识词</div>
      <div class="article-reader-progress"><span>阅读进度 <strong id="article-progress-label">${progress}%</strong></span>
        <div class="article-progress"><span id="article-progress-bar" style="width:${progress}%"></span></div></div>
    </header>
    <div class="article-body">${paragraphs}</div>
  </article>`;
  startArticleProgressTracking();
  const resume = Math.max(0, Number(article.progressSentenceIndex) || 0);
  requestAnimationFrame(() => document.querySelector(`[data-sentence-index="${resume}"]`)?.scrollIntoView({ block: 'center' }));
}

function renderArticleView() {
  if (state.article.mode === 'add') renderArticleAdd();
  else if (state.article.mode === 'reader') renderArticleReader();
  else renderArticleHome();
}

async function openArticle(id) {
  try {
    const article = await ArticleStore.get(id);
    const index = state.articles.findIndex((item) => item.id === article.id);
    if (index === -1) state.articles.push(article); else state.articles[index] = article;
    // A different Article always starts fully collapsed; expansion is pure UI
    // state and is never persisted with the Article.
    if (state.article.current?.id !== article.id) state.article.revealedParagraphs = new Set();
    stopArticleParagraphNarration(false);
    state.article.current = article;
    state.article.mode = 'reader';
    if (state.view !== 'reading') switchView('reading'); else renderArticleReader();
  } catch (err) {
    if (articleIsMissing(err)) {
      state.articles = state.articles.filter((item) => item.id !== id);
      state.article.cache.delete(id);
      state.article.current = null;
      state.article.mode = 'list';
      state.article.error = '';
      if (state.article.returnToId === id) state.article.returnToId = null;
      if (state.view !== 'reading') switchView('reading'); else renderArticleHome();
      toast('文章不存在或已删除');
      return;
    }
    toast(`无法打开文章：${err.message}`);
  }
}

function stopArticleProgressTracking() {
  state.article.observer?.disconnect();
  state.article.observer = null;
}

async function saveArticleProgress(progress) {
  const article = state.article.current;
  if (!article || !progress) return;
  try {
    const updated = await ArticleStore.updateProgress(article.id, progress);
    state.article.current = updated;
    const index = state.articles.findIndex((item) => item.id === updated.id);
    if (index !== -1) state.articles[index] = updated;
  } catch (err) {
    toast(`阅读进度保存失败：${err.message}`);
  }
}

function flushArticleProgress() {
  if (state.article.saveTimer) clearTimeout(state.article.saveTimer);
  state.article.saveTimer = null;
  const progress = state.article.pendingProgress;
  state.article.pendingProgress = null;
  if (progress) saveArticleProgress(progress);
}

function queueArticleProgress(sentenceIndex, sentenceCount) {
  const percent = sentenceCount ? Math.min(100, Math.round(((sentenceIndex + 1) / sentenceCount) * 100)) : 0;
  state.article.pendingProgress = { progressSentenceIndex: sentenceIndex, progressPercent: percent };
  const label = $('#article-progress-label');
  const bar = $('#article-progress-bar');
  if (label) label.textContent = `${percent}%`;
  if (bar) bar.style.width = `${percent}%`;
  if (!state.article.saveTimer) state.article.saveTimer = setTimeout(flushArticleProgress, 1500);
}

function startArticleProgressTracking() {
  stopArticleProgressTracking();
  const sentenceCount = state.article.parsed?.sentenceCount || 0;
  if (!sentenceCount || typeof IntersectionObserver === 'undefined') return;
  state.article.observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting)
      .map((entry) => Number(entry.target.dataset.sentenceIndex)).filter(Number.isFinite);
    if (visible.length) queueArticleProgress(Math.max(...visible), sentenceCount);
  }, { rootMargin: '-15% 0px -45% 0px', threshold: 0.25 });
  document.querySelectorAll('.article-sentence').forEach((sentence) => state.article.observer.observe(sentence));
}

// Reading per-paragraph narration reuses the shared playEnglish pipeline
// (ElevenLabs worker + cache, with the project's existing system-speech
// fallback). Rate 1 is the normal read; 0.75 is the slow read — the same two
// rates the rest of the app already offers, so no second audio system exists.
function refreshArticleParagraphNarrationUi() {
  if (state.view !== 'reading' || state.article.mode !== 'reader') return;
  document.querySelectorAll('[data-article-paragraph]').forEach((element) => {
    element.classList.toggle('is-narrating', Number(element.dataset.articleParagraph) === state.article.narrationParagraphIndex);
  });
  document.querySelectorAll('[data-article-narrate-paragraph][data-rate="1"]').forEach((button) => {
    const active = state.article.narrationRate === 1
      && Number(button.dataset.articleNarrateParagraph) === state.article.narrationParagraphIndex;
    button.textContent = active ? '■ 停止' : '▶ 本段朗读';
  });
}

function stopArticleParagraphNarration(rerender = false) {
  state.article.narrationId += 1;
  state.article.narrationRate = null;
  state.article.narrationParagraphIndex = null;
  stopEnglishPlayback();
  if (rerender) refreshArticleParagraphNarrationUi();
}

async function startArticleParagraphNarration(rate, paragraphIndex) {
  const article = state.article.current;
  if (!article) return;
  const index = Number(paragraphIndex);
  if (state.article.narrationParagraphIndex === index && state.article.narrationRate === rate) {
    stopArticleParagraphNarration(true);
    return;
  }
  stopArticleParagraphNarration(false);
  const narrationId = state.article.narrationId;
  state.article.narrationRate = Number(rate) === 0.75 ? 0.75 : 1;
  state.article.narrationParagraphIndex = index;
  const paragraphs = FlashArticleUtils.articleSpeechParagraphs(article.content);
  const sentences = paragraphs[index] || [];
  refreshArticleParagraphNarrationUi();
  try {
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      if (narrationId !== state.article.narrationId) return;
      const result = await playEnglish(sentences[sentenceIndex], { rate: state.article.narrationRate, waitForEnd: true });
      if (narrationId !== state.article.narrationId || ['cancelled', 'failed'].includes(result)) return;
      if (sentenceIndex < sentences.length - 1 && !await aiNarrationPause(350, narrationId)) return;
    }
  } finally {
    if (narrationId === state.article.narrationId) {
      state.article.narrationRate = null;
      state.article.narrationParagraphIndex = null;
      refreshArticleParagraphNarrationUi();
    }
  }
}

function openArticleWord(word) {
  const key = FlashArticleUtils.wordKey(word);
  const lookup = FlashArticleUtils.buildWordLookup(state.cards);
  const card = lookup.get(key);
  const unknown = state.article.unknownWords.has(key);
  const details = card ? wordDetails(card) : null;
  $('#article-action-content').innerHTML = `<div class="article-sheet">
    <div class="micro-label">英文单词</div><h3>${esc(word)}</h3>
    ${card ? `<p class="article-learned-label">已学习：${details.wordNumber ? `#${details.wordNumber} ` : ''}${esc(card.front)}</p>
      <div class="word-detail-meaning">${esc(card.back)}</div>
      ${details.memoryReading ? `<div class="word-detail"><span class="micro-label">🧠 发音拆解</span><div>${esc(details.memoryReading)}</div></div>` : ''}
      ${details.chineseReading ? `<div class="word-detail"><span class="micro-label">🗣 中文近似</span><div>${esc(details.chineseReading)}</div></div>` : ''}`
      : '<p class="muted">未加入单词库</p>'}
    ${unknown ? '<p class="article-unknown-label">不认识</p>' : ''}
    <div class="article-sheet-actions">
      <button type="button" class="btn" data-article-speak="${esc(word)}" data-rate="1">🔊 正常发音</button>
      <button type="button" class="btn" data-article-speak="${esc(word)}" data-rate="0.75">🐢 慢速发音</button>
      ${unknown
        ? `<button type="button" class="btn" data-article-known="${esc(word)}">我现在认识了</button>`
        : `<button type="button" class="btn" data-article-unknown="${esc(word)}">标记不认识</button>`}
      ${card ? '' : `<button type="button" class="btn btn-primary" data-article-add-word="${esc(word)}">加入单词库</button>`}
    </div></div>`;
  const dialog = $('#article-action-dialog');
  if (!dialog.open) dialog.showModal();
}

function aiLookupExistingCard(word, result) {
  const lookup = FlashArticleUtils.buildWordLookup(state.cards);
  const baseForm = String(result?.baseForm || '').trim();
  return (baseForm && lookup.get(FlashArticleUtils.wordKey(baseForm)))
    || lookup.get(FlashArticleUtils.wordKey(word)) || null;
}

function openAiSentenceWord(word, sentence, { error = '', editing = false, loading = false } = {}) {
  const cacheKey = FlashAiLearning.lookupCacheKey(word, sentence);
  const result = state.ai.lookupCache.get(cacheKey) || null;
  const card = aiLookupExistingCard(word, result);
  const details = card ? wordDetails(card) : null;
  const draft = result && !card && editing ? FlashAiLearning.wordDraftFromLookup(word, result) : null;
  const detail = (label, value) => value
    ? `<div class="word-detail"><span class="micro-label">${label}</span><div>${esc(value)}</div></div>` : '';
  $('#article-action-content').innerHTML = `<div class="article-sheet">
    <div class="micro-label">当前单词</div><h3>${esc(word)}</h3>
    ${card ? `<p class="article-learned-label">已在单词库：${details.wordNumber ? `#${details.wordNumber} ` : ''}${esc(card.front)}</p>
      ${detail('中文意思', card.back)}
      ${detail('🧠 发音拆解', details.memoryReading)}
      ${detail('🗣 中文近似', details.chineseReading)}`
      : loading ? '<p class="muted ai-word-loading">正在查询…</p>'
      : error ? `<p class="ai-error">查询失败：${esc(error)}</p>`
      : result && editing ? `${detail('本句中', result.meaningInContextZh)}
        <form id="ai-word-inline-form" class="ai-word-inline-form" data-ai-word="${esc(word)}" data-ai-sentence="${esc(sentence)}">
          <label class="field"><span class="micro-label">英文单词</span><input id="ai-word-front" required value="${esc(draft.front)}"></label>
          <label class="field"><span class="micro-label">中文意思</span><textarea id="ai-word-back" rows="2" required>${esc(draft.back)}</textarea></label>
          <label class="field"><span class="micro-label">🧠 发音拆解</span><input id="ai-word-memory-reading" value="${esc(draft.memoryReading)}"></label>
          <label class="field"><span class="micro-label">🗣 中文近似</span><input id="ai-word-chinese-reading" value="${esc(draft.chineseReading)}"></label>
          <label class="field"><span class="micro-label">词形变化（逗号或换行分隔）</span><textarea id="ai-word-forms" rows="2">${esc(draft.forms.join(', '))}</textarea></label>
          <p class="pronunciation-note">发音提示是可编辑草稿，标准发音以音频为准。</p>
          <p class="ai-error" id="ai-word-inline-error" hidden></p>
          <button type="submit" class="btn btn-primary" id="ai-word-inline-save">保存到单词库</button>
        </form>`
      : result ? `${detail('中文意思', result.meaningZh)}${detail('本句中', result.meaningInContextZh)}
        ${detail('🧠 发音拆解', result.memoryReading)}${detail('🗣 中文近似', result.chineseReading)}`
      : ''}
    <div class="article-sheet-actions">
      <button type="button" class="btn" data-article-speak="${esc(word)}" data-rate="1">🔊 正常发音</button>
      <button type="button" class="btn" data-article-speak="${esc(word)}" data-rate="0.75">🐢 慢速发音</button>
      <button type="button" class="btn" data-ai-pronounce="${esc(word)}">AI发音</button>
      ${card || loading || editing ? ''
        : error ? `<button type="button" class="btn" data-ai-retry-word="${esc(word)}" data-ai-sentence="${esc(sentence)}">重试</button>`
        : result ? `<button type="button" class="btn btn-primary" data-ai-edit-word="${esc(word)}" data-ai-sentence="${esc(sentence)}">加入单词库</button>` : ''}
    </div></div>`;
  const dialog = $('#article-action-dialog');
  if (!dialog.open) dialog.showModal();
}

async function lookupAiSentenceWord(word, sentence) {
  const cacheKey = FlashAiLearning.lookupCacheKey(word, sentence);
  if (state.ai.lookupCache.has(cacheKey)) return openAiSentenceWord(word, sentence);
  openAiSentenceWord(word, sentence, { loading: true });
  const started = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  try {
    const request = FlashAiLearning.buildLookupWordRequest(word, sentence);
    const response = await aiFetch('/ai', { method: 'POST', body: JSON.stringify(request) });
    state.ai.lookupCache.set(cacheKey, response.data);
    state.ai.service = { provider: response.provider, model: response.model };
    rememberAiTiming('lookup_word', response, started);
    refreshAiServiceStatus();
    openAiSentenceWord(word, sentence);
  } catch (err) {
    openAiSentenceWord(word, sentence, { error: err.message });
  }
}

async function showAiSentenceWord(word, sentence) {
  if (aiLookupExistingCard(word, null)) return openAiSentenceWord(word, sentence);
  await lookupAiSentenceWord(word, sentence);
}

function refreshAiSentenceWordLookup() {
  const lookup = FlashArticleUtils.buildWordLookup(state.cards);
  document.querySelectorAll('[data-ai-sentence-word], [data-ai-article-word]').forEach((element) => {
    const word = element.dataset.aiSentenceWord || element.dataset.aiArticleWord;
    element.classList.toggle('learned', lookup.has(FlashArticleUtils.wordKey(word)));
  });
}

async function saveInlineAiWord(form) {
  const word = form.dataset.aiWord;
  const sentence = form.dataset.aiSentence;
  const submit = form.querySelector('#ai-word-inline-save');
  const error = form.querySelector('#ai-word-inline-error');
  if (submit.disabled) return;
  let fields;
  try {
    fields = newCardFields({
      deck: 'Words', front: form.querySelector('#ai-word-front').value,
      back: form.querySelector('#ai-word-back').value,
      memoryReading: form.querySelector('#ai-word-memory-reading').value,
      chineseReading: form.querySelector('#ai-word-chinese-reading').value,
      formsText: form.querySelector('#ai-word-forms').value,
    });
  } catch (err) {
    error.hidden = false; error.textContent = err.message; return;
  }
  submit.disabled = true; submit.textContent = '保存中…';
  try {
    const card = await saveNewCard(fields);
    const cacheKey = FlashAiLearning.lookupCacheKey(word, sentence);
    const result = state.ai.lookupCache.get(cacheKey);
    if (result) state.ai.lookupCache.set(cacheKey, { ...result, baseForm: card.front });
    refreshAiSentenceWordLookup();
    openAiSentenceWord(word, sentence);
    const label = $('#article-action-content .article-learned-label');
    if (label) label.textContent = `✓ 已加入 ${card.wordNumber ? `#${card.wordNumber} ` : ''}${card.front}`;
  } catch (err) {
    const existing = FlashArticleUtils.buildWordLookup(state.cards).get(FlashArticleUtils.wordKey(fields.front));
    if (existing) {
      const cacheKey = FlashAiLearning.lookupCacheKey(word, sentence);
      const result = state.ai.lookupCache.get(cacheKey);
      if (result) state.ai.lookupCache.set(cacheKey, { ...result, baseForm: existing.front });
      refreshAiSentenceWordLookup();
      openAiSentenceWord(word, sentence);
      return;
    }
    error.hidden = false; error.textContent = err.message;
    submit.disabled = false; submit.textContent = '保存到单词库';
  }
}

async function setArticleUnknown(word, unknown) {
  try {
    const words = await ArticleStore.setUnknownWord(word, unknown);
    state.article.unknownWords = new Set(FlashArticleUtils.normalizeUnknownWords(words));
    state.article.cache.clear();
    const article = state.article.current;
    if (article) {
      const metrics = articleMetrics(article);
      const recognition = $('#article-recognition-rate');
      if (recognition) recognition.textContent = `${articlePercent(metrics.recognition.percent)}%`;
      document.querySelectorAll('.article-word[data-word-key]').forEach((element) => {
        element.classList.toggle('unknown', state.article.unknownWords.has(element.dataset.wordKey));
      });
    }
    openArticleWord(word);
  } catch (err) {
    toast(`阅读词汇状态保存失败：${err.message}`);
  }
}

function openArticleSentence(text) {
  const saved = FlashArticleUtils.sentenceExists(state.cards, text);
  $('#article-action-content').innerHTML = `<div class="article-sheet">
    <div class="micro-label">完整句子</div><p class="article-sheet-sentence">${esc(text)}</p>
    ${saved ? '<p class="article-learned-label">已保存到长句库</p>' : ''}
    <div class="article-sheet-actions">
      <button type="button" class="btn" data-article-speak="${esc(text)}" data-rate="1">🔊 正常发音</button>
      <button type="button" class="btn" data-article-speak="${esc(text)}" data-rate="0.75">🐢 慢速发音</button>
      ${saved ? '' : `<button type="button" class="btn btn-primary" data-article-add-sentence="${esc(text)}">保存为长句</button>`}
    </div></div>`;
  $('#article-action-dialog').showModal();
}

function prefillArticleCard(deck, front, back = '', wordDraft = {}) {
  $('#article-action-dialog').close();
  state.article.returnToId = state.article.current?.id || null;
  switchView('add');
  setAddMode('single');
  $('#add-type').value = deck;
  updateAddForm();
  $('#add-front').value = front;
  $('#add-back').value = back;
  $('#add-memory-reading').value = deck === 'Words' ? String(wordDraft.memoryReading || '') : '';
  $('#add-chinese-reading').value = deck === 'Words' ? String(wordDraft.chineseReading || '') : '';
  $('#add-forms').value = '';
  $('#add-back').focus();
}

/* ---------- views ---------- */

const MORE_VIEWS = new Set(['reading', 'add', 'quiz', 'browse']);

function setMoreMenuOpen(open) {
  const toggle = $('#nav-more-toggle');
  const menu = $('#nav-more-menu');
  if (!toggle || !menu) return;
  menu.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
}

function updateNavigationState(name) {
  document.querySelectorAll('.tab[data-view]').forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle('btn-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const more = $('#nav-more-toggle');
  if (more) more.classList.toggle('btn-active', MORE_VIEWS.has(name));
}

function switchView(name) {
  if (state.ai.narrationRate !== null && name !== 'ai') stopAiArticleNarration(false);
  if (state.article.narrationRate !== null && name !== 'reading') stopArticleParagraphNarration(false);
  stopEnglishPlayback();
  if (state.view === 'reading' && name !== 'reading') {
    stopArticleProgressTracking();
    flushArticleProgress();
  }
  state.view = name;
  setMoreMenuOpen(false);
  document.body.classList.toggle('reading-view', name === 'reading');
  updateNavigationState(name);
  for (const v of ['review', 'quiz', 'add', 'words', 'reading', 'ai', 'browse']) $(`#view-${v}`).hidden = v !== name;
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
  } else if (name === 'reading') {
    renderArticleView();
  } else if (name === 'ai') {
    renderAiView();
  } else if (name === 'add') {
    updateAddForm();
    setAddMode(state.addMode);
  }
}

/* ---------- events ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.view === 'words') state.wordLibrary.selectedId = null;
      if (b.dataset.view === 'reading') state.article.mode = 'list';
      if (b.dataset.view === 'ai') state.ai.mode = 'home';
      switchView(b.dataset.view);
    }));

  $('#nav-more-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    setMoreMenuOpen($('#nav-more-toggle').getAttribute('aria-expanded') !== 'true');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-more')) setMoreMenuOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    setMoreMenuOpen(false);
    $('#nav-more-toggle').focus();
  });

  ['#deck-filter', '#browse-deck-filter'].forEach((selector) => {
    $(selector).addEventListener('change', (e) => {
      state.deckFilter = e.target.value;
      renderDeckControls();
      switchView(state.view); // resets any in-progress session against the new filter
    });
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

  $('#audio-cache-download').addEventListener('click', () => {
    downloadMissingWordAudio();
  });

  $('#audio-cache-clear').addEventListener('click', () => {
    clearAudioCache();
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
    else if (b.id === 'grade-easy') grade('easy');
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
      else if (e.key === '3') grade('easy');
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
    if (b.dataset.quizType !== undefined) {
      const type = b.dataset.quizType;
      state.quiz.types[type] = !state.quiz.types[type];
      state.quiz.settingsError = enabledQuizTypes().length ? '' : '请至少选择一种题型。';
      renderQuiz();
    } else if (b.dataset.size !== undefined) {
      state.quiz.size = Number(b.dataset.size);
      renderQuiz();
    } else if (b.dataset.quizScope !== undefined) {
      state.quiz.scope = b.dataset.quizScope;
      renderQuiz();
    } else if (b.id === 'quiz-start-btn') startQuiz();
    else if (b.id === 'quiz-next') nextQuizQuestion();
    else if (b.id === 'quiz-restart') restartQuizSettings();
    else if (b.id === 'quiz-retest') retestMissedQuiz();
    else if (b.id === 'quiz-to-review') switchView('review');
    else if (b.dataset.quizListen !== undefined) {
      const card = quizCard(b.dataset.quizListen);
      if (card) playEnglish(card.front, { rate: 1, button: b });
    } else if (b.dataset.quizSpeak !== undefined) {
      const card = quizCard(b.dataset.quizSpeak);
      if (card) playEnglish(card.front, { rate: Number(b.dataset.speakRate) || 1, button: b });
    } else if (b.dataset.choice !== undefined) answerQuiz(Number(b.dataset.choice));
  });

  $('#add-type').addEventListener('change', updateAddForm);

  document.querySelectorAll('[data-add-mode]').forEach((button) => {
    button.addEventListener('click', () => setAddMode(button.dataset.addMode));
  });

  $('#batch-preview-btn').addEventListener('click', previewBatchImport);
  $('#batch-confirm-btn').addEventListener('click', confirmBatchImport);
  $('#batch-import-text').addEventListener('input', () => {
    if (!state.batchPreview) return;
    state.batchPreview = null;
    $('#batch-preview').hidden = true;
    $('#batch-confirm-btn').hidden = true;
    $('#batch-import-message').textContent = '内容已变化，请重新解析预览。';
  });
  $('#batch-import-result').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.id === 'batch-view-words') {
      state.wordLibrary.selectedId = null;
      switchView('words');
    } else if (button.id === 'batch-import-more') {
      resetBatchImport();
    }
  });

  $('#article-root').addEventListener('input', (e) => {
    if (e.target.id !== 'article-content') return;
    const analysis = FlashArticleUtils.analyzeArticle(e.target.value);
    $('#article-form-stats').textContent = `${analysis.wordCount.toLocaleString()} words · ${analysis.paragraphs.length} 段`;
    $('#article-long-note').hidden = analysis.wordCount <= 20000;
  });

  $('#article-root').addEventListener('submit', async (e) => {
    if (e.target.id !== 'article-form') return;
    e.preventDefault();
    const save = $('#article-save');
    if (save.disabled) return;
    save.disabled = true;
    $('#article-form-message').textContent = '正在保存…';
    try {
      const article = await ArticleStore.create({
        title: $('#article-title').value,
        source: $('#article-source').value,
        sourceUrl: $('#article-source-url').value,
        publishedAt: $('#article-published').value,
        content: $('#article-content').value,
      });
      state.articles.push(article);
      state.article.cache.delete(article.id);
      await openArticle(article.id);
    } catch (err) {
      $('#article-form-message').textContent = `保存失败：${err.message}`;
      save.disabled = false;
    }
  });

  $('#article-root').addEventListener('click', async (e) => {
    // Paragraph toolbar buttons are handled first so they can never fall through
    // to the word / sentence lookups behind them.
    const toolbar = e.target.closest('button[data-article-narrate-paragraph], button[data-article-paragraph-translation]');
    if (toolbar) {
      e.preventDefault();
      e.stopPropagation();
      if (toolbar.dataset.articleNarrateParagraph !== undefined) {
        await startArticleParagraphNarration(Number(toolbar.dataset.rate) === 0.75 ? 0.75 : 1, Number(toolbar.dataset.articleNarrateParagraph));
      } else {
        const index = Number(toolbar.dataset.articleParagraphTranslation);
        if (state.article.revealedParagraphs.has(index)) state.article.revealedParagraphs.delete(index);
        else state.article.revealedParagraphs.add(index);
        renderArticleReader();
      }
      return;
    }
    const word = e.target.closest('[data-article-word]');
    if (word) {
      e.preventDefault();
      e.stopPropagation();
      openArticleWord(word.dataset.articleWord);
      return;
    }
    const sentence = e.target.closest('[data-sentence-index]');
    if (sentence) {
      openArticleSentence(sentence.dataset.sentenceText);
      return;
    }
    const button = e.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-article-add')) {
      state.article.mode = 'add';
      renderArticleAdd();
    } else if (button.hasAttribute('data-article-list')) {
      stopArticleProgressTracking();
      stopArticleParagraphNarration(false);
      flushArticleProgress();
      state.article.revealedParagraphs = new Set();
      state.article.mode = 'list';
      state.article.current = null;
      renderArticleHome();
    } else if (button.dataset.articleOpen) {
      await openArticle(button.dataset.articleOpen);
    } else if (button.dataset.articleDelete) {
      const article = state.articles.find((item) => item.id === button.dataset.articleDelete);
      if (!article || !confirm('确定删除这篇文章？')) return;
      try {
        await ArticleStore.delete(article.id);
        state.articles = state.articles.filter((item) => item.id !== article.id);
        state.article.cache.delete(article.id);
        renderArticleHome();
      } catch (err) {
        toast(`删除失败：${err.message}`);
      }
    }
  });

  $('#article-action-close').addEventListener('click', () => $('#article-action-dialog').close());
  $('#article-action-content').addEventListener('click', async (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.aiPronounce !== undefined) {
      await playAiPronunciation(button.dataset.aiPronounce, button);
    } else if (button.dataset.articleSpeak !== undefined) {
      playEnglish(button.dataset.articleSpeak, { rate: Number(button.dataset.rate) || 1, button });
    } else if (button.dataset.aiRetryWord !== undefined) {
      await lookupAiSentenceWord(button.dataset.aiRetryWord, button.dataset.aiSentence);
    } else if (button.dataset.aiEditWord !== undefined) {
      openAiSentenceWord(button.dataset.aiEditWord, button.dataset.aiSentence, { editing: true });
    } else if (button.dataset.articleUnknown !== undefined) {
      await setArticleUnknown(button.dataset.articleUnknown, true);
    } else if (button.dataset.articleKnown !== undefined) {
      await setArticleUnknown(button.dataset.articleKnown, false);
    } else if (button.dataset.articleAddWord !== undefined) {
      prefillArticleCard('Words', button.dataset.articleAddWord);
    } else if (button.dataset.articleAddSentence !== undefined) {
      prefillArticleCard('Sentences', button.dataset.articleAddSentence);
    }
  });
  $('#article-action-content').addEventListener('submit', async (e) => {
    const form = e.target.closest('#ai-word-inline-form');
    if (!form) return;
    e.preventDefault();
    await saveInlineAiWord(form);
  });

  $('#ai-root').addEventListener('change', (e) => {
    if (e.target.id === 'ai-topic') state.ai.topic = e.target.value;
    if (e.target.id === 'ai-difficulty') state.ai.difficulty = e.target.value;
  });

  $('#ai-root').addEventListener('click', async (e) => {
    const word = e.target.closest('[data-ai-sentence-word]');
    if (word) {
      e.preventDefault(); e.stopPropagation();
      const sentence = state.ai.preview?.data.sentences[Number(word.dataset.aiSentenceIndex)];
      if (sentence) await showAiSentenceWord(word.dataset.aiSentenceWord, sentence.english);
      return;
    }
    const articleWord = e.target.closest('[data-ai-article-word]');
    if (articleWord) {
      e.preventDefault(); e.stopPropagation();
      const preview = state.ai.preview;
      const sentence = preview?.type === 'article' ? aiArticleSentenceAt(preview.data.content, articleWord.dataset.aiArticleSentenceIndex) : '';
      if (sentence) await showAiSentenceWord(articleWord.dataset.aiArticleWord, sentence);
      return;
    }
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.aiMode) {
      if (state.ai.mode === 'article' && button.dataset.aiMode !== 'article') stopAiArticleNarration(false);
      state.ai.mode = button.dataset.aiMode; state.ai.preview = null; state.ai.targets = []; state.ai.candidateCount = 0; state.ai.error = ''; renderAiView();
    } else if (button.hasAttribute('data-ai-home')) {
      stopAiArticleNarration(false);
      state.ai.mode = 'home'; state.ai.preview = null; state.ai.targets = []; state.ai.candidateCount = 0; renderAiHome();
    } else if (button.hasAttribute('data-ai-save-settings')) {
      saveAiSettings($('#ai-endpoint').value, $('#ai-token').value); $('#ai-service-status').textContent = 'AI 设置已保存在此设备。';
    } else if (button.hasAttribute('data-ai-test')) {
      saveAiSettings($('#ai-endpoint').value, $('#ai-token').value); button.disabled = true;
      try { const result = await aiFetch('/health'); state.ai.service = { provider: result.provider, model: result.model }; $('#ai-service-status').textContent = `Provider：${result.provider} · Model：${result.model} · 已连接`; }
      catch (err) { $('#ai-service-status').textContent = err.message; }
      finally { button.disabled = false; }
    } else if (button.hasAttribute('data-ai-generate-sentences')) {
      await generateAi('sentences');
    } else if (button.hasAttribute('data-ai-generate-article')) {
      state.ai.topic = $('#ai-topic')?.value || state.ai.topic; state.ai.difficulty = $('#ai-difficulty')?.value || state.ai.difficulty; await generateAi('article');
    } else if (button.hasAttribute('data-ai-narrate-article')) {
      const rate = Number(button.dataset.rate) === 0.75 ? 0.75 : 1;
      if (state.ai.narrationMode === 'article' && state.ai.narrationRate === rate) stopAiArticleNarration(true); else await startAiArticleNarration(rate);
    } else if (button.dataset.aiNarrateParagraph !== undefined) {
      const paragraphIndex = Number(button.dataset.aiNarrateParagraph);
      if (state.ai.narrationMode === 'paragraph' && state.ai.narrationParagraphIndex === paragraphIndex) {
        stopAiArticleNarration(true);
      } else {
        await startAiArticleNarration(state.ai.narrationSpeed, paragraphIndex);
      }
    } else if (button.dataset.aiPronounce !== undefined) {
      await playAiPronunciation(button.dataset.aiPronounce, button);
    } else if (button.dataset.aiSpeak !== undefined) {
      playEnglish(button.dataset.aiSpeak, { rate: Number(button.dataset.rate) || 1, button });
    } else if (button.dataset.aiReveal !== undefined) {
      const index = Number(button.dataset.aiReveal); if (state.ai.revealed.has(index)) state.ai.revealed.delete(index); else state.ai.revealed.add(index); renderAiSentences();
    } else if (button.dataset.aiParagraphTranslation !== undefined) {
      const index = Number(button.dataset.aiParagraphTranslation);
      if (state.ai.revealedParagraphs.has(index)) state.ai.revealedParagraphs.delete(index); else state.ai.revealedParagraphs.add(index);
      renderAiArticle();
    } else if (button.dataset.aiAddSentence !== undefined) {
      const sentence = state.ai.preview?.data.sentences[Number(button.dataset.aiAddSentence)];
      if (sentence) prefillArticleCard('Sentences', sentence.english, sentence.referenceChinese);
    } else if (button.hasAttribute('data-ai-save-article')) {
      const preview = state.ai.preview;
      if (!preview || preview.type !== 'article') return;
      button.disabled = true;
      try {
        // The optional paragraphTranslations field travels with the Article so
        // Reading can offer the same per-paragraph help later.
        const article = await ArticleStore.create({
          title: preview.data.title, content: preview.data.content,
          paragraphTranslations: preview.data.paragraphTranslations,
          source: 'FlashDesk AI', sourceUrl: '', publishedAt: '',
        });
        state.articles.push(article); state.article.cache.delete(article.id); await openArticle(article.id);
      } catch (err) { state.ai.error = `保存失败：${err.message}`; button.disabled = false; renderAiArticle(); }
    }
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const deck = $('#add-type').value;
    const submit = $('#add-submit');
    if (submit.disabled) return;
    let fields;
    try {
      fields = newCardFields({
        deck, front: $('#add-front').value, back: $('#add-back').value,
        memoryReading: $('#add-memory-reading').value,
        chineseReading: $('#add-chinese-reading').value,
        formsText: $('#add-forms').value,
      });
    } catch { return; }
    submit.disabled = true;
    try {
      await saveNewCard(fields);
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
      const returnToArticle = state.article.returnToId;
      if (returnToArticle) {
        state.article.returnToId = null;
        await openArticle(returnToArticle);
      }
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
      state.article.cache.clear();
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

  window.addEventListener('pagehide', flushArticleProgress);

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
    const { cards, history, meta } = await FlashStore.load();
    state.cards = cards;
    state.history = history;
    state.meta = meta || {};
  } catch (err) {
    $('#review-area').innerHTML = `<div class="panel empty-panel"><p>无法加载卡片： ${esc(err.message)}</p></div>`;
    $('#view-review').hidden = false;
    return;
  }
  try {
    state.articles = await ArticleStore.list();
  } catch (err) {
    state.article.error = err.message;
  }
  try {
    const unknownWords = await ArticleStore.getUnknownWords();
    state.article.unknownWords = new Set(FlashArticleUtils.normalizeUnknownWords(unknownWords));
  } catch {
    // Reading remains usable when an older running Node process has not yet
    // picked up the optional profile route. A restart restores persistence.
    state.article.unknownWords = new Set();
  }
  await refreshAudioCacheStats();
  renderDeckControls();
  switchView('review');
}

init();

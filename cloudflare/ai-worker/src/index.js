import { createProvider, normalizeProvider, providerModel } from './providers/index.js';
import { sentenceMessages } from './prompts/sentences.js';
import { articleMessages } from './prompts/article.js';
import { lookupWordMessages } from './prompts/lookup-word.js';
import { translateArticleMessages } from './prompts/translate-article.js';
import { englishHelperMessages } from './prompts/english-helper.js';
import { organizeLyricsMessages } from './prompts/organize-lyrics.js';
import { explainLyricMessages } from './prompts/explain-lyric.js';
import { englishWordCount, parseAiOutput, validateClientRequest } from './validation.js';
import { createPronunciationProvider, validatePronunciationRequest } from './pronunciation.js';

const MAX_BODY = 50 * 1024;
export const TASK_OUTPUT_TOKEN_LIMITS = Object.freeze({
  generate_sentences: 800,
  generate_article: 2400,
  translate_article: 2000,
  lookup_word: 480,
  english_helper: 520,
  organize_lyrics: 2400,
  explain_lyric: 700,
});
export const TASK_ATTEMPT_LIMITS = Object.freeze({
  generate_sentences: 3,
  generate_article: 2,
  translate_article: 2,
  lookup_word: 3,
  english_helper: 2,
  organize_lyrics: 2,
  explain_lyric: 2,
});
const allowedOrigins = (env) => new Set(['https://704884963-pixel.github.io', 'http://localhost:5902', 'http://127.0.0.1:5902', 'http://[::1]:5902', ...String(env.FLASHDESK_ALLOWED_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean)]);
const cors = (origin, env) => {
  const headers = new Headers({ Vary: 'Origin' });
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return headers;
};
const reply = (body, status, origin, env) => { const headers = cors(origin, env); headers.set('Content-Type', 'application/json; charset=utf-8'); headers.set('Cache-Control', 'no-store'); return new Response(JSON.stringify(body), { status, headers }); };
const failure = (code, message, status, origin, env, diagnostics = {}) => reply({ ok: false, error: { code, message }, ...diagnostics }, status, origin, env);
const authorized = (request, env) => request.headers.get('Authorization') === `Bearer ${env.FLASHDESK_AI_TOKEN}`;

export function generationOptions(task, env, providerName = 'zhipu') {
  const maxOutputTokens = TASK_OUTPUT_TOKEN_LIMITS[task];
  if (normalizeProvider(providerName) === 'gemini') {
    return {
      model: providerModel('gemini', env),
      maxOutputTokens,
      ...(task === 'lookup_word' || task === 'english_helper' || task === 'explain_lyric' || task === 'organize_lyrics' ? {
        temperature: 0.1,
        reasoning: false,
      } : {}),
      timeoutMs: task === 'lookup_word' || task === 'english_helper' || task === 'explain_lyric'
        ? 15000
        : task === 'generate_sentences' ? 45000 : 60000,
    };
  }
  if (task === 'lookup_word' || task === 'english_helper' || task === 'explain_lyric' || task === 'organize_lyrics') {
    return {
      model: env.AI_LOOKUP_MODEL || env.AI_MODEL,
      maxOutputTokens,
      temperature: 0.1,
      reasoning: false,
      timeoutMs: task === 'organize_lyrics' ? 60000 : 15000,
    };
  }
  if (task === 'translate_article') {
    return {
      model: env.AI_TRANSLATION_MODEL || env.AI_LOOKUP_MODEL || env.AI_MODEL,
      maxOutputTokens,
      timeoutMs: 60000,
    };
  }
  return {
    model: env.AI_MODEL,
    maxOutputTokens,
    timeoutMs: task === 'generate_article' ? 60000 : 45000,
  };
}

export function isRetryableProviderError(error) {
  return error?.outcomeUnknown !== true && [502, 503, 504].includes(error?.status);
}

const usageFields = ['inputTokens', 'outputTokens', 'totalTokens'];
function aggregateAttempts(attempts) {
  const usage = {};
  for (const field of usageFields) {
    usage[field] = attempts.every((attempt) => Number.isFinite(attempt.usage?.[field]))
      ? attempts.reduce((total, attempt) => total + attempt.usage[field], 0)
      : null;
  }
  return {
    usage,
    usageKnown: usageFields.every((field) => Number.isFinite(usage[field])),
    attemptCount: attempts.length,
    attemptsSummary: attempts.map(({ attempt, reason, status, usage: attemptUsage }) => ({ attempt, reason, status, usage: attemptUsage })),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleRequest(request, env, fetchImpl = fetch, pronunciationProviderFactory = createPronunciationProvider, now = Date.now, sleep = wait, optionsFactory = generationOptions) {
  const url = new URL(request.url); const origin = request.headers.get('Origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return failure('UNAUTHORIZED', 'Origin not allowed', 403, '', env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, env) });
  if (!env.FLASHDESK_AI_TOKEN || !authorized(request, env)) return failure('UNAUTHORIZED', '未授权', 401, origin, env);
  if (url.pathname === '/health' && request.method === 'GET') {
    const providerName = normalizeProvider(url.searchParams.get('provider'));
    return reply({ ok: true, provider: providerName, model: providerModel(providerName, env) }, 200, origin, env);
  }
  if (url.pathname === '/pronounce' && request.method === 'POST') {
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY) return failure('INVALID_REQUEST', '请求过大', 413, origin, env);
    let input;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) throw new Error('too large');
      input = validatePronunciationRequest(JSON.parse(text));
    } catch {
      return failure('INVALID_REQUEST', '发音请求无效', 400, origin, env);
    }
    let provider;
    try { provider = pronunciationProviderFactory(env); } catch { provider = null; }
    if (!provider || typeof provider.synthesize !== 'function') return failure('PRONUNCIATION_UNAVAILABLE', 'AI 发音服务尚未配置', 503, origin, env);
    try {
      const result = await provider.synthesize(input);
      const contentType = String(result?.contentType || '');
      if (!result?.audio || !contentType.startsWith('audio/')) throw new Error('invalid pronunciation audio');
      const headers = cors(origin, env);
      headers.set('Content-Type', contentType);
      headers.set('Cache-Control', 'no-store');
      return new Response(result.audio, { status: 200, headers });
    } catch {
      return failure('PRONUNCIATION_PROVIDER_ERROR', 'AI 发音暂时不可用', 502, origin, env);
    }
  }
  if (url.pathname !== '/ai' || request.method !== 'POST') return failure('INVALID_REQUEST', '请求无效', 400, origin, env);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return failure('INVALID_REQUEST', '请求过大', 413, origin, env);
  let text; let input;
  try { text = await request.text(); if (text.length > MAX_BODY) throw new Error('too large'); input = validateClientRequest(JSON.parse(text)); }
  catch { return failure('INVALID_REQUEST', '请求格式无效', 400, origin, env, { attemptCount: 0 }); }
  const messages = input.task === 'generate_sentences'
    ? sentenceMessages(input.context)
    : input.task === 'generate_article' ? articleMessages(input.context)
      : input.task === 'translate_article' ? translateArticleMessages(input.context)
        : input.task === 'english_helper' ? englishHelperMessages(input.context)
          : input.task === 'organize_lyrics' ? organizeLyricsMessages(input.context)
            : input.task === 'explain_lyric' ? explainLyricMessages(input.context) : lookupWordMessages(input.context);
  let provider;
  try { provider = createProvider(input.provider, env, fetchImpl); } catch { return failure('UPSTREAM_ERROR', 'AI 服务配置错误', 503, origin, env, { attemptCount: 0 }); }
  const generation = optionsFactory(input.task, env, input.provider);
  const maxAttempts = TASK_ATTEMPT_LIMITS[input.task];
  const attempts = [];
  let providerTotalMs = 0;
  let networkRetries = 0;
  let lengthRewrite = false;
  let initialWordCount = null;
  let finalWordCount = null;
  const diagnostics = () => ({
    ...aggregateAttempts(attempts),
    timing: {
      providerTotalMs,
      providerCalls: attempts.length,
      networkRetries,
      lengthRewrite,
      ...(input.task === 'generate_sentences' ? { initialWordCount, finalWordCount } : {}),
    },
  });
  const generate = async (requestMessages, initialReason = 'initial') => {
    const providerRequest = { messages: requestMessages, task: input.task, options: input.options, ...generation };
    let reason = initialReason;
    while (attempts.length < maxAttempts) {
      const entry = { attempt: attempts.length + 1, reason, status: 'unknown', usage: null };
      attempts.push(entry);
      const started = now();
      let shouldRetry = false;
      try {
        const result = await provider.generate(providerRequest);
        entry.status = 'success';
        entry.usage = Object.fromEntries(usageFields.map((field) => [field, Number.isFinite(result?.usage?.[field]) ? result.usage[field] : null]));
        return result;
      } catch (error) {
        entry.status = error?.outcomeUnknown ? 'unknown'
          : Number.isFinite(error?.status) ? 'http_error'
            : error?.networkFailure ? 'unknown' : 'unknown';
        if (isRetryableProviderError(error) && networkRetries < 1 && attempts.length < maxAttempts) {
          networkRetries += 1;
          reason = 'retry';
          shouldRetry = true;
        } else {
          throw error;
        }
      } finally {
        providerTotalMs += Math.max(0, now() - started);
      }
      if (shouldRetry) {
        await sleep(1000);
        continue;
      }
    }
    const error = new Error('provider attempt budget exhausted');
    error.code = 'ATTEMPT_BUDGET_EXHAUSTED';
    throw error;
  };
  try {
    let generated = await generate(messages, 'initial');
    let data;
    try {
      data = parseAiOutput(input.task, generated.content, input.context);
    } catch {
      if (attempts.length < maxAttempts) {
        const repairMessages = [...messages,
          { role: 'assistant', content: generated.content },
          { role: 'user', content: 'Return the same answer once more as valid JSON matching the required schema exactly. Do not add explanations or markdown.' },
        ];
        generated = await generate(repairMessages, 'format_repair');
        try { data = parseAiOutput(input.task, generated.content, input.context); } catch { data = null; }
      }
      if (!data) return failure('INVALID_AI_OUTPUT', input.task === 'translate_article'
        ? '参考翻译段落未能正确对齐，请重试。'
        : 'AI 输出格式错误', 502, origin, env, diagnostics());
    }
    if (input.task === 'lookup_word' && (!data.memoryReading || !data.chineseReading)) {
      const incomplete = data;
      const correctionMessages = [...messages,
        { role: 'assistant', content: generated.content },
        { role: 'user', content: 'The pronunciation learning drafts are incomplete. Return the same strict JSON schema once more. Preserve the meanings, base form, and grammatical forms. For an ordinary lexical English word, provide a short practical memoryReading sound breakdown and a short chineseReading approximation draft. These are editable aids, not standard pronunciation. If a responsible draft truly cannot be given, an empty string is allowed. Return JSON only.' },
      ];
      try {
        const corrected = await generate(correctionMessages, 'pronunciation_repair');
        const correctedData = parseAiOutput(input.task, corrected.content, input.context);
        generated = corrected;
        data = correctedData;
      } catch (error) {
        if (error?.outcomeUnknown) throw error;
        data = incomplete;
      }
    }
    if (input.task === 'generate_sentences') {
      initialWordCount = englishWordCount(data.sentences[0].english);
      finalWordCount = initialWordCount;
    }
    if (input.task === 'generate_sentences' && initialWordCount < 32) {
      const rewriteMessages = [...messages,
        { role: 'assistant', content: generated.content },
        { role: 'user', content: 'The previous sentence is too short for this close-reading exercise. Rewrite it as ONE natural English sentence of approximately 38-45 words. Preserve the original meaning and naturally used target words. Add one or two genuinely meaningful grammatical or logical elements, such as a reason, consequence, condition, contrast, personal detail, concrete result, relative clause, or subordinate clause. Keep the vocabulary common, practical, adult, and below CET-4 level; make the sentence longer through fuller information and structure, not harder words. Do not add filler, repeat the same idea with synonyms, create a second sentence, use a semicolon to fake multiple sentences, or force unrelated target words. Return only valid JSON matching the original schema.' },
      ];
      if (attempts.length >= maxAttempts) {
        finalWordCount = initialWordCount;
      } else {
        lengthRewrite = true;
        generated = await generate(rewriteMessages, 'length_rewrite');
        try { data = parseAiOutput(input.task, generated.content, input.context); }
        catch { return failure('INVALID_AI_OUTPUT', 'AI 输出格式错误', 502, origin, env, diagnostics()); }
        finalWordCount = englishWordCount(data.sentences[0].english);
      }
    }
    const resultDiagnostics = diagnostics();
    return reply({
      ok: true, task: input.task, provider: input.provider, model: generation.model,
      data, ...resultDiagnostics,
    }, 200, origin, env);
  } catch (error) {
    const resultDiagnostics = diagnostics();
    if (error?.outcomeUnknown && /deadline/i.test(error.message)) return failure('TIMEOUT', 'AI 请求超时', 504, origin, env, resultDiagnostics);
    if (error?.status === 429) return failure('RATE_LIMITED', '请求过于频繁', 429, origin, env, resultDiagnostics);
    if (error?.status === 401 || error?.status === 403) return failure('UPSTREAM_ERROR', 'AI 服务认证失败', 502, origin, env, resultDiagnostics);
    return failure('UPSTREAM_ERROR', 'AI 服务暂时不可用', 502, origin, env, resultDiagnostics);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };

import { createProvider } from './providers/index.js';
import { sentenceMessages } from './prompts/sentences.js';
import { articleMessages } from './prompts/article.js';
import { lookupWordMessages } from './prompts/lookup-word.js';
import { translateArticleMessages } from './prompts/translate-article.js';
import { englishWordCount, parseAiOutput, validateClientRequest } from './validation.js';
import { createPronunciationProvider, validatePronunciationRequest } from './pronunciation.js';

const MAX_BODY = 50 * 1024;
const allowedOrigins = (env) => new Set(['https://704884963-pixel.github.io', 'http://localhost:5902', 'http://127.0.0.1:5902', 'http://[::1]:5902', ...String(env.FLASHDESK_ALLOWED_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean)]);
const cors = (origin, env) => {
  const headers = new Headers({ Vary: 'Origin' });
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return headers;
};
const reply = (body, status, origin, env) => { const headers = cors(origin, env); headers.set('Content-Type', 'application/json; charset=utf-8'); headers.set('Cache-Control', 'no-store'); return new Response(JSON.stringify(body), { status, headers }); };
const failure = (code, message, status, origin, env) => reply({ ok: false, error: { code, message } }, status, origin, env);
const authorized = (request, env) => request.headers.get('Authorization') === `Bearer ${env.FLASHDESK_AI_TOKEN}`;

export function generationOptions(task, env) {
  if (task === 'lookup_word') {
    return {
      model: env.AI_LOOKUP_MODEL || env.AI_MODEL,
      maxOutputTokens: 240,
      temperature: 0.1,
      reasoning: false,
      timeoutMs: 15000,
    };
  }
  if (task === 'translate_article') {
    return {
      model: env.AI_TRANSLATION_MODEL || env.AI_LOOKUP_MODEL || env.AI_MODEL,
      timeoutMs: 60000,
    };
  }
  return {
    model: env.AI_MODEL,
    timeoutMs: task === 'generate_article' ? 60000 : 45000,
  };
}

export function isRetryableProviderError(error) {
  return error?.name === 'AbortError'
    || error?.networkFailure === true
    || [502, 503, 504].includes(error?.status);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleRequest(request, env, fetchImpl = fetch, pronunciationProviderFactory = createPronunciationProvider, now = Date.now, sleep = wait) {
  const url = new URL(request.url); const origin = request.headers.get('Origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return failure('UNAUTHORIZED', 'Origin not allowed', 403, '', env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, env) });
  if (!env.FLASHDESK_AI_TOKEN || !authorized(request, env)) return failure('UNAUTHORIZED', '未授权', 401, origin, env);
  if (url.pathname === '/health' && request.method === 'GET') return reply({ ok: true, provider: env.AI_PROVIDER, model: env.AI_MODEL }, 200, origin, env);
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
      return failure('PRONUNCIATION_FAILED', 'AI 发音失败', 502, origin, env);
    }
  }
  if (url.pathname !== '/ai' || request.method !== 'POST') return failure('INVALID_REQUEST', '请求无效', 400, origin, env);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return failure('INVALID_REQUEST', '请求过大', 413, origin, env);
  let text; let input;
  try { text = await request.text(); if (text.length > MAX_BODY) throw new Error('too large'); input = validateClientRequest(JSON.parse(text)); }
  catch { return failure('INVALID_REQUEST', '请求格式无效', 400, origin, env); }
  const messages = input.task === 'generate_sentences'
    ? sentenceMessages(input.context)
    : input.task === 'generate_article' ? articleMessages(input.context)
      : input.task === 'translate_article' ? translateArticleMessages(input.context) : lookupWordMessages(input.context);
  let provider;
  try { provider = createProvider(env, fetchImpl); } catch { return failure('UPSTREAM_ERROR', 'AI 服务配置错误', 503, origin, env); }
  try {
    const generation = generationOptions(input.task, env);
    let providerTotalMs = 0;
    let providerCalls = 0;
    let networkRetries = 0;
    let lengthRewrite = false;
    let initialWordCount = null;
    let finalWordCount = null;
    const generate = async (requestMessages) => {
      const providerRequest = { messages: requestMessages, task: input.task, options: input.options, ...generation };
      let requestAttempts = 0;
      while (requestAttempts < 2) {
        providerCalls += 1;
        requestAttempts += 1;
        const started = now();
        try {
          return await provider.generate(providerRequest);
        } catch (error) {
          if (requestAttempts < 2 && isRetryableProviderError(error)) {
            networkRetries += 1;
          } else {
            throw error;
          }
        } finally {
          providerTotalMs += Math.max(0, now() - started);
        }
        await sleep(1000);
      }
      throw new Error('provider attempts exhausted');
    };
    let generated = await generate(messages);
    let data;
    try { data = parseAiOutput(input.task, generated.content, input.context); }
    catch {
      return failure('INVALID_AI_OUTPUT', input.task === 'translate_article'
        ? '参考翻译段落未能正确对齐，请重试。'
        : 'AI 输出格式错误', 502, origin, env);
    }
    if (input.task === 'generate_sentences') {
      initialWordCount = englishWordCount(data.sentences[0].english);
      finalWordCount = initialWordCount;
    }
    if (input.task === 'generate_sentences' && initialWordCount < 32) {
      lengthRewrite = true;
      const rewriteMessages = [...messages,
        { role: 'assistant', content: generated.content },
        { role: 'user', content: 'The previous sentence is too short for this close-reading exercise. Rewrite it as ONE natural English sentence of approximately 38-45 words. Preserve the original meaning and naturally used target words. Add one or two genuinely meaningful grammatical or logical elements, such as a reason, consequence, condition, contrast, personal detail, concrete result, relative clause, or subordinate clause. Keep the vocabulary common, practical, adult, and below CET-4 level; make the sentence longer through fuller information and structure, not harder words. Do not add filler, repeat the same idea with synonyms, create a second sentence, use a semicolon to fake multiple sentences, or force unrelated target words. Return only valid JSON matching the original schema.' },
      ];
      generated = await generate(rewriteMessages);
      try { data = parseAiOutput(input.task, generated.content, input.context); }
      catch { return failure('INVALID_AI_OUTPUT', 'AI 输出格式错误', 502, origin, env); }
      finalWordCount = englishWordCount(data.sentences[0].english);
    }
    return reply({
      ok: true, task: input.task, provider: env.AI_PROVIDER, model: generation.model,
      data, usage: generated.usage,
      timing: {
        providerTotalMs, providerCalls, networkRetries, lengthRewrite,
        ...(input.task === 'generate_sentences' ? { initialWordCount, finalWordCount } : {}),
      },
    }, 200, origin, env);
  } catch (error) {
    if (error?.name === 'AbortError') return failure('TIMEOUT', 'AI 请求超时', 504, origin, env);
    if (error?.status === 429) return failure('RATE_LIMITED', '请求过于频繁', 429, origin, env);
    if (error?.status === 401 || error?.status === 403) return failure('UPSTREAM_ERROR', 'AI 服务认证失败', 502, origin, env);
    return failure('UPSTREAM_ERROR', 'AI 服务暂时不可用', 502, origin, env);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };

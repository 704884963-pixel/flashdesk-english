import { createProvider } from './providers/index.js';
import { sentenceMessages } from './prompts/sentences.js';
import { articleMessages } from './prompts/article.js';
import { lookupWordMessages } from './prompts/lookup-word.js';
import { parseAiOutput, validateClientRequest } from './validation.js';
import { createPronunciationProvider, validatePronunciationRequest } from './pronunciation.js';

const MAX_BODY = 50 * 1024;
const allowedOrigins = (env) => new Set(['https://704884963-pixel.github.io', 'http://localhost:5902', 'http://127.0.0.1:5902', ...String(env.FLASHDESK_ALLOWED_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean)]);
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

export async function handleRequest(request, env, fetchImpl = fetch, pronunciationProviderFactory = createPronunciationProvider) {
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
    : input.task === 'generate_article' ? articleMessages(input.context) : lookupWordMessages(input.context);
  let provider;
  try { provider = createProvider(env, fetchImpl); } catch { return failure('UPSTREAM_ERROR', 'AI 服务配置错误', 503, origin, env); }
  try {
    let generated = await provider.generate({ messages, task: input.task, options: input.options });
    let data;
    try { data = parseAiOutput(input.task, generated.content); }
    catch {
      generated = await provider.generate({ messages: [...messages, { role: 'user', content: 'Your previous output was invalid. Return only valid JSON matching the requested schema.' }], task: input.task, options: input.options });
      try { data = parseAiOutput(input.task, generated.content); } catch { return failure('INVALID_AI_OUTPUT', 'AI 输出格式错误', 502, origin, env); }
    }
    return reply({ ok: true, task: input.task, provider: env.AI_PROVIDER, model: env.AI_MODEL, data, usage: generated.usage }, 200, origin, env);
  } catch (error) {
    if (error?.name === 'AbortError') return failure('TIMEOUT', 'AI 请求超时', 504, origin, env);
    if (error?.status === 429) return failure('RATE_LIMITED', '请求过于频繁', 429, origin, env);
    if (error?.status === 401 || error?.status === 403) return failure('UPSTREAM_ERROR', 'AI 服务认证失败', 502, origin, env);
    return failure('UPSTREAM_ERROR', 'AI 服务暂时不可用', 502, origin, env);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };

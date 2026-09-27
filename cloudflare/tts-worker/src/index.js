const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://704884963-pixel.github.io',
  'http://localhost:5902',
  'http://127.0.0.1:5902',
]);

const MAX_TEXT_LENGTH = 500;
const ELEVENLABS_MODEL = 'eleven_flash_v2_5';
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

function allowedOrigins(env) {
  const configured = String(env.FLASHDESK_ALLOWED_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function corsHeaders(origin, env) {
  const headers = new Headers({ Vary: 'Origin' });
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Expose-Headers', 'X-ElevenLabs-Request-Id, X-FlashDesk-Voice-ID');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}

function jsonResponse(body, status, origin, env) {
  const headers = corsHeaders(origin, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}

function safeTokenEqual(actual, expected) {
  const a = String(actual || '');
  const b = String(expected || '');
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    different |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return different === 0;
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';

  if (url.pathname !== '/tts') {
    return jsonResponse({ error: 'Not found' }, 404, origin, env);
  }
  if (origin && !allowedOrigins(env).has(origin)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, '', env);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin, env);
  }
  if (!env.FLASHDESK_TTS_TOKEN || !env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    return jsonResponse({ error: 'TTS service is not configured' }, 503, origin, env);
  }

  const authorization = request.headers.get('Authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!safeTokenEqual(suppliedToken, env.FLASHDESK_TTS_TOKEN)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON' }, 400, origin, env);
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return jsonResponse({ error: 'text is required' }, 400, origin, env);
  if ([...text].length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `text must be ${MAX_TEXT_LENGTH} characters or fewer` }, 400, origin, env);
  }

  const elevenLabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  let upstream;
  try {
    upstream = await fetchImpl(elevenLabsUrl, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
    });
  } catch {
    return jsonResponse({ error: 'ElevenLabs is temporarily unavailable' }, 502, origin, env);
  }

  const requestId = upstream.headers.get('request-id') || upstream.headers.get('x-request-id') || '';
  if (!upstream.ok) {
    return jsonResponse({
      error: 'ElevenLabs request failed',
      upstreamStatus: upstream.status,
      ...(requestId ? { requestId } : {}),
    }, 502, origin, env);
  }

  const headers = corsHeaders(origin, env);
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-FlashDesk-Voice-ID', env.ELEVENLABS_VOICE_ID);
  if (requestId) headers.set('X-ElevenLabs-Request-Id', requestId);
  return new Response(upstream.body, { status: 200, headers });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

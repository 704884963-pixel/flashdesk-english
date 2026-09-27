import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.js';

const env = {
  ELEVENLABS_API_KEY: 'eleven-secret',
  ELEVENLABS_VOICE_ID: 'voice-id',
  FLASHDESK_TTS_TOKEN: 'personal-token',
};

function request(body, { token = 'personal-token', origin = 'http://localhost:5902' } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request('https://worker.example/tts', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

test('missing token returns 401 without calling ElevenLabs', async () => {
  let called = false;
  const response = await handleRequest(request({ text: 'hello' }, { token: null }), env, async () => { called = true; });
  assert.equal(response.status, 401);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('wrong token returns 401', async () => {
  const response = await handleRequest(request({ text: 'hello' }, { token: 'wrong' }), env, async () => {
    throw new Error('must not call upstream');
  });
  assert.equal(response.status, 401);
});

test('empty text returns 400', async () => {
  const response = await handleRequest(request({ text: '   ' }), env, async () => {
    throw new Error('must not call upstream');
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'text is required' });
});

test('text over 500 characters returns 400', async () => {
  const response = await handleRequest(request({ text: 'a'.repeat(501) }), env, async () => {
    throw new Error('must not call upstream');
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /500/);
});

test('ElevenLabs API error becomes a safe diagnostic response', async () => {
  const response = await handleRequest(request({ text: 'hello' }), env, async () => new Response('private upstream detail', {
    status: 429,
    headers: { 'request-id': 'req-123' },
  }));
  assert.equal(response.status, 502);
  const safeBody = await response.clone().text();
  assert.deepEqual(await response.json(), {
    error: 'ElevenLabs request failed',
    upstreamStatus: 429,
    requestId: 'req-123',
  });
  assert.doesNotMatch(safeBody, /eleven-secret|personal-token/);
});

test('successful request uses the official synchronous API and returns audio/mpeg', async () => {
  let upstreamRequest;
  const response = await handleRequest(request({ text: ' approach ' }), env, async (url, init) => {
    upstreamRequest = { url, init };
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'request-id': 'req-ok' },
    });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5902');
  assert.equal(response.headers.get('X-FlashDesk-Voice-ID'), 'voice-id');
  assert.match(upstreamRequest.url, /\/v1\/text-to-speech\/voice-id\?output_format=mp3_44100_128$/);
  assert.equal(upstreamRequest.init.headers['xi-api-key'], 'eleven-secret');
  assert.deepEqual(JSON.parse(upstreamRequest.init.body), {
    text: 'approach',
    model_id: 'eleven_flash_v2_5',
  });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

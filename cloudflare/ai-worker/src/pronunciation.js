const MAX_PRONUNCIATION_TEXT = 500;
const MELOTTS_MODEL = '@cf/myshell-ai/melotts';

export function validatePronunciationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid pronunciation request');
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  const locale = typeof value.locale === 'string' ? value.locale.trim() : '';
  if (!text || text.length > MAX_PRONUNCIATION_TEXT || locale !== 'en-US') throw new Error('invalid pronunciation request');
  return { text, locale };
}

function decodeBase64Audio(value) {
  let encoded = String(value || '').trim();
  if (encoded.startsWith('data:')) {
    const match = encoded.match(/^data:audio\/mpeg;base64,([\s\S]*)$/i);
    if (!match) throw new Error('invalid pronunciation audio');
    encoded = match[1].trim();
  }
  encoded = encoded.replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('invalid pronunciation audio');
  }
  const firstPadding = encoded.indexOf('=');
  if (firstPadding !== -1 && firstPadding < encoded.length - (encoded.endsWith('==') ? 2 : 1)) {
    throw new Error('invalid pronunciation audio');
  }
  const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), '=');
  let binary;
  try { binary = atob(padded); } catch { throw new Error('invalid pronunciation audio'); }
  if (!binary.length) throw new Error('empty pronunciation audio');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function audioBody(value) {
  if (value && typeof value === 'object' && typeof value.audio === 'string') {
    return decodeBase64Audio(value.audio);
  }
  if (typeof Response !== 'undefined' && value instanceof Response) {
    const contentType = String(value.headers.get('Content-Type') || '');
    if (contentType && !contentType.startsWith('audio/')) throw new Error('invalid pronunciation audio');
    if (!value.body) throw new Error('empty pronunciation audio');
    return value.body;
  }
  if (value instanceof ArrayBuffer) {
    if (!value.byteLength) throw new Error('empty pronunciation audio');
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    if (!value.byteLength) throw new Error('empty pronunciation audio');
    return value;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    if (!value.size || (value.type && !value.type.startsWith('audio/'))) throw new Error('invalid pronunciation audio');
    return value;
  }
  if (value && typeof value.getReader === 'function') return value;
  throw new Error('invalid pronunciation audio');
}

// Keep the route provider-neutral: the adapter owns the Cloudflare model and
// locale mapping, while callers only provide validated text plus a locale.
export function createPronunciationProvider(env) {
  if (!env?.AI || typeof env.AI.run !== 'function') return null;
  return {
    async synthesize({ text, locale }) {
      if (locale !== 'en-US') throw new Error('unsupported pronunciation locale');
      const output = await env.AI.run(MELOTTS_MODEL, { prompt: text, lang: 'en' });
      return { audio: audioBody(output), contentType: 'audio/mpeg' };
    },
  };
}

export { MAX_PRONUNCIATION_TEXT, MELOTTS_MODEL };

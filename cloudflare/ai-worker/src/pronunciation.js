const MAX_PRONUNCIATION_TEXT = 500;
const AURA_MODEL = '@cf/deepgram/aura-1';
const DEFAULT_PRONUNCIATION_SPEAKER = 'asteria';
const PRONUNCIATION_SPEAKERS = Object.freeze(['asteria', 'orion', 'luna']);

export function normalizePronunciationSpeaker(value) {
  return PRONUNCIATION_SPEAKERS.includes(value) ? value : DEFAULT_PRONUNCIATION_SPEAKER;
}

export function validatePronunciationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid pronunciation request');
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  const locale = typeof value.locale === 'string' ? value.locale.trim() : '';
  if (!text || text.length > MAX_PRONUNCIATION_TEXT || locale !== 'en-US') throw new Error('invalid pronunciation request');
  return { text, locale, speaker: normalizePronunciationSpeaker(value.speaker) };
}

function audioBody(value) {
  if (typeof Response !== 'undefined' && value instanceof Response) {
    const contentType = String(value.headers.get('Content-Type') || 'audio/mpeg');
    if (!contentType.startsWith('audio/') || !value.body) throw new Error('invalid pronunciation audio');
    return { audio: value.body, contentType };
  }
  if (value instanceof ArrayBuffer) {
    if (!value.byteLength) throw new Error('empty pronunciation audio');
    return { audio: value, contentType: 'audio/mpeg' };
  }
  if (ArrayBuffer.isView(value)) {
    if (!value.byteLength) throw new Error('empty pronunciation audio');
    return { audio: value, contentType: 'audio/mpeg' };
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    if (!value.size || (value.type && !value.type.startsWith('audio/'))) throw new Error('invalid pronunciation audio');
    return { audio: value, contentType: value.type || 'audio/mpeg' };
  }
  if (value && typeof value.getReader === 'function') return { audio: value, contentType: 'audio/mpeg' };
  throw new Error('invalid pronunciation audio');
}

// Keep the route provider-neutral: only this adapter knows the Cloudflare
// model, speaker allowlist, encoding, and raw-response contract.
export function createPronunciationProvider(env) {
  if (!env?.AI || typeof env.AI.run !== 'function') return null;
  return {
    async synthesize({ text, locale, speaker }) {
      if (locale !== 'en-US') throw new Error('unsupported pronunciation locale');
      const output = await env.AI.run(AURA_MODEL, {
        text,
        speaker: normalizePronunciationSpeaker(speaker),
        encoding: 'mp3',
      }, { returnRawResponse: true });
      return audioBody(output);
    },
  };
}

export {
  AURA_MODEL,
  DEFAULT_PRONUNCIATION_SPEAKER,
  MAX_PRONUNCIATION_TEXT,
  PRONUNCIATION_SPEAKERS,
};

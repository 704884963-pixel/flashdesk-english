const MAX_PRONUNCIATION_TEXT = 500;

export function validatePronunciationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid pronunciation request');
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  const locale = typeof value.locale === 'string' ? value.locale.trim() : '';
  if (!text || text.length > MAX_PRONUNCIATION_TEXT || locale !== 'en-US') throw new Error('invalid pronunciation request');
  return { text, locale };
}

// Provider-neutral boundary for a future pronunciation service. No provider is
// selected yet, so production deliberately returns unavailable instead of
// synthesizing placeholder or fake audio.
export function createPronunciationProvider(_env) {
  return null;
}

export { MAX_PRONUNCIATION_TEXT };

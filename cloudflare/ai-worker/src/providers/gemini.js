import { ProviderError } from './error.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiMessages(messages) {
  const systemText = messages
    .filter((message) => message?.role === 'system')
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const contents = messages
    .filter((message) => message?.role !== 'system')
    .map((message) => ({
      role: message?.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message?.content || '') }],
    }));
  return { systemText, contents };
}

function lowThinkingConfig(model) {
  // Gemini 3 uses thinkingLevel. Avoid sending a model-family-specific field
  // to older/custom models so an environment override remains compatible.
  return /^gemini-3(?:[.-]|$)/i.test(String(model || '')) ? { thinkingLevel: 'low' } : null;
}

function responseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
}

function isBlocked(payload) {
  if (payload?.promptFeedback?.blockReason) return true;
  const reason = String(payload?.candidates?.[0]?.finishReason || '').toUpperCase();
  return ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(reason);
}

export function createGeminiProvider(env, fetchImpl = fetch) {
  if (!env.GEMINI_API_KEY) throw new ProviderError('Gemini provider is not configured', { code: 'PROVIDER_NOT_CONFIGURED' });
  return {
    async generate({ messages, model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, maxOutputTokens, temperature, timeoutMs = 25000 }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const { systemText, contents } = geminiMessages(messages || []);
      const generationConfig = { responseMimeType: 'application/json' };
      if (Number.isFinite(maxOutputTokens)) generationConfig.maxOutputTokens = maxOutputTokens;
      if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
      const thinkingConfig = lowThinkingConfig(model);
      if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
      const body = { contents, generationConfig };
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
      let response;
      try {
        try {
          response = await fetchImpl(`${GEMINI_API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw new ProviderError('Gemini network request failed', { networkFailure: true, cause: error });
        }
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new ProviderError('Gemini upstream request failed', { status: response.status });
      let payload;
      try { payload = await response.json(); }
      catch (error) { throw new ProviderError('Gemini returned malformed JSON', { code: 'INVALID_PROVIDER_RESPONSE', cause: error }); }
      if (isBlocked(payload)) throw new ProviderError('Gemini response was blocked', { code: 'PROVIDER_BLOCKED' });
      const content = responseText(payload);
      if (!content) throw new ProviderError('Gemini returned no text', { code: 'INVALID_PROVIDER_RESPONSE' });
      const usage = payload?.usageMetadata || {};
      return {
        content,
        usage: {
          inputTokens: Number.isFinite(usage.promptTokenCount) ? usage.promptTokenCount : null,
          outputTokens: Number.isFinite(usage.candidatesTokenCount) ? usage.candidatesTokenCount : null,
          totalTokens: Number.isFinite(usage.totalTokenCount) ? usage.totalTokenCount : null,
        },
      };
    },
  };
}

import { ProviderError } from './error.js';

const DEFAULT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

export function createZhipuProvider(env, fetchImpl = fetch) {
  return {
    async generate({ messages, task, model = env.AI_MODEL, maxOutputTokens, temperature, reasoning, timeoutMs = 25000 }) {
      const controller = new AbortController();
      let rejectDeadline;
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new ProviderError('Zhipu request deadline exceeded', { code: 'PROVIDER_RESULT_UNKNOWN', outcomeUnknown: true }));
      }, timeoutMs);
      let response;
      try {
        const body = { model, messages, stream: false, response_format: { type: 'json_object' } };
        if (Number.isFinite(maxOutputTokens)) body.max_tokens = maxOutputTokens;
        if (Number.isFinite(temperature)) body.temperature = temperature;
        if (reasoning === false || task === 'generate_sentences') body.thinking = { type: 'disabled' };
        try {
          response = await Promise.race([fetchImpl(env.ZHIPU_BASE_URL || DEFAULT_URL, {
            method: 'POST', signal: controller.signal,
            headers: { Authorization: `Bearer ${env.ZHIPU_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }), deadline]);
        } catch (error) {
          if (error?.outcomeUnknown) throw error;
          throw new ProviderError('Zhipu network request failed', { code: 'PROVIDER_RESULT_UNKNOWN', networkFailure: true, outcomeUnknown: true, cause: error });
        }
        if (!response.ok) throw new ProviderError('Zhipu upstream request failed', { status: response.status });
        let raw;
        try { raw = await Promise.race([response.text(), deadline]); }
        catch (error) {
          if (error?.outcomeUnknown) throw error;
          throw new ProviderError('Zhipu response body failed', { code: 'PROVIDER_RESULT_UNKNOWN', outcomeUnknown: true, cause: error });
        }
        let payload;
        try { payload = JSON.parse(raw); }
        catch (error) { throw new ProviderError('Zhipu returned malformed JSON', { code: 'PROVIDER_RESULT_UNKNOWN', outcomeUnknown: true, cause: error }); }
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new ProviderError('Zhipu returned no text', { code: 'INVALID_PROVIDER_RESPONSE' });
        const usage = payload?.usage || {};
        return { content, usage: {
          inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
          outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
          totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
        } };
      } finally { clearTimeout(timer); }
    },
  };
}

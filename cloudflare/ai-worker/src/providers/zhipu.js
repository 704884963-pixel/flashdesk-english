const DEFAULT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

export function createZhipuProvider(env, fetchImpl = fetch) {
  return {
    async generate({ messages, model = env.AI_MODEL, maxOutputTokens, temperature, reasoning }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let response;
      try {
        const body = { model, messages, stream: false, response_format: { type: 'json_object' } };
        if (Number.isFinite(maxOutputTokens)) body.max_tokens = maxOutputTokens;
        if (Number.isFinite(temperature)) body.temperature = temperature;
        if (reasoning === false) body.thinking = { type: 'disabled' };
        response = await fetchImpl(env.ZHIPU_BASE_URL || DEFAULT_URL, {
          method: 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${env.ZHIPU_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } finally { clearTimeout(timer); }
      if (!response.ok) {
        const error = new Error('upstream request failed'); error.status = response.status; throw error;
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('invalid upstream response');
      const usage = payload?.usage || {};
      return { content, usage: {
        inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
        outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
        totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
      } };
    },
  };
}

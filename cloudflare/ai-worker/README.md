# FlashDesk AI Worker

This Worker is separate from the TTS Worker and keeps provider credentials off the client.

1. Log in to Cloudflare with Wrangler.
2. Copy `wrangler.toml.example` to `wrangler.toml` and configure `AI_MODEL`. Optionally set `AI_LOOKUP_MODEL` for word lookup and `AI_TRANSLATION_MODEL` for Article translation. `GEMINI_MODEL` controls the Gemini model and defaults to `gemini-3.8-flash`; it can be changed without editing source. Keep the `[ai]` binding so pronunciation can call Workers AI through `env.AI`.
3. Add the Zhipu key with `npx wrangler secret put ZHIPU_API_KEY`.
4. Add the Gemini key with `npx wrangler secret put GEMINI_API_KEY`.
5. Add the app access token with `npx wrangler secret put FLASHDESK_AI_TOKEN`.
6. Deploy with Wrangler.
7. In FlashDesk → AI学习 → AI 服务, enter the Worker endpoint and the app token, then choose 智谱 or Gemini on that device.

Never place provider keys or app tokens in source files, `wrangler.toml`, browser settings exports, or Git.

For Zhipu, Sentence and Article generation use `AI_MODEL`; `lookup_word` uses `AI_LOOKUP_MODEL`, falling back to `AI_MODEL`; Article translation uses `AI_TRANSLATION_MODEL`, then `AI_LOOKUP_MODEL`, then `AI_MODEL`. Gemini uses `GEMINI_MODEL` for every text task. The browser sends only the allowlisted provider name and can never supply a model or provider API key. Missing or invalid provider values safely use Zhipu for compatibility with older clients; a failed request never falls back to another provider.

## Pronunciation interface

The Worker also reserves a provider-neutral `POST /pronounce` interface:

```json
{
  "text": "improves",
  "locale": "en-US",
  "speaker": "asteria"
}
```

It uses the same Bearer app token and origin checks as `/ai`. The provider-neutral `synthesize({ text, locale, speaker })` adapter calls Cloudflare Workers AI Aura-1 (`@cf/deepgram/aura-1`) with MP3 encoding and a fixed speaker allowlist: `asteria`, `orion`, or `luna`. Missing or unsupported speakers safely use `asteria`, so older clients remain compatible. The raw audio response is returned directly as `audio/mpeg`; no base64 audio object is used. If the Workers AI binding is unavailable, the endpoint returns `503 PRONUNCIATION_UNAVAILABLE`; provider failures return a safe `502 PRONUNCIATION_PROVIDER_ERROR` response.

# FlashDesk AI Worker

This Worker is separate from the TTS Worker and keeps provider credentials off the client.

1. Log in to Cloudflare with Wrangler.
2. Copy `wrangler.toml.example` to `wrangler.toml` and configure `AI_PROVIDER` and `AI_MODEL`. Optionally set `AI_LOOKUP_MODEL` for word lookup and `AI_TRANSLATION_MODEL` for Article translation. Keep the `[ai]` binding so pronunciation can call Workers AI through `env.AI`.
3. Add `ZHIPU_API_KEY` with `wrangler secret put ZHIPU_API_KEY`.
4. Add the app access token with `wrangler secret put FLASHDESK_AI_TOKEN`.
5. Deploy with Wrangler.
6. In FlashDesk → AI学习 → AI 服务, enter the Worker endpoint and the app token.

Never place provider keys or app tokens in source files, `wrangler.toml`, browser settings exports, or Git.

Sentence and Article generation use `AI_MODEL`. `lookup_word` uses `AI_LOOKUP_MODEL`, falling back to `AI_MODEL` when needed. Article translation uses `AI_TRANSLATION_MODEL`, then falls back to `AI_LOOKUP_MODEL`, then `AI_MODEL`. Model selection remains inside the Worker and cannot be overridden by the browser.

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

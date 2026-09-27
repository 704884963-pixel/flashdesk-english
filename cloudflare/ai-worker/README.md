# FlashDesk AI Worker

This Worker is separate from the TTS Worker and keeps provider credentials off the client.

1. Log in to Cloudflare with Wrangler.
2. Copy `wrangler.toml.example` to `wrangler.toml` and configure `AI_PROVIDER` and `AI_MODEL`. Optionally set `AI_LOOKUP_MODEL` to a faster compatible model; when omitted, word lookup uses `AI_MODEL`.
3. Add `ZHIPU_API_KEY` with `wrangler secret put ZHIPU_API_KEY`.
4. Add the app access token with `wrangler secret put FLASHDESK_AI_TOKEN`.
5. Deploy with Wrangler.
6. In FlashDesk → AI学习 → AI 服务, enter the Worker endpoint and the app token.

Never place provider keys or app tokens in source files, `wrangler.toml`, browser settings exports, or Git.

## Pronunciation interface

The Worker also reserves a provider-neutral `POST /pronounce` interface:

```json
{
  "text": "improves",
  "locale": "en-US"
}
```

It uses the same Bearer app token and origin checks as `/ai`. A future pronunciation adapter must return audio through the internal `synthesize({ text, locale })` contract. No pronunciation provider is configured yet, so the production endpoint deliberately returns `503 PRONUNCIATION_UNAVAILABLE` instead of generating placeholder audio.

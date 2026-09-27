# FlashDesk TTS Worker

This Worker keeps the ElevenLabs API key and the personal FlashDesk access token out of the public PWA. It exposes only `POST /tts` (plus the CORS preflight `OPTIONS /tts`) and accepts at most 500 characters per request.

## Local setup

From this directory:

```powershell
npm install
npx wrangler login
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ELEVENLABS_VOICE_ID
npx wrangler secret put FLASHDESK_TTS_TOKEN
```

Do not paste any of these values into source files, Git, or Codex chat. Wrangler stores deployed secrets encrypted in Cloudflare.

To generate a strong personal access token locally:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Paste that value into `npx wrangler secret put FLASHDESK_TTS_TOKEN`, then enter the same value once in FlashDesk's **语音设置** panel on your phone.

## Voice ID

In ElevenLabs, open **Voices**, select a comfortable American English voice, and copy its Voice ID. Store it with `npx wrangler secret put ELEVENLABS_VOICE_ID`. Changing this secret changes the Worker voice without rebuilding FlashDesk.

## Run and deploy

```powershell
npx wrangler dev
npx wrangler deploy
```

The current production endpoint is `https://flashdesk-tts.flashdesk704884963.workers.dev`. Enter that root URL and your personal access token in FlashDesk. The Worker allows the production GitHub Pages origin and `http://localhost:5902`; `FLASHDESK_ALLOWED_ORIGIN` can optionally contain additional comma-separated origins.

The Worker calls ElevenLabs' synchronous text-to-speech endpoint with model `eleven_flash_v2_5` and output format `mp3_44100_128`.

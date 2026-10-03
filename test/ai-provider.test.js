const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const Ai = require('../public/ai-learning.js');
const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const backupSource = fs.readFileSync(path.join(root, 'public/backup.js'), 'utf8');
const wrangler = fs.readFileSync(path.join(root, 'cloudflare/ai-worker/wrangler.toml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'cloudflare/ai-worker/README.md'), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('AI provider device setting defaults to Zhipu', () => {
  assert.equal(Ai.AI_PROVIDER_KEY, 'flashdesk-ai-provider');
  assert.equal(Ai.DEFAULT_AI_PROVIDER, 'zhipu');
  assert.equal(Ai.loadAiProvider(memoryStorage()), 'zhipu');
});

test('AI provider setting accepts only Zhipu and Gemini', () => {
  assert.deepEqual(Ai.AI_PROVIDERS, ['zhipu', 'gemini']);
  assert.equal(Ai.normalizeAiProvider('zhipu'), 'zhipu');
  assert.equal(Ai.normalizeAiProvider('gemini'), 'gemini');
  assert.equal(Ai.normalizeAiProvider('arbitrary'), 'zhipu');
});

test('AI provider selection persists immediately and survives a reload', () => {
  const storage = memoryStorage();
  assert.equal(Ai.saveAiProvider(storage, 'gemini'), 'gemini');
  assert.equal(storage.getItem('flashdesk-ai-provider'), 'gemini');
  assert.equal(Ai.loadAiProvider(storage), 'gemini');
});

test('invalid persisted provider safely falls back to Zhipu', () => {
  assert.equal(Ai.loadAiProvider(memoryStorage({ 'flashdesk-ai-provider': 'bad-provider' })), 'zhipu');
});

test('provider is added to the shared request without changing the task schema', () => {
  const request = Ai.buildAiRequest('generate_sentences', { targetWords: [] }, { count: 1 });
  assert.deepEqual(Ai.withAiProvider(request, 'gemini'), { ...request, provider: 'gemini' });
  assert.equal(Ai.withAiProvider(request, 'invalid').provider, 'zhipu');
});

test('AI service settings show one provider selector with Chinese labels and no model selector', () => {
  const html = appSource.slice(appSource.indexOf('function aiSettingsHtml'), appSource.indexOf('function aiServiceStatusHtml'));
  assert.match(html, /id="ai-provider"/);
  assert.match(html, /value="zhipu"[^>]*>智谱/);
  assert.match(html, /value="gemini"[^>]*>Gemini/);
  assert.doesNotMatch(html, /id="ai-model"/);
});

test('provider change immediately writes the independent device setting', () => {
  const handler = appSource.slice(appSource.indexOf("$('#ai-root').addEventListener('change'"), appSource.indexOf("$('#ai-root').addEventListener('click'"));
  assert.match(handler, /e\.target\.id === 'ai-provider'/);
  assert.match(handler, /FlashAiLearning\.saveAiProvider\(localStorage, e\.target\.value\)/);
  assert.doesNotMatch(handler, /FlashStore|cards|history/);
});

test('every shared AI POST is decorated with the selected provider', () => {
  const fetcher = appSource.slice(appSource.indexOf('async function aiFetch'), appSource.indexOf('let currentAiPronunciationAudio'));
  assert.match(fetcher, /path === '\/ai'/);
  assert.match(fetcher, /FlashAiLearning\.withAiProvider\(request, aiProvider\)/);
});

test('connection test asks the same Worker about the selected provider', () => {
  assert.match(appSource, /aiFetch\(`\/health\?provider=\$\{encodeURIComponent\(aiProvider\)\}`\)/);
  assert.match(appSource, /result\.provider === 'gemini' \? 'Gemini' : '智谱'/);
});

test('AI settings remain a one-column mobile grid without horizontal scrolling', () => {
  const mobile = stylesSource.slice(stylesSource.indexOf('@media (max-width: 560px)'));
  assert.match(mobile, /\.ai-settings-grid[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(mobile, /\.ai-settings-grid[^}]*overflow-x:\s*auto/);
});

test('Gemini API key is Worker-only and device provider is excluded from backup data', () => {
  for (const file of ['public/app.js', 'public/ai-learning.js', 'public/backup.js', 'pwa/store-local.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /GEMINI_API_KEY/);
  }
  assert.doesNotMatch(backupSource, /flashdesk-ai-provider/);
  assert.match(readme, /npx wrangler secret put GEMINI_API_KEY/);
  assert.doesNotMatch(wrangler, /GEMINI_API_KEY\s*=/);
});

test('Worker configuration exposes only the non-secret Gemini model setting', () => {
  assert.match(wrangler, /GEMINI_MODEL\s*=\s*"gemini-3\.8-flash"/);
  assert.doesNotMatch(wrangler, /gemini-test-only|AIza[\w-]+/);
});

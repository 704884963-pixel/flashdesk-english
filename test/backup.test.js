const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Backup = require('../public/backup.js');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

const card = { id: 'c1', deck: 'Words', wordNumber: 1, front: 'word', back: '词', memoryReading: 'w + ord', chineseReading: '沃德', forms: ['words'], due: 10, streak: 2, reviewStep: 1, lapses: 1, created: 1 };
const article = { id: 'a1', title: 'Title', content: 'English.', paragraphTranslations: ['中文。'], source: '', sourceUrl: '', publishedAt: '', progressSentenceIndex: 1, progressPercent: 50, createdAt: 1, updatedAt: 2, lastReadAt: 2 };
const source = {
  learning: { cards: [card], history: [{ date: '2026-09-30', reviewed: 1 }], meta: { nextWordNumber: 2 } },
  articles: { articles: [article], unknownWords: [' WORD '] },
  aiLearning: { generations: [{ type: 'sentences', targetWords: ['word'], primary: 'word', createdAt: '2026-09-30T00:00:00.000Z' }] },
  usageStats: { version: 1, days: { '2026-09-30': { activeSeconds: 360, sessionCount: 2, areas: { review: 300, words: 60, aiLearning: 0, reading: 0, other: 0 } } } },
};

test('full backup has a versioned format and ISO export time', () => {
  const result = Backup.create({ ...source, exportedAt: '2026-09-30T01:02:03.000Z' });
  assert.equal(result.format, 'flashdesk-backup'); assert.equal(result.version, 1);
  assert.equal(result.exportedAt, '2026-09-30T01:02:03.000Z');
});
test('full backup preserves cards, review progress, history and meta', () => {
  const result = Backup.create(source);
  assert.deepEqual(result.learning.cards[0], card);
  assert.deepEqual(result.learning.history, source.learning.history);
  assert.equal(result.learning.meta.nextWordNumber, 2);
});
test('legacy cards without reviewStep remain valid', () => {
  const legacy = structuredClone(source); delete legacy.learning.cards[0].reviewStep;
  assert.equal('reviewStep' in Backup.create(legacy).learning.cards[0], false);
});
test('full backup preserves Articles, translations, progress and unknownWords', () => {
  const result = Backup.create(source);
  assert.deepEqual(result.articles.articles[0], article);
  assert.deepEqual(result.articles.unknownWords, ['word']);
});
test('full backup preserves only persistent AI generation history', () => {
  const result = Backup.create(source);
  assert.deepEqual(result.aiLearning, source.aiLearning);
});
test('full backup includes independent effective-learning usage stats', () => {
  assert.deepEqual(Backup.create(source).usageStats, source.usageStats);
});
test('legacy version 1 backup without usageStats restores with empty stats', () => {
  const current = Backup.create(source); delete current.usageStats;
  assert.deepEqual(Backup.validate(current).usageStats, { version: 1, days: {} });
});
test('backup rejects usage areas that exceed active time', () => {
  const invalid = structuredClone(source); invalid.usageStats.days['2026-09-30'].areas.words = 100;
  assert.throws(() => Backup.create(invalid), /超过总时间/);
});
test('backup validation rejects invalid JSON, format and version', () => {
  assert.throws(() => Backup.parse('{'), /JSON/);
  assert.throws(() => Backup.parse(JSON.stringify({ ...Backup.create(source), format: 'other' })), /FlashDesk/);
  assert.throws(() => Backup.parse(JSON.stringify({ ...Backup.create(source), version: 2 })), /版本/);
});
test('backup validation rejects malformed cards and Articles before any restore', () => {
  assert.throws(() => Backup.create({ ...source, learning: { cards: [{}], history: [] } }), /卡片/);
  assert.throws(() => Backup.create({ ...source, articles: { articles: [{}], unknownWords: [] } }), /文章/);
});
test('backup summary counts Words, Articles, history and due cards', () => {
  const backup = Backup.create(source);
  assert.deepEqual(Backup.summary(backup, 10), { words: 1, cards: 1, articles: 1, history: 1, due: 1, exportedAt: backup.exportedAt });
});
test('backup schema cannot contain settings or secrets from unrelated storage', () => {
  const text = JSON.stringify(Backup.create(source));
  for (const forbidden of ['flashdesk-ai-settings', 'flashdesk-ai-provider', 'FLASHDESK_AI_TOKEN', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'Authorization', 'audio-cache']) assert.doesNotMatch(text, new RegExp(forbidden));
});
test('Data Backup is a More-menu view with export, file selection and confirmation', () => {
  assert.match(html, /data-view="backup"/); assert.match(html, /id="backup-export"/);
  assert.match(html, /id="backup-file"[^>]*type="file"/); assert.match(html, /id="backup-confirm"[^>]*hidden/);
});
test('selecting a backup only parses and previews it', () => {
  const section = app.slice(app.indexOf("$('#backup-file').addEventListener"), app.indexOf("$('#backup-cancel').addEventListener"));
  assert.match(section, /FlashBackup\.parse/); assert.match(section, /state\.backup\.pending/);
  assert.doesNotMatch(section, /replaceSnapshot|location\.reload/);
});
test('cancelled restore clears pending data without writing stores', () => {
  const section = app.slice(app.indexOf("$('#backup-cancel').addEventListener"), app.indexOf("$('#backup-restore').addEventListener"));
  assert.match(section, /pending = null/); assert.doesNotMatch(section, /replaceSnapshot/);
});
test('confirmed restore replaces all four persistent domains and reloads', () => {
  const section = app.slice(app.indexOf('async function restoreFullBackup'), app.indexOf('function renderBackupView'));
  assert.match(section, /FlashStore\.replaceSnapshot/); assert.match(section, /ArticleStore\.replaceSnapshot/); assert.match(section, /setAiHistorySnapshot/);
  assert.match(section, /usageTracker\.replaceStats\(backup\.usageStats\)/);
  assert.match(app, /恢复成功[\s\S]*location\.reload/);
});
test('failed cross-store restore attempts rollback of learning, Articles, AI history and usage', () => {
  const section = app.slice(app.indexOf('async function restoreFullBackup'), app.indexOf('function renderBackupView'));
  assert.ok((section.match(/FlashStore\.replaceSnapshot/g) || []).length >= 2);
  assert.ok((section.match(/ArticleStore\.replaceSnapshot/g) || []).length >= 2);
  assert.match(section, /previousAiRaw/);
  assert.match(section, /usageTracker\.replaceStats\(current\.usageStats\)/);
});
test('old Browse-only data panel is no longer exposed as the full backup UI', () => {
  const views = app.slice(app.indexOf('function switchView'), app.indexOf('/* ---------- events'));
  assert.doesNotMatch(views, /data-panel/);
});

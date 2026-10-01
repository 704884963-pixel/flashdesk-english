// FlashDesk full-backup format. This module is intentionally storage-agnostic:
// app.js coordinates the learning adapter, ArticleStore, and the small AI
// learning history stored in localStorage.

((global) => {
  const FORMAT = 'flashdesk-backup';
  const VERSION = 1;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());

  function normalizeLearning(value) {
    if (!object(value) || !Array.isArray(value.cards) || !Array.isArray(value.history)) {
      throw new Error('学习数据格式无效');
    }
    const cards = value.cards.map((card) => {
      if (!object(card) || !nonempty(card.front) || !nonempty(card.back) || !nonempty(card.deck)) {
        throw new Error('卡片核心字段无效');
      }
      for (const field of ['due', 'streak', 'lapses', 'created']) {
        if (card[field] !== undefined && !Number.isFinite(card[field])) throw new Error(`卡片 ${field} 无效`);
      }
      if (card.reviewStep !== undefined && (!Number.isInteger(card.reviewStep) || card.reviewStep < 0)) {
        throw new Error('卡片 reviewStep 无效');
      }
      if (card.forms !== undefined && (!Array.isArray(card.forms) || card.forms.some((item) => typeof item !== 'string'))) {
        throw new Error('卡片 forms 无效');
      }
      return clone(card);
    });
    return {
      ...(Number.isSafeInteger(value.schemaVersion) ? { schemaVersion: value.schemaVersion } : {}),
      cards,
      history: clone(value.history),
      meta: object(value.meta) ? clone(value.meta) : {},
    };
  }

  function normalizeArticles(value) {
    if (!object(value) || !Array.isArray(value.articles) || !Array.isArray(value.unknownWords)) {
      throw new Error('阅读数据格式无效');
    }
    const articles = value.articles.map((article) => {
      if (!object(article) || !nonempty(article.id) || !nonempty(article.title) || !nonempty(article.content)) {
        throw new Error('文章核心字段无效');
      }
      if (article.paragraphTranslations !== undefined
          && (!Array.isArray(article.paragraphTranslations)
            || article.paragraphTranslations.some((item) => typeof item !== 'string'))) {
        throw new Error('文章段落翻译无效');
      }
      return clone(article);
    });
    return {
      articles,
      unknownWords: [...new Set(value.unknownWords.map((word) => String(word || '').trim().toLowerCase()).filter(Boolean))],
    };
  }

  function normalizeAiLearning(value) {
    if (!object(value) || !Array.isArray(value.generations)) throw new Error('AI 学习历史格式无效');
    return {
      generations: value.generations.map((entry) => {
        if (!object(entry) || typeof entry.type !== 'string' || !Array.isArray(entry.targetWords)) {
          throw new Error('AI 学习历史条目无效');
        }
        return {
          type: entry.type,
          targetWords: entry.targetWords.map((word) => String(word || '').trim()).filter(Boolean),
          ...(typeof entry.primary === 'string' && entry.primary.trim() ? { primary: entry.primary.trim() } : {}),
          ...(typeof entry.createdAt === 'string' && entry.createdAt.trim() ? { createdAt: entry.createdAt } : {}),
        };
      }),
    };
  }

  function normalizeUsageStats(value) {
    if (value === undefined) return { version: 1, days: {} };
    if (!object(value) || value.version !== 1 || !object(value.days)) throw new Error('学习统计格式无效');
    const areas = ['review', 'words', 'aiLearning', 'reading', 'other'];
    const days = {};
    for (const [date, source] of Object.entries(value.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !object(source)
          || !Number.isFinite(source.activeSeconds) || source.activeSeconds < 0
          || !Number.isSafeInteger(source.sessionCount) || source.sessionCount < 0
          || !object(source.areas)) throw new Error('学习统计日期数据无效');
      const normalizedAreas = {};
      let areaTotal = 0;
      for (const area of areas) {
        const seconds = source.areas[area] === undefined ? 0 : source.areas[area];
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('学习统计模块时间无效');
        normalizedAreas[area] = seconds;
        areaTotal += seconds;
      }
      if (areaTotal > source.activeSeconds + 0.001) throw new Error('学习统计模块时间超过总时间');
      days[date] = { activeSeconds: source.activeSeconds, sessionCount: source.sessionCount, areas: normalizedAreas };
    }
    return { version: 1, days };
  }

  function validate(value) {
    if (!object(value)) throw new Error('备份 JSON 格式无效');
    if (value.format !== FORMAT) throw new Error('不是 FlashDesk 完整备份');
    if (value.version !== VERSION) throw new Error('不支持此备份版本');
    if (!nonempty(value.exportedAt) || Number.isNaN(Date.parse(value.exportedAt))) throw new Error('备份时间无效');
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: value.exportedAt,
      learning: normalizeLearning(value.learning),
      articles: normalizeArticles(value.articles),
      aiLearning: normalizeAiLearning(value.aiLearning),
      usageStats: normalizeUsageStats(value.usageStats),
    };
  }

  function create({ learning, articles, aiLearning, usageStats, exportedAt = new Date().toISOString() }) {
    return validate({ format: FORMAT, version: VERSION, exportedAt, learning, articles, aiLearning, usageStats });
  }

  function parse(text) {
    let value;
    try { value = JSON.parse(String(text || '')); } catch { throw new Error('备份文件不是有效 JSON'); }
    return validate(value);
  }

  function summary(backup, now = Date.now()) {
    const value = validate(backup);
    const words = value.learning.cards.filter((card) => card.deck === 'Words').length;
    const due = value.learning.cards.filter((card) => Number(card.due) <= now).length;
    return {
      words,
      cards: value.learning.cards.length,
      articles: value.articles.articles.length,
      history: value.learning.history.length,
      due,
      exportedAt: value.exportedAt,
    };
  }

  const api = {
    FORMAT, VERSION, create, parse, validate, summary,
    normalizeLearning, normalizeArticles, normalizeAiLearning, normalizeUsageStats,
  };
  global.FlashBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

// Pure normalization helpers for the user-owned song learning library.
// Songs are content data, never Review cards, and never fetch lyrics online.

((global) => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (value) => String(value ?? '').trim();

  function normalizeExplanation(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const naturalChinese = text(value);
      return naturalChinese ? { naturalChinese, keyExpressions: [], structure: '' } : null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const naturalChinese = text(value.naturalChinese);
    const structure = text(value.structure);
    const keyExpressions = (Array.isArray(value.keyExpressions) ? value.keyExpressions : [])
      .map((item) => text(item)).filter(Boolean).slice(0, 8);
    if (!naturalChinese && !structure && !keyExpressions.length) return null;
    return { naturalChinese, keyExpressions: [...new Set(keyExpressions)], structure };
  }

  function normalizeLine(value, index = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('歌词行格式无效');
    const english = text(value.english);
    if (!english) throw new Error('英文歌词不能为空');
    return {
      id: text(value.id) || `line_${index + 1}`,
      english,
      originalChinese: text(value.originalChinese),
      aiExplanation: normalizeExplanation(value.aiExplanation),
      learned: value.learned === true,
    };
  }

  function normalizeSong(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('歌曲格式无效');
    const id = text(value.id);
    const title = text(value.title);
    if (!id || !title) throw new Error('歌曲 ID 和歌名不能为空');
    const lines = (Array.isArray(value.lines) ? value.lines : []).map(normalizeLine);
    if (!lines.length) throw new Error('歌曲至少需要一行英文歌词');
    const ids = new Set();
    for (const line of lines) {
      if (ids.has(line.id)) throw new Error('歌曲包含重复歌词行 ID');
      ids.add(line.id);
    }
    const createdAt = Number(value.createdAt);
    const updatedAt = Number(value.updatedAt);
    const lastStudiedAt = value.lastStudiedAt == null ? null : Number(value.lastStudiedAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)
        || (lastStudiedAt !== null && !Number.isFinite(lastStudiedAt))) throw new Error('歌曲时间字段无效');
    return {
      id, title, artist: text(value.artist), createdAt, updatedAt, lastStudiedAt,
      lines,
    };
  }

  function createSong(fields, now = Date.now(), id = `song_${now}_${Math.random().toString(16).slice(2, 8)}`) {
    return normalizeSong({
      id, title: fields?.title, artist: fields?.artist,
      createdAt: now, updatedAt: now, lastStudiedAt: now,
      lines: fields?.lines,
    });
  }

  function normalizeOrganizedLyrics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 歌词整理结果无效');
    const lines = (Array.isArray(value.lines) ? value.lines : []).map((line, index) => ({
      id: `line_${index + 1}`,
      english: text(line?.english),
      originalChinese: text(line?.originalChinese),
      aiExplanation: null,
      learned: false,
    })).filter((line) => line.english);
    if (!lines.length) throw new Error('没有识别到英文歌词');
    return {
      title: text(value.title) || '未命名歌曲',
      artist: text(value.artist),
      lines,
      ignored: (Array.isArray(value.ignored) ? value.ignored : []).map(text).filter(Boolean),
      warnings: (Array.isArray(value.warnings) ? value.warnings : []).map(text).filter(Boolean),
    };
  }

  const learnedCount = (song) => (song?.lines || []).filter((line) => line.learned === true).length;

  const api = { normalizeExplanation, normalizeLine, normalizeSong, createSong, normalizeOrganizedLyrics, learnedCount, clone };
  global.FlashSongLearning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

export const TASKS = new Set(['generate_sentences', 'generate_article', 'lookup_word']);

export function stripJsonFence(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('```')) return text;
  const lines = text.split(/\r?\n/);
  if (!/^```(?:json)?\s*$/i.test(lines[0]) || !/^```\s*$/.test(lines.at(-1))) return text;
  return lines.slice(1, -1).join('\n').trim();
}

const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const words = (value) => Array.isArray(value) && value.every(nonempty);

export function validateAiData(task, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid AI output');
  if (task === 'lookup_word') {
    const fields = ['word', 'baseForm', 'meaningZh', 'meaningInContextZh', 'memoryReading', 'chineseReading'];
    if (fields.some((field) => typeof data[field] !== 'string') || !nonempty(data.word) || !nonempty(data.meaningZh)) throw new Error('invalid word lookup');
    return Object.fromEntries(fields.map((field) => [field, data[field].trim()]));
  }
  if (task === 'generate_sentences') {
    if (!Array.isArray(data.sentences) || data.sentences.length !== 1) throw new Error('invalid sentences');
    const sentences = data.sentences.map((item) => {
      if (!nonempty(item?.english) || !nonempty(item?.referenceChinese) || !words(item?.targetWordsUsed)) throw new Error('invalid sentence');
      return { english: item.english.trim(), referenceChinese: item.referenceChinese.trim(), targetWordsUsed: item.targetWordsUsed.map((w) => w.trim()) };
    });
    return { sentences };
  }
  if (!nonempty(data.title) || !nonempty(data.content) || !words(data.targetWordsUsed)) throw new Error('invalid article');
  const wordCount = (data.content.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  if (wordCount < 200 || wordCount > 300) throw new Error('invalid article length');
  return { title: data.title.trim(), content: data.content.trim(), targetWordsUsed: data.targetWordsUsed.map((w) => w.trim()) };
}

export function parseAiOutput(task, content) {
  let parsed;
  try { parsed = JSON.parse(stripJsonFence(content)); } catch { throw new Error('invalid JSON'); }
  return validateAiData(task, parsed);
}

export function validateClientRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !TASKS.has(body.task)) throw new Error('invalid task');
  const forbidden = new Set(['systemPrompt', 'provider', 'model', 'baseUrl', 'apiKey']);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error('forbidden field');
      visit(child);
    }
  };
  visit(body);
  if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) throw new Error('invalid context');
  if (body.task === 'lookup_word') {
    if (!nonempty(body.context.word) || !nonempty(body.context.sentence)) throw new Error('invalid lookup context');
    return { task: body.task, context: { word: body.context.word.trim(), sentence: body.context.sentence.trim() }, options: {} };
  }
  if (!Array.isArray(body.context.targetWords)) throw new Error('invalid context');
  return { task: body.task, context: body.context, options: body.options && typeof body.options === 'object' ? body.options : {} };
}

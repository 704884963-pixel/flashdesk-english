export const TASKS = new Set(['generate_sentences', 'generate_article', 'translate_article', 'lookup_word']);

export function stripJsonFence(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('```')) return text;
  const lines = text.split(/\r?\n/);
  if (!/^```(?:json)?\s*$/i.test(lines[0]) || !/^```\s*$/.test(lines.at(-1))) return text;
  return lines.slice(1, -1).join('\n').trim();
}

const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const words = (value) => Array.isArray(value) && value.every(nonempty);
export const englishWordCount = (value) => (String(value || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;

// Paragraph splitting must match the front end exactly (FlashArticleUtils
// .splitParagraphs): a blank line separates paragraphs, and single newlines
// inside a paragraph collapse to a space. Alignment is checked against this
// count so a translation can never silently drift onto the wrong paragraph.
export const englishParagraphCount = (value) => String(value ?? '')
  .replace(/\r\n?/g, '\n').trim()
  .split(/\n[\t ]*\n+/)
  .map((paragraph) => paragraph.trim().replace(/\n+/g, ' '))
  .filter(Boolean)
  .length;

export function validateAiData(task, data, context = {}) {
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
  if (task === 'translate_article') {
    if (!nonempty(data.titleZh) || !words(data.paragraphsZh) || !data.paragraphsZh.length) throw new Error('invalid article translation');
    if (Array.isArray(context.paragraphs) && data.paragraphsZh.length !== context.paragraphs.length) {
      throw new Error('article translation paragraphs do not align');
    }
    return { titleZh: data.titleZh.trim(), paragraphsZh: data.paragraphsZh.map((paragraph) => paragraph.trim()) };
  }
  if (!nonempty(data.title) || !nonempty(data.content) || !words(data.targetWordsUsed)) throw new Error('invalid article');
  const wordCount = englishWordCount(data.content);
  if (wordCount < 200 || wordCount > 300) throw new Error('invalid article length');
  const content = data.content.trim();
  // paragraphTranslations is required from the model and must line up one-to-one
  // with the paragraphs the model actually wrote. The front end still treats the
  // field as optional, so older or third-party payloads keep loading.
  if (!words(data.paragraphTranslations) || !data.paragraphTranslations.length) throw new Error('invalid article translations');
  const paragraphTranslations = data.paragraphTranslations.map((paragraph) => paragraph.trim());
  if (paragraphTranslations.length !== englishParagraphCount(content)) throw new Error('article paragraph translations do not align');
  return {
    title: data.title.trim(),
    content,
    targetWordsUsed: data.targetWordsUsed.map((w) => w.trim()),
    paragraphTranslations,
  };
}

export function parseAiOutput(task, content, context = {}) {
  let parsed;
  try { parsed = JSON.parse(stripJsonFence(content)); } catch { throw new Error('invalid JSON'); }
  return validateAiData(task, parsed, context);
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
  if (body.task === 'translate_article') {
    if (!nonempty(body.context.title) || !words(body.context.paragraphs) || !body.context.paragraphs.length) throw new Error('invalid article translation context');
    return { task: body.task, context: { title: body.context.title.trim(), paragraphs: body.context.paragraphs.map((paragraph) => paragraph.trim()) }, options: {} };
  }
  if (!Array.isArray(body.context.targetWords)) throw new Error('invalid context');
  const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? { ...body.options } : {};
  if (options.variant !== undefined) throw new Error('invalid model variant');
  return { task: body.task, context: body.context, options };
}

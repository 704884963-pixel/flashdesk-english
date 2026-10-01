const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');

const nav = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>') + 6);
const menu = html.slice(html.indexOf('<div class="nav-more-menu"'), html.indexOf('</nav>'));

test('primary navigation exposes only Review, Word Library, AI learning and More', () => {
  const beforeMenu = nav.slice(0, nav.indexOf('<div class="nav-more">'));
  assert.deepEqual([...beforeMenu.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]), ['review', 'words', 'ai']);
  assert.match(beforeMenu, />复习<\/button>/);
  assert.match(beforeMenu, />单词库<\/button>/);
  assert.match(beforeMenu, />AI学习<\/button>/);
  assert.match(nav, /id="nav-more-toggle"[\s\S]*?>…<\/button>/);
});

test('low-frequency views no longer stay in the primary navigation row', () => {
  const beforeMenu = nav.slice(0, nav.indexOf('<div class="nav-more">'));
  for (const view of ['reading', 'add', 'quiz', 'browse']) {
    assert.doesNotMatch(beforeMenu, new RegExp(`data-view="${view}"`));
  }
});

test('More menu keeps Reading first, utility views together, then statistics and Data Backup', () => {
  assert.deepEqual([...menu.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]), ['reading', 'add', 'quiz', 'browse', 'usage', 'backup']);
  assert.match(menu, /data-view="reading"[\s\S]*role="separator"[\s\S]*data-view="add"[\s\S]*data-view="browse"[\s\S]*role="separator"[\s\S]*data-view="usage"[\s\S]*data-view="backup"/);
});

test('More toggle and menu use accessible button semantics', () => {
  assert.match(nav, /type="button"[^>]*id="nav-more-toggle"[\s\S]*aria-haspopup="menu"[\s\S]*aria-expanded="false"/);
  assert.match(menu, /role="menu"[^>]*hidden/);
  assert.equal((menu.match(/role="menuitem"/g) || []).length, 6);
});

test('view switching closes More and updates primary or More active state', () => {
  const section = app.slice(app.indexOf('const MORE_VIEWS'), app.indexOf('/* ---------- events'));
  assert.match(section, /MORE_VIEWS = new Set\(\['reading', 'add', 'quiz', 'browse', 'usage', 'backup'\]\)/);
  assert.match(section, /setMoreMenuOpen\(false\)/);
  assert.match(section, /more\.classList\.toggle\('btn-active', MORE_VIEWS\.has\(name\)\)/);
  assert.match(section, /aria-current/);
});

test('More closes from outside click and Escape', () => {
  const events = app.slice(app.indexOf('function bindEvents()'));
  assert.match(events, /if \(!e\.target\.closest\('\.nav-more'\)\) setMoreMenuOpen\(false\)/);
  assert.match(events, /if \(e\.key !== 'Escape'\) return;[\s\S]*setMoreMenuOpen\(false\)/);
});

test('deck controls live inside Review and Browse instead of the global navigation', () => {
  assert.doesNotMatch(nav, /deck-filter/);
  const review = html.slice(html.indexOf('<section id="view-review"'), html.indexOf('<section id="view-quiz"'));
  const browse = html.slice(html.indexOf('<section id="view-browse"'));
  assert.match(review, /id="deck-filter"/);
  assert.match(browse, /id="browse-deck-filter"/);
  assert.match(app, /\['#deck-filter', '#browse-deck-filter'\]/);
});

test('all nine views remain reachable through tab buttons', () => {
  assert.deepEqual(new Set([...nav.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1])),
    new Set(['review', 'words', 'ai', 'reading', 'add', 'quiz', 'browse', 'usage', 'backup']));
  assert.match(app, /\['review', 'quiz', 'add', 'words', 'reading', 'ai', 'browse', 'usage', 'backup'\]/);
});

test('Review grade actions keep Again, Remember and Easy order and handlers', () => {
  const render = app.slice(app.indexOf('function renderReview()'), app.indexOf('function setFlipped'));
  assert.ok(render.indexOf('id="grade-again"') < render.indexOf('id="grade-got"'));
  assert.ok(render.indexOf('id="grade-got"') < render.indexOf('id="grade-easy"'));
  assert.match(app, /b\.id === 'grade-again'\) grade\('again'\)/);
  assert.match(app, /b\.id === 'grade-got'\) grade\('got'\)/);
  assert.match(app, /b\.id === 'grade-easy'\) grade\('easy'\)/);
});

test('mobile navigation is one compact non-wrapping grid and the More menu is layered', () => {
  assert.match(css, /\.nav \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.nav-sticky \{[\s\S]*?position: sticky;[\s\S]*?z-index: 30/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.nav \{[^}]*grid-template-columns:[^}]*48px/);
  assert.match(css, /\.nav-more-menu \{[\s\S]*?position: absolute;[\s\S]*?z-index: 40/);
});

test('Review grading keeps distinct danger, primary success and secondary accent styles', () => {
  assert.match(css, /\.btn-again \{[\s\S]*?border-color: var\(--bad\)/);
  assert.match(css, /\.btn-got \{[\s\S]*?background: var\(--good\)/);
  assert.match(css, /\.btn-easy \{[\s\S]*?background: var\(--accent-dim\);[\s\S]*?border-color: var\(--accent\)/);
  assert.match(css, /\.grade-row \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.btn-grade \{[\s\S]*?white-space: nowrap/);
});

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
  assert.match(beforeMenu, />复习<\/span>/);
  assert.match(beforeMenu, />单词库<\/span>/);
  assert.match(beforeMenu, />AI学习<\/span>/);
  assert.match(nav, /id="nav-more-toggle"[\s\S]*?<span class="nav-label">更多<\/span>/);
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

test('mobile navigation is a fixed safe-area bottom bar and the More menu opens above it', () => {
  assert.match(css, /\.nav \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.nav-sticky \{[\s\S]*?position: fixed;[\s\S]*?bottom: 0;[\s\S]*?z-index: 50/);
  assert.match(css, /\.nav-sticky \{[\s\S]*?env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.nav \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.nav-more-menu \{[\s\S]*?position: absolute;[\s\S]*?bottom: calc\(100% \+ 10px\);[\s\S]*?z-index: 60/);
});

test('app shell exposes a dynamic page header and semantic icon-plus-label navigation', () => {
  assert.match(html, /class="app app-shell"/);
  assert.match(html, /class="header page-header"/);
  assert.match(html, /id="page-title"/);
  assert.match(html, /id="page-context"/);
  assert.equal((nav.match(/class="nav-icon"/g) || []).length, 4);
  assert.equal((nav.match(/class="nav-label"/g) || []).length, 4);
  assert.match(app, /const VIEW_META = Object\.freeze/);
  assert.match(app, /updatePageHeader\(name\)/);
});

test('UI 2.0 design tokens define consistent roles, radii and spacing', () => {
  for (const token of ['--bg', '--surface', '--surface-elevated', '--surface-soft', '--text-primary',
    '--text-secondary', '--text-muted', '--accent-soft', '--danger', '--success', '--border-subtle',
    '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--space-1', '--space-8']) {
    assert.match(css, new RegExp(`${token}:`));
  }
});

test('Review grading keeps distinct danger, primary success and secondary accent styles', () => {
  assert.match(css, /\.btn-again \{[\s\S]*?border-color: var\(--bad\)/);
  assert.match(css, /\.btn-got \{[\s\S]*?background: var\(--good\)/);
  assert.match(css, /\.btn-easy \{[\s\S]*?background: var\(--accent-dim\);[\s\S]*?border-color: var\(--accent\)/);
  assert.match(css, /\.grade-row \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.btn-grade \{[\s\S]*?white-space: nowrap/);
});

/* ---------- Mobile history, unified back button & Review step actions ---------- */

const vm = require('node:vm');
const FlashLogic = require('../public/logic.js');
const FlashArticleUtils = require('../public/article-utils.js');
const FlashAiLearning = require('../public/ai-learning.js');
const FlashSongLearning = require('../public/song-learning.js');

function createNavigationHarness({ initialHash = '', confirmResult = true } = {}) {
  const nodes = new Map();
  const bodyClasses = new Set();
  const tabButtons = ['review', 'words', 'ai', 'reading', 'add', 'quiz', 'browse', 'usage', 'backup'].map((view) => {
    const classes = new Set();
    const attrs = new Map();
    return {
      dataset: { view },
      classList: {
        toggle(cls, force) {
          if (force) classes.add(cls);
          else classes.delete(cls);
        },
        contains(cls) { return classes.has(cls); },
      },
      setAttribute(k, v) { attrs.set(k, v); },
      removeAttribute(k) { attrs.delete(k); },
      getAttribute(k) { return attrs.get(k) || null; },
    };
  });

  function makeNode(selector) {
    const classes = new Set();
    const attrs = new Map([['aria-expanded', 'false']]);
    return {
      id: selector.replace(/^#/, ''),
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: selector === '#page-back-bar' || selector === '#nav-more-menu',
      open: false,
      disabled: false,
      dataset: {},
      style: {},
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (classes.has(c)) classes.delete(c); else classes.add(c);
          } else if (force) classes.add(c);
          else classes.delete(c);
        },
        contains(c) { return classes.has(c); },
      },
      setAttribute(k, v) { attrs.set(k, v); },
      removeAttribute(k) { attrs.delete(k); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      querySelectorAll: () => [],
      querySelector: () => makeNode('child'),
      focus() {},
      close() { this.open = false; },
      showModal() { this.open = true; },
      setSelectionRange() {},
    };
  }

  const historyEntries = [{ state: null, url: initialHash || '#review' }];
  let historyIndex = 0;
  let pushCount = 0;
  let replaceCount = 0;
  let backCount = 0;
  let confirmCalls = 0;
  let currentConfirmResult = confirmResult;
  const locationObj = { hash: initialHash, origin: 'http://127.0.0.1:5902', reload() {} };
  const windowListeners = {};

  const historyObj = {
    get state() { return historyEntries[historyIndex]?.state || null; },
    get length() { return historyEntries.length; },
    pushState(stateObj, _title, url) {
      pushCount += 1;
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ state: structuredClone(stateObj), url: String(url || '') });
      historyIndex = historyEntries.length - 1;
      if (url) locationObj.hash = String(url);
    },
    replaceState(stateObj, _title, url) {
      replaceCount += 1;
      historyEntries[historyIndex] = { state: structuredClone(stateObj), url: String(url || '') };
      if (url) locationObj.hash = String(url);
    },
    back() {
      backCount += 1;
      if (historyIndex > 0) {
        historyIndex -= 1;
        const entry = historyEntries[historyIndex];
        locationObj.hash = entry.url || '';
        if (windowListeners.popstate) {
          windowListeners.popstate({ state: structuredClone(entry.state) });
        }
      }
    },
  };

  const now = Date.now();
  const sampleCards = [
    { id: 'w1', deck: 'Words', wordNumber: 1, front: 'neuron', back: '神经元', forms: [], due: now - 1000, streak: 1, lapses: 0, created: now - 5000 },
    { id: 'w2', deck: 'Words', wordNumber: 2, front: 'workflow', back: '工作流', forms: [], due: now - 2000, streak: 0, lapses: 0, created: now - 4000 },
  ];
  const sampleSongs = [
    {
      id: 'song_1',
      title: 'Keep You Warm',
      artist: 'Midnight Echo',
      createdAt: now,
      updatedAt: now,
      lastStudiedAt: now,
      lines: [{ id: 'line_1', english: 'Walk through the quiet streets', originalChinese: '走过安静的街道', aiExplanation: null, learned: false }],
    },
  ];
  const sampleArticles = [
    { id: 'art_1', title: 'Morning Routine', source: 'Daily', sourceUrl: '', publishedAt: '', content: 'First sentence. Second sentence.', createdAt: now, updatedAt: now },
  ];

  const documentObj = {
    body: {
      classList: {
        toggle(c, force) { if (force) bodyClasses.add(c); else bodyClasses.delete(c); },
        contains(c) { return bodyClasses.has(c); },
      },
      appendChild() {},
    },
    querySelector(sel) {
      if (!nodes.has(sel)) nodes.set(sel, makeNode(sel));
      return nodes.get(sel);
    },
    querySelectorAll(sel) {
      if (sel === '.tab[data-view]' || sel === '.tab') return tabButtons;
      return [];
    },
    addEventListener() {},
  };

  const windowObj = {
    history: historyObj,
    location: locationObj,
    document: documentObj,
    confirm() {
      confirmCalls += 1;
      return currentConfirmResult;
    },
    addEventListener(type, fn) { windowListeners[type] = fn; },
  };

  const context = vm.createContext({
    window: windowObj,
    history: historyObj,
    location: locationObj,
    document: documentObj,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    confirm: (...args) => windowObj.confirm(...args),
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 1,
    clearTimeout() {},
    FlashLogic,
    FlashArticleUtils,
    FlashAiLearning,
    FlashSongLearning,
    sampleCards,
    sampleSongs,
    sampleArticles,
  });

  const runnableSource = app.replace(/registerServiceWorker\(\);\s*init\(\);\s*$/, '');
  vm.runInContext(runnableSource, context);
  vm.runInContext(`
    state.cards = sampleCards;
    state.ai.songs = sampleSongs;
    state.articles = sampleArticles;
    const initialRoute = parseRouteFromHash(location.hash);
    applyRouteState({ ...initialRoute, depth: 0 }, { replaceHistory: true });
  `, context);

  return {
    run: (code) => vm.runInContext(code, context),
    nodes,
    tabButtons,
    bodyClasses,
    history: historyObj,
    location: locationObj,
    stats: () => ({
      pushCount,
      replaceCount,
      backCount,
      confirmCalls,
      historyLength: historyEntries.length,
      historyIndex,
      currentHash: locationObj.hash,
    }),
    setConfirmResult(val) { currentConfirmResult = val; },
    triggerPopstate(stateObj, hashStr) {
      if (hashStr !== undefined) locationObj.hash = hashStr;
      handlePopStateInVm(stateObj);
    },
  };

  function handlePopStateInVm(stateObj) {
    context.__popEvent = { state: stateObj };
    vm.runInContext('handlePopState(__popEvent)', context);
  }
}

test('primary tab switching uses replaceState and never accumulates browser history', () => {
  const h = createNavigationHarness();
  const before = h.stats().pushCount;
  h.run("switchView('words');");
  assert.equal(h.stats().currentHash, '#words');
  assert.equal(h.run('state.nav.depth'), 0);
  h.run("switchView('ai');");
  assert.equal(h.stats().currentHash, '#ai');
  assert.equal(h.run('state.nav.depth'), 0);
  h.run("switchView('review');");
  assert.equal(h.stats().currentHash, '#review');
  assert.equal(h.run('state.nav.depth'), 0);
  assert.equal(h.stats().pushCount, before);
  assert.equal(h.stats().historyLength, 1);
});

test('AI Learning -> AI Helper -> Song Learning -> Song Detail pushes 1 history layer per subview and history.back() unwinds each layer', () => {
  const h = createNavigationHarness();
  h.run("switchView('ai');");
  assert.equal(h.stats().currentHash, '#ai');
  assert.equal(h.run('state.nav.depth'), 0);

  // 1. Enter AI English Helper
  h.run("state.ai.mode = 'helper'; renderAiView();");
  assert.equal(h.stats().currentHash, '#ai/helper');
  assert.equal(h.run('state.nav.depth'), 1);
  assert.equal(h.bodyClasses.has('in-subview'), true);

  // 2. Enter Song Learning library
  h.run("state.ai.mode = 'songs'; state.ai.song.mode = 'library'; renderSongLibrary();");
  assert.equal(h.stats().currentHash, '#ai/songs');
  assert.equal(h.run('state.nav.depth'), 2);

  // 3. Enter Song Detail
  h.run("state.ai.song.current = state.ai.songs[0]; state.ai.song.mode = 'detail'; renderSongDetail();");
  assert.equal(h.stats().currentHash, '#ai/songs/song_1');
  assert.equal(h.run('state.nav.depth'), 3);

  // Back 1: Song Detail -> Song Library
  h.history.back();
  assert.equal(h.run('state.view'), 'ai');
  assert.equal(h.run('state.ai.mode'), 'songs');
  assert.equal(h.run('state.ai.song.mode'), 'library');
  assert.equal(h.run('state.nav.depth'), 2);

  // Back 2: Song Library -> AI Helper
  h.history.back();
  assert.equal(h.run('state.view'), 'ai');
  assert.equal(h.run('state.ai.mode'), 'helper');
  assert.equal(h.run('state.nav.depth'), 1);

  // Back 3: AI Helper -> AI Home
  h.history.back();
  assert.equal(h.run('state.view'), 'ai');
  assert.equal(h.run('state.ai.mode'), 'home');
  assert.equal(h.run('state.nav.depth'), 0);
  assert.equal(h.bodyClasses.has('in-subview'), false);
});

test('popstate restores active Bottom Nav, More button state, header and closes More menu', () => {
  const h = createNavigationHarness();
  h.run("switchView('words');");
  h.run("setMoreMenuOpen(true); switchView('usage');");
  assert.equal(h.run('state.view'), 'usage');
  assert.equal(h.nodes.get('#nav-more-toggle').classList.contains('btn-active'), true);
  assert.equal(h.nodes.get('#page-back-bar').hidden, false);
  assert.equal(h.nodes.get('#page-title').textContent, '学习统计');

  // Simulate system edge-swipe back via popstate
  h.run("setMoreMenuOpen(true);");
  h.history.back();
  assert.equal(h.run('state.view'), 'words');
  assert.equal(h.nodes.get('#nav-more-menu').hidden, true);
  assert.equal(h.nodes.get('#nav-more-toggle').classList.contains('btn-active'), false);
  const wordsTab = h.tabButtons.find((b) => b.dataset.view === 'words');
  assert.equal(wordsTab.classList.contains('btn-active'), true);
  assert.equal(h.nodes.get('#page-back-bar').hidden, true);
  assert.equal(h.nodes.get('#page-title').textContent, '单词库');
});

test('in-page back button calls history.back() when in-app history exists, and uses safe fallback when opened via refresh/deep-link', () => {
  // Case 1: With in-app history
  const h1 = createNavigationHarness();
  h1.run("switchView('words'); state.wordLibrary.selectedId = 'w1'; renderWordLibrary();");
  assert.equal(h1.run('state.nav.depth'), 1);
  const backBefore = h1.stats().backCount;
  h1.run("navigateBack({ view: 'words', wordId: null, hash: '#words', primary: true });");
  assert.equal(h1.stats().backCount, backBefore + 1);
  assert.equal(h1.run('state.wordLibrary.selectedId'), null);
  assert.equal(h1.stats().currentHash, '#words');

  // Case 2: Opened directly via deep-link / refresh (#ai/songs/song_1) with depth === 0
  const h2 = createNavigationHarness({ initialHash: '#ai/songs/song_1' });
  assert.equal(h2.run('state.view'), 'ai');
  assert.equal(h2.run('state.ai.mode'), 'songs');
  assert.equal(h2.run('state.ai.song.mode'), 'detail');
  assert.equal(h2.run('state.nav.depth'), 0);

  // Clicking back walks up the fallback hierarchy without calling history.back()
  h2.run('navigateBack();');
  assert.equal(h2.stats().backCount, 0);
  assert.equal(h2.run('state.ai.song.mode'), 'library');
  assert.equal(h2.stats().currentHash, '#ai/songs');

  h2.run('navigateBack();');
  assert.equal(h2.run('state.ai.mode'), 'helper');
  assert.equal(h2.stats().currentHash, '#ai/helper');

  h2.run('navigateBack();');
  assert.equal(h2.run('state.ai.mode'), 'home');
  assert.equal(h2.stats().currentHash, '#ai');

  // Case 3: Refresh with non-existent IDs safely falls back without crashing
  const h3 = createNavigationHarness({ initialHash: '#words/non_existent_id' });
  assert.equal(h3.run('state.view'), 'words');
  assert.equal(h3.run('state.wordLibrary.selectedId'), null);
});

test('dirty input protects against accidental back navigation while ordinary browsing never prompts', () => {
  const h = createNavigationHarness({ confirmResult: false });

  // Ordinary browsing on Word Detail, Song Detail, Reading Reader never prompts
  h.run("switchView('words'); state.wordLibrary.selectedId = 'w1'; renderWordLibrary();");
  h.run('navigateBack();');
  assert.equal(h.stats().confirmCalls, 0);
  assert.equal(h.run('state.wordLibrary.selectedId'), null);

  // Dirty input on AI English Helper blocks navigateBack and popstate when user cancels confirm
  h.run("switchView('ai'); state.ai.mode = 'helper'; renderAiView();");
  h.run("document.querySelector('#ai-helper-query').value = 'unsubmitted question'; state.ai.helperQuery = 'unsubmitted question';");
  assert.equal(h.run('navigateBack();'), false);
  assert.equal(h.stats().confirmCalls, 1);
  assert.equal(h.run('state.ai.mode'), 'helper');

  // Cancelled popstate also keeps the user on AI English Helper and restores history
  h.triggerPopstate({ view: 'ai', aiMode: 'home', hash: '#ai', primary: true, depth: 0 }, '#ai');
  assert.equal(h.stats().confirmCalls, 2);
  assert.equal(h.run('state.ai.mode'), 'helper');
  assert.equal(h.stats().currentHash, '#ai/helper');

  // Once user confirms leaving, navigation proceeds and clears the draft
  h.setConfirmResult(true);
  assert.equal(h.run('navigateBack();'), true);
  assert.equal(h.run('state.ai.mode'), 'home');
  assert.equal(h.run('state.ai.helperQuery'), '');
});

test('all secondary and tertiary pages render the unified .nav-back-btn with >= 48px target height', () => {
  assert.match(html, /id="page-back-bar"[\s\S]*?class="nav-back-btn article-back"[^>]*id="page-back-btn"/);
  assert.match(css, /\.nav-back-btn,[\s\S]*?min-height:\s*48px;[\s\S]*?min-width:\s*88px/);
  for (const fnName of [
    'function wordDetailHtml',
    'function renderAiHelper',
    'function renderSongLibrary',
    'function renderSongImport',
    'function renderSongPreview',
    'function renderSongDetail',
    'function renderAiSentences',
    'function renderAiArticle',
    'function renderArticleAdd',
    'function renderArticleReader',
  ]) {
    const start = app.indexOf(fnName);
    const slice = app.slice(start, start + 2400);
    assert.match(slice, /class="nav-back-btn (?:article-back|word-library-back)"/, `${fnName} must use unified .nav-back-btn`);
    assert.match(slice, /<span class="nav-back-arrow" aria-hidden="true">←<\/span><span>返回<\/span>/, `${fnName} must use unified 返回 label`);
  }
});

test('Review prev/next buttons are relocated below the card with >= 48px height and preserve stepCard behavior', () => {
  const render = app.slice(app.indexOf('function renderReview()'), app.indexOf('function setFlipped'));
  // #card-prev and #card-next are inside .review-step-actions after #card-face, not in top-right corner
  assert.ok(render.indexOf('id="card-face"') < render.indexOf('class="review-step-actions"'));
  assert.ok(render.indexOf('class="review-step-actions"') < render.indexOf('class="speech-actions"'));
  assert.ok(render.indexOf('class="review-step-actions"') < render.indexOf('class="grade-row"'));
  assert.match(render, /id="card-prev"[\s\S]*?上一张/);
  assert.match(render, /id="card-next"[\s\S]*?下一张/);
  assert.match(css, /\.card-arrow,\s*\.card-arrow\.review-nav-btn\s*\{[\s\S]*?position:\s*static;[\s\S]*?min-height:\s*48px/);

  // Verify stepCard(-1) and stepCard(1) behavior is unchanged
  const h = createNavigationHarness();
  assert.equal(h.run('state.session.pos'), 0);
  h.run('stepCard(1);');
  assert.equal(h.run('state.session.pos'), 1);
  h.run('stepCard(-1);');
  assert.equal(h.run('state.session.pos'), 0);
});

test('no custom global swipe-left or Review touch swipe handlers exist', () => {
  assert.doesNotMatch(app, /touchstart|touchmove|touchend|pointerdown|pointermove/);
});

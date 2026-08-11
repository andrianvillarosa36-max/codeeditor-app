/* ============================================================
   app.js — file tree, tabs, and Monaco editor wiring.
   Reads/writes files natively via Capacitor's Filesystem plugin —
   no server, no Termux dependency. Requires the "All files access"
   permission, requested through the custom StoragePermission plugin.
   ============================================================ */

let editor;
const openTabs = {}; // absPath -> { type: 'text'|'image', model?, dataUri?, dirty }
let activeTab = null;
let fontSize = 14;
let wrapOn = false; // nano-style default: lines run off-screen, scroll sideways to read
let autoClosing = false; // reentrancy guard for the auto-close-tag feature
let pasteGuardUntil = 0; // suppress auto-close for a moment after any paste
let suppressNextClick = false; // set true right before a long-press fires, to swallow the trailing click
let formatOnSave = false;
let formatterBusy = false;

let ROOT = '/storage/emulated/0';
const HOME = '/storage/emulated/0';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
function isImage(name) { return IMAGE_EXTS.has(name.split('.').pop().toLowerCase()); }
const IMAGE_FOLDER_NAMES = new Set(['images', 'img', 'imgs', 'assets', 'icons', 'pictures', 'photos']);

function FS() { return Capacitor.Plugins.Filesystem; }
function StoragePermission() { return Capacitor.Plugins.StoragePermission; }
function Clip() { return Capacitor.Plugins.Clipboard; }
function LocalServer() { return Capacitor.Plugins.LocalServer; }

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  registerGDScriptLanguage();
  registerGDScriptFormatter();
  editor = monaco.editor.create(document.getElementById('editor-container'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize,
    minimap: { enabled: window.innerWidth > 700 },
    wordWrap: wrapOn ? 'on' : 'off',
    wrappingIndent: 'none',
    scrollBeyondLastLine: false,
    autoIndent: 'keep',
  });

  // Mobile paste can arrive as a burst of individual character insertions
  // rather than one clean block, which fooled the auto-close-tag feature
  // into firing mid-paste. Suppress it for a moment around any paste.
  editor.onDidPaste(() => { pasteGuardUntil = Date.now() + 1000; });

  editor.onDidChangeModelContent((e) => {
    if (activeTab && openTabs[activeTab] && openTabs[activeTab].type === 'text') {
      openTabs[activeTab].dirty = true;
      renderTabs();
    }
    if (!autoClosing) maybeAutoCloseTag(e);
  });

  // "!" + Tab expands to a full HTML5 boilerplate (Emmet-style), the one
  // specific abbreviation explicitly asked for. A full Emmet abbreviation
  // engine (div.class>ul>li*3 etc.) is a much bigger separate library and
  // isn't included here.
  editor.onKeyDown((e) => {
    // VS Code-style Format Document shortcut: Shift+Alt+F.
    if (e.keyCode === monaco.KeyCode.KeyF && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      formatActiveDocument(false);
      return;
    }
    if (e.keyCode === monaco.KeyCode.Tab && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (tryEmmetExpand()) { e.preventDefault(); e.stopPropagation(); }
    }
  });

  boot();
});

// Void/self-closing HTML elements that never get a closing tag.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function maybeAutoCloseTag(e) {
  if (Date.now() < pasteGuardUntil) return;
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== 'html') return;
  if (e.isFlush) return;

  for (const change of e.changes) {
    if (change.text !== '>' || change.rangeLength !== 0) continue;

    const line = change.range.startLineNumber;
    const gtColumn = change.range.startColumn;
    const preText = model.getLineContent(line).substring(0, gtColumn - 1);

    const match = preText.match(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)$/);
    if (!match) continue;

    const tagName = match[1].toLowerCase();
    const attrs = match[2] || '';
    if (attrs.trim().endsWith('/')) continue;
    if (VOID_ELEMENTS.has(tagName)) continue;

    const insertCol = gtColumn + 1;
    const insertPos = new monaco.Range(line, insertCol, line, insertCol);
    autoClosing = true;
    editor.executeEdits('autoCloseTag', [{ range: insertPos, text: `</${tagName}>`, forceMoveMarkers: true }],
      [new monaco.Selection(line, insertCol, line, insertCol)]);
    autoClosing = false;
  }
}

// Common tags recognized for "tag.class#id" style abbreviations. A bare word
// that isn't in this list won't hijack Tab — e.g. typing a normal word and
// pressing Tab still just indents, it doesn't try to guess you meant a tag.
const EMMET_TAGS = new Set([
  'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'nav', 'header', 'footer', 'section', 'article', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'form', 'input', 'label', 'img', 'table', 'tr', 'td', 'th',
  'thead', 'tbody', 'tfoot', 'select', 'option', 'textarea', 'strong', 'em', 'br', 'hr', 'i', 'b', 'small',
  'figure', 'figcaption', 'video', 'audio', 'iframe', 'svg', 'canvas', 'pre', 'code', 'blockquote', 'dl', 'dt', 'dd',
]);

// Parses a single-element abbreviation: an optional tag name followed by any
// number of .class or #id parts, e.g. "nav.navbar", "div#hero.card.featured",
// ".wrapper" (defaults to div), "img.icon". Returns null if it doesn't look
// like a recognized abbreviation, so Tab falls back to normal indenting.
function parseEmmetToken(token) {
  const m = token.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:[.#][\w-]+)+)?$/);
  if (!m) return null;
  const rawTag = m[1];
  const rest = m[2];
  if (!rawTag && !rest) return null;
  const tag = (rawTag || 'div').toLowerCase();
  if (!EMMET_TAGS.has(tag)) return null;
  const classes = [];
  let id = '';
  if (rest) {
    const partRe = /([.#])([\w-]+)/g;
    let pm;
    while ((pm = partRe.exec(rest)) !== null) {
      if (pm[1] === '.') classes.push(pm[2]);
      else id = pm[2];
    }
  }
  return { tag, id, classes };
}

// "!" on its own line, then Tab -> full HTML5 boilerplate, cursor inside <body>.
// Otherwise "tag.class#id" style abbreviations expand to that single element,
// cursor placed between the open/close tags (or right after attrs for void
// elements like img/input/br, since those never get a closing tag).
function tryEmmetExpand() {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== 'html') return false;
  const pos = editor.getPosition();
  const lineContent = model.getLineContent(pos.lineNumber);
  const trimmed = lineContent.trim();
  if (trimmed === '') return false;

  if (trimmed === '!') return expandBoilerplate(pos, lineContent);

  const parsed = parseEmmetToken(trimmed);
  if (!parsed) return false;
  return expandSingleTag(pos, lineContent, parsed);
}

function expandBoilerplate(pos, lineContent) {
  const range = new monaco.Range(pos.lineNumber, 1, pos.lineNumber, lineContent.length + 1);
  const snippetLines = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '    <meta charset="UTF-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '    <title>Document</title>',
    '</head>',
    '<body>',
    '    ',
    '</body>',
    '</html>',
  ];
  editor.executeEdits('emmet-boilerplate', [{ range, text: snippetLines.join('\n'), forceMoveMarkers: true }]);
  editor.setPosition({ lineNumber: pos.lineNumber + 8, column: 5 });
  editor.focus();
  return true;
}

function expandSingleTag(pos, lineContent, parsed) {
  const range = new monaco.Range(pos.lineNumber, 1, pos.lineNumber, lineContent.length + 1);
  const indent = (lineContent.match(/^\s*/) || [''])[0];

  const attrParts = [];
  if (parsed.id) attrParts.push(`id="${parsed.id}"`);
  if (parsed.classes.length) attrParts.push(`class="${parsed.classes.join(' ')}"`);
  const attrs = attrParts.length ? ' ' + attrParts.join(' ') : '';

  if (VOID_ELEMENTS.has(parsed.tag)) {
    const openPart = `<${parsed.tag}${attrs}`;
    const text = indent + openPart + ' />';
    editor.executeEdits('emmet-tag', [{ range, text, forceMoveMarkers: true }]);
    editor.setPosition({ lineNumber: pos.lineNumber, column: indent.length + openPart.length + 1 });
  } else {
    const open = `<${parsed.tag}${attrs}>`;
    const close = `</${parsed.tag}>`;
    editor.executeEdits('emmet-tag', [{ range, text: indent + open + close, forceMoveMarkers: true }]);
    editor.setPosition({ lineNumber: pos.lineNumber, column: indent.length + open.length + 1 });
  }
  editor.focus();
  return true;
}

function langFromExt(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', gd: 'gdscript', html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json',
    md: 'markdown', sh: 'shell', bash: 'shell', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
    hpp: 'cpp', go: 'go', rs: 'rust', php: 'php', rb: 'ruby', xml: 'xml',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', txt: 'plaintext', env: 'ini', toml: 'ini',
  };
  return map[ext] || 'plaintext';
}

const ICON_BY_EXT = {
  html: '🟧', htm: '🟧', css: '🟦', scss: '🟦', js: '🟨', jsx: '🟨', ts: '🟦', tsx: '🟦',
  json: '📋', md: '📝', py: '🐍', gd: '🎮',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️',
};
function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ICON_BY_EXT[ext] || '📄';
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
};

// ---------------- Toast (lightweight, non-blocking feedback) ----------------
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast-msg');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

// ---------------- Permission gating ----------------
async function boot() {
  document.getElementById('home-btn').addEventListener('click', () => switchRoot(HOME));
  const { granted } = await StoragePermission().check();
  if (granted) startEditor();
  else showPermissionGate();
}

function switchRoot(newRoot) {
  ROOT = newRoot;
  document.getElementById('root-path').textContent = ROOT;
  document.getElementById('file-tree').scrollTop = 0;
  renderTree(ROOT, document.getElementById('file-tree'));
}

function showPermissionGate() {
  document.getElementById('permission-gate').classList.remove('hidden');
  document.getElementById('grant-btn').addEventListener('click', async () => {
    await StoragePermission().request();
  });
  document.getElementById('continue-btn').addEventListener('click', async () => {
    const { granted } = await StoragePermission().check();
    if (granted) {
      document.getElementById('permission-gate').classList.add('hidden');
      startEditor();
    } else {
      document.getElementById('gate-hint').textContent =
        'Still not granted — flip the toggle for this app in Settings, then come back and tap Continue.';
    }
  });
}

async function startEditor() {
  document.getElementById('root-path').textContent = ROOT;
  await renderTree(ROOT, document.getElementById('file-tree'));
}

// ---------------- Long-press detection (for the Rename/Move/Delete sheet) ----------------
function longPress(el, callback) {
  let timer = null;
  const start = () => { timer = setTimeout(() => { suppressNextClick = true; callback(); }, 550); };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
}

// ---------------- File tree ----------------
async function listDir(absPath) {
  const res = await FS().readdir({ path: absPath });
  return res.files
    .map((f) => ({ name: f.name, isDir: f.type === 'directory' }))
    .filter((f) => !f.name.startsWith('.'))
    .sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
}

function folderIcon(name) {
  return IMAGE_FOLDER_NAMES.has(name.toLowerCase()) ? '🖼️' : '📁';
}

async function renderTree(absPath, container) {
  container.innerHTML = '';
  let entries;
  try { entries = await listDir(absPath); } catch (e) { container.textContent = 'Error: ' + e.message; return; }
  entries.forEach((entry) => {
    const full = `${absPath}/${entry.name}`;
    const item = document.createElement('div');
    item.className = 'tree-item';

    if (entry.isDir) {
      const row = document.createElement('div');
      row.className = 'tree-row';

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = folderIcon(entry.name) + ' ' + entry.name;
      row.appendChild(label);

      const openBtn = document.createElement('button');
      openBtn.className = 'tree-open-btn';
      openBtn.textContent = 'Open';
      openBtn.title = 'Enter this folder as your project root';
      openBtn.addEventListener('click', (e) => { e.stopPropagation(); switchRoot(full); });
      row.appendChild(openBtn);

      item.appendChild(row);

      let expanded = false;
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      childContainer.style.paddingLeft = '14px';
      childContainer.style.display = 'none';
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (suppressNextClick) { suppressNextClick = false; return; }
        expanded = !expanded;
        childContainer.style.display = expanded ? 'block' : 'none';
        if (expanded) renderTree(full, childContainer);
      });
      longPress(label, () => showFileActions(full, entry.name, true));
      container.appendChild(item);
      container.appendChild(childContainer);
    } else {
      item.textContent = iconFor(entry.name) + ' ' + entry.name;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (suppressNextClick) { suppressNextClick = false; return; }
        openFile(full);
      });
      longPress(item, () => showFileActions(full, entry.name, false));
      container.appendChild(item);
    }
  });
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-item';
    empty.style.color = 'var(--text-dim)';
    empty.textContent = '(empty)';
    container.appendChild(empty);
  }
}

// ---------------- Rename / Move / Delete (long-press action sheet) ----------------
function showActionSheet(title, actions) {
  document.getElementById('action-sheet-title').textContent = title;
  const list = document.getElementById('action-sheet-list');
  list.innerHTML = '';
  actions.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'modal-item';
    row.textContent = a.label;
    row.addEventListener('click', () => { closeActionSheet(); a.run(); });
    list.appendChild(row);
  });
  document.getElementById('action-sheet').classList.remove('hidden');
}
function closeActionSheet() { document.getElementById('action-sheet').classList.add('hidden'); }
document.getElementById('action-sheet').addEventListener('click', (e) => {
  if (e.target.id === 'action-sheet') closeActionSheet();
});

function showFileActions(absPath, name, isDir) {
  showActionSheet(name, [
    { label: '✏️  Rename', run: () => renameItem(absPath) },
    { label: '📦  Move to…', run: () => moveItem(absPath) },
    { label: '🗑️  Delete', run: () => deleteItem(absPath, name, isDir) },
  ]);
}

function retagOpenTab(oldPath, newPath) {
  if (!openTabs[oldPath]) return;
  openTabs[newPath] = openTabs[oldPath];
  delete openTabs[oldPath];
  if (activeTab === oldPath) activeTab = newPath;
  renderTabs();
}

async function renameItem(absPath) {
  const oldName = absPath.split('/').pop();
  const newName = prompt('Rename to:', oldName);
  if (!newName || newName === oldName) return;
  const parentDir = absPath.substring(0, absPath.lastIndexOf('/'));
  const newPath = `${parentDir}/${newName}`;
  try {
    await FS().rename({ from: absPath, to: newPath });
    retagOpenTab(absPath, newPath);
    showToast('Renamed');
    renderTree(ROOT, document.getElementById('file-tree'));
  } catch (e) { alert('Rename failed: ' + e.message); }
}

async function moveItem(absPath) {
  const name = absPath.split('/').pop();
  const destDir = prompt(`Move "${name}" into which folder? (path relative to ${ROOT}, blank = ${ROOT} itself)`, '');
  if (destDir === null) return;
  const destAbs = joinPath(ROOT, destDir || '.');
  const newPath = `${destAbs}/${name}`;
  try {
    await FS().mkdir({ path: destAbs, recursive: true }).catch(() => {}); // fine if it already exists
    await FS().rename({ from: absPath, to: newPath });
    retagOpenTab(absPath, newPath);
    showToast('Moved');
    renderTree(ROOT, document.getElementById('file-tree'));
  } catch (e) { alert('Move failed: ' + e.message); }
}

async function deleteItem(absPath, name, isDir) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  try {
    if (isDir) await FS().rmdir({ path: absPath, recursive: true });
    else await FS().deleteFile({ path: absPath });
    if (openTabs[absPath]) closeTab(absPath);
    showToast('Deleted');
    renderTree(ROOT, document.getElementById('file-tree'));
  } catch (e) { alert('Delete failed: ' + e.message); }
}

// ---------------- Open / tabs ----------------
async function openFile(absPath) {
  if (!openTabs[absPath]) {
    if (isImage(absPath)) {
      let dataUri;
      try {
        const ext = absPath.split('.').pop().toLowerCase();
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        const res = await FS().readFile({ path: absPath });
        dataUri = `data:${mime};base64,${res.data}`;
      } catch (e) { alert('Could not open image: ' + e.message); return; }
      openTabs[absPath] = { type: 'image', dataUri, dirty: false };
    } else {
      let content;
      try {
        const res = await FS().readFile({ path: absPath, encoding: 'utf8' });
        content = res.data;
      } catch (e) { alert('Could not open file: ' + e.message); return; }
      const model = monaco.editor.createModel(content, langFromExt(absPath));
      openTabs[absPath] = { type: 'text', model, dirty: false };
    }
  }
  showTab(absPath);
  if (window.innerWidth <= 700) document.getElementById('sidebar').classList.add('collapsed');
}

function showTab(absPath) {
  activeTab = absPath;
  const tab = openTabs[absPath];
  const isImg = tab.type === 'image';
  document.getElementById('editor-container').classList.toggle('hidden', isImg);
  document.getElementById('image-viewer').classList.toggle('hidden', !isImg);
  document.getElementById('empty-state').classList.add('hidden');
  if (isImg) document.getElementById('image-viewer-img').src = tab.dataUri;
  else editor.setModel(tab.model);
  renderBreadcrumb(absPath);
  renderTabs();
}

function switchToTab(p) { showTab(p); }

function closeTab(p) {
  if (openTabs[p].type === 'text') openTabs[p].model.dispose();
  delete openTabs[p];
  if (activeTab === p) {
    const remaining = Object.keys(openTabs);
    activeTab = remaining[0] || null;
    if (activeTab) {
      showTab(activeTab);
    } else {
      document.getElementById('editor-container').classList.remove('hidden');
      document.getElementById('image-viewer').classList.add('hidden');
      editor.setModel(monaco.editor.createModel('', 'plaintext'));
      document.getElementById('empty-state').classList.remove('hidden');
      renderBreadcrumb(null);
    }
  }
  renderTabs();
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  Object.keys(openTabs).forEach((p) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (p === activeTab ? ' active' : '');

    const label = document.createElement('span');
    label.textContent = p.split('/').pop() + (openTabs[p].dirty ? ' ●' : '');
    tab.appendChild(label);

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.className = 'tab-close';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p); });
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => switchToTab(p));
    tabsEl.appendChild(tab);
  });
  renderOpenEditors();
}

function renderOpenEditors() {
  const el = document.getElementById('open-editors-list');
  const section = document.getElementById('open-editors');
  const paths = Object.keys(openTabs);
  if (paths.length === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  el.innerHTML = '';
  paths.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'tree-item open-editor-item' + (p === activeTab ? ' active' : '');
    row.textContent = iconFor(p) + ' ' + p.split('/').pop() + (openTabs[p].dirty ? ' ●' : '');
    row.addEventListener('click', () => switchToTab(p));
    el.appendChild(row);
  });
}

// ---------------- GDScript language + formatter ----------------
// Monaco does not ship a built-in GDScript language/formatter. Register a
// lightweight Godot-aware language definition and an editor formatter so .gd
// files get proper syntax highlighting, indentation, and common spacing fixes.
function registerGDScriptLanguage() {
  if (monaco.languages.getLanguages().some((l) => l.id === 'gdscript')) return;

  monaco.languages.register({ id: 'gdscript', extensions: ['.gd'] });
  monaco.languages.setMonarchTokensProvider('gdscript', {
    defaultToken: '',
    tokenPostfix: '.gd',
    keywords: [
      'and','as','await','break','class','class_name','const','continue','elif','else',
      'enum','extends','for','func','if','in','is','match','not','or','pass','preload',
      'return','signal','static','super','var','while','yield','true','false','null',
    ],
    typeKeywords: [
      'void','bool','int','float','String','Vector2','Vector2i','Vector3','Vector3i',
      'Color','Array','Dictionary','Node','Node2D','Node3D','Object','Callable','Signal',
      'Variant','StringName','Transform2D','Transform3D','Quaternion','Basis','Rect2','Rect2i',
    ],
    operators: [
      '=',':=','+=','-=','*=','/=','%=','==','!=','<=','>=','<','>','+','-','*','/','%','**',
      '&&','||','!','&','|','^','~','<<','>>','=>',
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    tokenizer: {
      root: [
        { include: '@whitespace' },
        [/[A-Z_][A-Za-z0-9_]*/, { cases: { '@typeKeywords': 'type.identifier', '@default': 'identifier' } }],
        [/[a-z_][A-Za-z0-9_]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/\b0[bB][01_]+\b/, 'number.binary'],
        [/\b0[oO][0-7_]+\b/, 'number.octal'],
        [/\b0[xX][0-9a-fA-F_]+\b/, 'number.hex'],
        [/\b\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?\b/, 'number'],
        [/[{}()\[\]]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
        [/[=><!~?:&|+\-*\/\^%]+/, { cases: { '@operators': 'operator', '@default': 'operator' } }],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/"([^"\\]|\\.)*"/, 'string'],
      ],
      whitespace: [
        [/[ \t\r\n]+/, 'white'],
        [/#.*$/, 'comment'],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration('gdscript', {
    comments: { lineComment: '#' },
    brackets: [['[', ']'], ['{', '}'], ['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern: /^\s*(?:func|if|elif|else|for|while|match|class|class_name|enum|signal|static func|const|var).*:\s*(?:#.*)?$/,
      decreaseIndentPattern: /^\s*(?:elif|else|except|finally)\b/,
    },
  });
}

function gdStripStringAndComment(line) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (quote) {
      out += ' ';
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ' '; continue; }
    if (ch === '#' && next !== '#') { out += ' '.repeat(line.length - i); break; }
    out += ch;
  }
  return out;
}

function gdIndentDelta(clean) {
  const trimmed = clean.trim();
  if (!trimmed) return 0;
  if (/^(elif|else|except|finally)\b/.test(trimmed)) return -1;
  if (/^(case)\b/.test(trimmed)) return -1;
  return 0;
}

function gdLineOpensBlock(clean) {
  const trimmed = clean.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  // GDScript blocks are introduced by a trailing colon. Ignore dictionary
  // literals and typed expressions where a colon appears before the end.
  if (!trimmed.endsWith(':')) return false;
  return /\b(func|if|elif|else|for|while|match|class|class_name|enum|signal|static func|try|except|finally)\b/.test(trimmed)
    || /^\s*[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*\s*:\s*$/.test(trimmed)
    || trimmed === 'else:';
}

function gdNormalizeLineContent(content) {
  if (!content.trim() || content.trim().startsWith('#')) return content.trimEnd();
  const indent = (content.match(/^\s*/) || [''])[0];
  let body = content.slice(indent.length).trimEnd();
  const split = gdStripStringAndComment(body);
  const commentIndex = (() => {
    let quote = null, escaped = false;
    for (let i=0;i<body.length;i++) {
      const ch=body[i];
      if (quote) { if (escaped) escaped=false; else if(ch==='\\') escaped=true; else if(ch===quote) quote=null; continue; }
      if (ch==='"'||ch==="'") { quote=ch; continue; }
      if (ch==='#') return i;
    }
    return -1;
  })();
  let code = commentIndex >= 0 ? body.slice(0, commentIndex).trimEnd() : body;
  const comment = commentIndex >= 0 ? body.slice(commentIndex).trimEnd() : '';

  // Conservative spacing fixes that avoid modifying string literals.
  const placeholders = [];
  code = code.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, (m) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(m);
    return token;
  });
  code = code
    .replace(/\s*:=\s*/g, ' := ')
    .replace(/\s*(==|!=|<=|>=|\+=|-=|\*=|\/=|%=|=>|->|\*\*)\s*/g, ' $1 ')
    .replace(/\s*([=<>+\-*/%])\s*/g, ' $1 ')
    .replace(/-\s+>/g, '->')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([),\]])/g, '$1')
    .trim();
  code = code.replace(/\u0000(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);
  return indent + code + (comment ? `  ${comment}` : '');
}

function formatGDScriptText(source, options = {}) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let indent = 0;
  let formatting = true;
  const indentUnit = '\t';
  let bracketDepth = 0;

  for (let raw of lines) {
    const stripped = raw.trim();
    if (stripped === '# fmt: off' || stripped === '#fmt:off') {
      formatting = false;
      out.push(raw.replace(/\s+$/, ''));
      continue;
    }
    if (!formatting) {
      out.push(raw.replace(/\s+$/, ''));
      if (stripped === '# fmt: on' || stripped === '#fmt:on') formatting = true;
      continue;
    }
    if (!stripped) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    const clean = gdStripStringAndComment(raw);
    const dedent = gdIndentDelta(clean);
    indent = Math.max(0, indent + dedent);
    const normalized = gdNormalizeLineContent(raw).trim();

    // Keep continuation lines indented under collection/call expressions.
    const leadingBracketExtra = bracketDepth > 0 ? 1 : 0;
    out.push(indentUnit.repeat(indent + leadingBracketExtra) + normalized);

    const scan = gdStripStringAndComment(normalized);
    const opens = gdLineOpensBlock(scan);
    if (opens) indent++;

    let depth = bracketDepth;
    for (const ch of scan) {
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    }
    bracketDepth = depth;
  }

  while (out.length && out[out.length - 1] === '') out.pop();
  const result = out.join('\n');
  return options.preserveTrailingNewline === false ? result : result + '\n';
}

// Use the same family of formatter as the popular pretty.gd VS Code/Godot
// formatter. It is a real GDScript tokenizer/formatter, not just indentation
// rules. We load the ESM build lazily so the editor still starts if the CDN is
// temporarily unavailable; the local formatter below remains the safe fallback.
let prettyGdPromise = null;
let prettyGdInstance = null;

async function getPrettyGdFormatter() {
  if (!prettyGdPromise) {
    prettyGdPromise = import('https://cdn.jsdelivr.net/npm/pretty-gd-js@1.18.1/+esm')
      .then((mod) => {
        const candidates = [
          mod.prettify,
          mod.format,
          mod.pretty,
          mod.default,
          mod.Prettifier,
          mod.PrettyGd,
        ];
        for (const candidate of candidates) {
          if (!candidate) continue;
          if (typeof candidate === 'object' && typeof candidate.prettify === 'function') {
            prettyGdInstance = candidate;
            return candidate;
          }
          if (typeof candidate === 'function') {
            // Some builds export prettify(source) directly; others export the
            // Prettifier class used by the Godot/VS Code integration.
            try {
              const direct = candidate('');
              if (typeof direct === 'string') {
                prettyGdInstance = { prettify: candidate };
                return prettyGdInstance;
              }
            } catch (_) {}
            try {
              const instance = new candidate();
              if (instance && typeof instance.prettify === 'function') {
                if ('indent_str' in instance) instance.indent_str = '\\t';
                if ('tab_size' in instance) instance.tab_size = 4;
                prettyGdInstance = instance;
                return instance;
              }
            } catch (_) {}
          }
        }
        throw new Error('Unsupported pretty-gd-js export');
      })
      .catch((err) => {
        prettyGdPromise = null;
        throw err;
      });
  }
  return prettyGdPromise;
}

async function formatGDScriptWithPrettyGd(source) {
  try {
    const formatter = await getPrettyGdFormatter();
    const result = await formatter.prettify(source);
    if (typeof result === 'string') return result.endsWith('\\n') ? result : result + '\\n';
  } catch (err) {
    console.warn('pretty-gd-js unavailable; using built-in GDScript formatter:', err);
  }
  return null;
}

function registerGDScriptFormatter() {
  monaco.languages.registerDocumentFormattingEditProvider('gdscript', {
    async provideDocumentFormattingEdits(model) {
      const before = model.getValue();
      const pretty = await formatGDScriptWithPrettyGd(before);
      const after = pretty !== null ? pretty : formatGDScriptText(before);
      if (after === before) return [];
      return [{ range: model.getFullModelRange(), text: after }];
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider('gdscript', {
    async provideDocumentRangeFormattingEdits(model, range) {
      const before = model.getValue();
      const startOffset = model.getOffsetAt(range.getStartPosition());
      const endOffset = model.getOffsetAt(range.getEndPosition());
      const selected = before.slice(startOffset, endOffset);
      const pretty = await formatGDScriptWithPrettyGd(selected);
      const after = pretty !== null ? pretty : formatGDScriptText(selected);
      if (after === selected) return [];
      return [{ range, text: after }];
    },
  });
}

// ---------------- Formatting (Prettier-style, with Monaco fallback) ----------------
// Prettier is loaded in index.html from its browser/UMD build. We deliberately
// keep the formatter optional: languages without a Prettier parser fall back
// to Monaco's built-in format provider when one is available.
const PRETTIER_PARSERS = {
  javascript: 'babel',
  typescript: 'typescript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  markdown: 'markdown',
  yaml: 'yaml',
};

function formatterParserForModel(model) {
  if (!model) return null;
  const lang = model.getLanguageId();
  if (PRETTIER_PARSERS[lang]) return PRETTIER_PARSERS[lang];

  const path = activeTab || '';
  const ext = path.split('.').pop().toLowerCase();
  if (ext === 'jsx') return 'babel';
  if (ext === 'tsx') return 'typescript';
  if (ext === 'jsonc') return 'json';
  if (ext === 'htm') return 'html';
  return null;
}

function prettierPluginsForParser(parser) {
  // Prettier's browser build exposes the loaded parser plugins through
  // window.prettierPlugins. We pass the complete set so embedded syntax
  // (e.g. JS template literals containing HTML) has the plugins it needs.
  if (!window.prettierPlugins) return [];
  return Object.values(window.prettierPlugins);
}

function offsetAtPosition(model, position) {
  return model.getOffsetAt(position);
}

function replaceModelText(formatted, sourceTag = 'prettier') {
  const model = editor.getModel();
  if (!model) return false;
  const old = model.getValue();
  if (formatted === old) return false;
  editor.pushUndoStop();
  editor.executeEdits(sourceTag, [{
    range: model.getFullModelRange(),
    text: formatted,
    forceMoveMarkers: true,
  }]);
  editor.pushUndoStop();
  return true;
}

async function runMonacoFormatter(selectionOnly = false) {
  const actionId = selectionOnly
    ? 'editor.action.formatSelection'
    : 'editor.action.formatDocument';
  try {
    const action = editor.getAction(actionId);
    if (action) {
      await action.run();
      return true;
    }
  } catch (e) {
    // Let the caller show the final friendly message.
  }
  return false;
}

async function formatActiveDocument(selectionOnly = false) {
  const model = editor.getModel();
  if (!model || !activeTab || !openTabs[activeTab] || openTabs[activeTab].type !== 'text') {
    showToast('Open a text file first');
    return false;
  }

  if (formatterBusy) return false;
  formatterBusy = true;

  try {
    const parser = formatterParserForModel(model);
    const source = model.getValue();

    const isGDScript = model.getLanguageId() === 'gdscript' || /\.gd$/i.test(activeTab || '');
    if (isGDScript) {
      const selection = editor.getSelection();
      const hasSelection = !!selection && !selection.isEmpty();
      const shouldFormatSelection = selectionOnly && hasSelection;
      if (shouldFormatSelection) {
        const range = selection;
        const selected = model.getValueInRange(range);
        const pretty = await formatGDScriptWithPrettyGd(selected);
        const formatted = pretty !== null ? pretty : formatGDScriptText(selected, { preserveTrailingNewline: selected.endsWith('\n') });
        if (formatted !== selected) {
          editor.pushUndoStop();
          editor.executeEdits('gdscript-formatter', [{ range, text: formatted, forceMoveMarkers: true }]);
          editor.pushUndoStop();
        }
        showToast(formatted !== selected ? 'GDScript selection formatted ✓' : 'Already formatted');
      } else {
        const pretty = await formatGDScriptWithPrettyGd(source);
      const formatted = pretty !== null ? pretty : formatGDScriptText(source);
        const changed = replaceModelText(formatted, 'gdscript-formatter');
        showToast(changed ? 'GDScript formatted ✓' : 'Already formatted');
      }
      editor.focus();
      return true;
    }
    const selection = editor.getSelection();

    // Selection formatting is only attempted with Prettier when there is a
    // real selection. An empty selection behaves like Format Document.
    const hasSelection = !!selection && !selection.isEmpty();
    const shouldFormatSelection = selectionOnly && hasSelection;

    if (parser && window.prettier) {
      try {
        const options = {
          parser,
          plugins: prettierPluginsForParser(parser),
          printWidth: 100,
          tabWidth: 4,
          useTabs: false,
          singleQuote: false,
          trailingComma: 'all',
        };

        if (shouldFormatSelection) {
          options.rangeStart = offsetAtPosition(model, selection.getStartPosition());
          options.rangeEnd = offsetAtPosition(model, selection.getEndPosition());
        }

        const formatted = await window.prettier.format(source, options);
        const changed = replaceModelText(formatted, 'prettier');
        showToast(changed
          ? (shouldFormatSelection ? 'Selection formatted ✓' : 'Formatted ✓')
          : 'Already formatted');
        editor.focus();
        return true;
      } catch (e) {
        // A valid language can still fail if the current text is syntactically
        // invalid. Fall through to Monaco's provider before reporting failure.
      }
    }

    const monacoDone = await runMonacoFormatter(shouldFormatSelection);
    if (monacoDone) {
      showToast(shouldFormatSelection ? 'Selection formatted ✓' : 'Formatted ✓');
      editor.focus();
      return true;
    }

    showToast(`No formatter available for ${model.getLanguageId()}`);
    return false;
  } finally {
    formatterBusy = false;
  }
}

async function toggleFormatOnSave() {
  formatOnSave = !formatOnSave;
  const state = formatOnSave ? 'On' : 'Off';
  const btn = document.getElementById('format-toggle');
  if (btn) btn.textContent = `Format on Save: ${state}`;
  showToast(`Format on Save: ${state}`);
}

// ---------------- Save ----------------
async function saveActive() {
  if (!activeTab || openTabs[activeTab].type !== 'text') return;
  if (formatOnSave) await formatActiveDocument(false);
  const content = openTabs[activeTab].model.getValue();
  try {
    await FS().writeFile({ path: activeTab, data: content, encoding: 'utf8' });
  } catch (e) { alert('Save failed: ' + e.message); return; }
  openTabs[activeTab].dirty = false;
  renderTabs();
  flashSaved('save-btn');
}

async function saveAll() {
  const dirtyPaths = Object.keys(openTabs).filter((p) => openTabs[p].type === 'text' && openTabs[p].dirty);
  if (dirtyPaths.length === 0) { flashSaved('save-all-btn'); return; }
  const failures = [];
  for (const p of dirtyPaths) {
    try {
      await FS().writeFile({ path: p, data: openTabs[p].model.getValue(), encoding: 'utf8' });
      openTabs[p].dirty = false;
    } catch (e) { failures.push(p.split('/').pop()); }
  }
  renderTabs();
  if (failures.length) alert('Could not save: ' + failures.join(', '));
  else flashSaved('save-all-btn');
}

function flashSaved(btnId) {
  const btn = document.getElementById(btnId);
  const old = btn.textContent;
  btn.textContent = 'Saved ✓';
  setTimeout(() => { btn.textContent = old; }, 900);
}

// ---------------- Clipboard (Copy / Cut / Paste) ----------------
async function copySelection() {
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model) return;
  const text = model.getValueInRange(sel);
  if (!text) { showToast('Nothing selected'); return; }
  try { await Clip().write({ string: text }); showToast('Copied'); }
  catch (e) { alert('Copy failed: ' + e.message); }
}
async function cutSelection() {
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model) return;
  const text = model.getValueInRange(sel);
  if (!text) { showToast('Nothing selected'); return; }
  try {
    await Clip().write({ string: text });
    editor.executeEdits('cut', [{ range: sel, text: '', forceMoveMarkers: true }]);
    showToast('Cut');
  } catch (e) { alert('Cut failed: ' + e.message); }
}
async function pasteClipboard() {
  try {
    const res = await Clip().read();
    const text = res && res.value ? res.value : '';
    if (!text) { showToast('Clipboard is empty'); return; }
    const sel = editor.getSelection();
    editor.executeEdits('paste', [{ range: sel, text, forceMoveMarkers: true }]);
    editor.focus();
    showToast('Pasted');
  } catch (e) { alert('Paste failed: ' + e.message); }
}

// ---------------- Local server (serves the current project over real HTTP) ----------------
let localServerUrl = null;
const LOCAL_SERVER_PORT = 8091;

async function startLocalServer() {
  try {
    const res = await LocalServer().start({ root: ROOT, port: LOCAL_SERVER_PORT });
    localServerUrl = res.url;
    try { await Clip().write({ string: localServerUrl }); } catch (e) { /* clipboard is a nice-to-have here */ }
    showToast(`Serving ${ROOT} at ${localServerUrl} (copied)`);
  } catch (e) {
    alert('Could not start server: ' + e.message);
  }
}
async function stopLocalServer() {
  try {
    await LocalServer().stop();
    localServerUrl = null;
    showToast('Server stopped');
  } catch (e) { alert('Could not stop server: ' + e.message); }
}

// ---------------- Breadcrumb ----------------
function renderBreadcrumb(absPath) {
  const el = document.getElementById('breadcrumb');
  if (!absPath) { el.innerHTML = ''; return; }
  const rel = absPath.startsWith(ROOT) ? absPath.slice(ROOT.length + 1) : absPath;
  const parts = rel.split('/').filter(Boolean);
  el.innerHTML = parts
    .map((p, i) => `<span class="${i === parts.length - 1 ? 'crumb-file' : ''}">${p}</span>`)
    .join('<span class="crumb-sep">›</span>');
}

// ---------------- File tree filter ----------------
document.getElementById('tree-filter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#file-tree .tree-item').forEach((item) => {
    if (!q) { item.classList.remove('filtered-out'); return; }
    item.classList.toggle('filtered-out', !item.textContent.toLowerCase().includes(q));
  });
});

// ---------------- Font size / word wrap controls ----------------
function fontDec() { fontSize = Math.max(10, fontSize - 2); editor.updateOptions({ fontSize }); }
function fontInc() { fontSize = Math.min(28, fontSize + 2); editor.updateOptions({ fontSize }); }
function toggleWrap() {
  wrapOn = !wrapOn;
  editor.updateOptions({ wordWrap: wrapOn ? 'on' : 'off' });
  document.getElementById('wrap-toggle').textContent = wrapOn ? 'Wrap: On' : 'Wrap: Off';
}
function toggleSidebarFn() { document.getElementById('sidebar').classList.toggle('collapsed'); }

document.getElementById('font-dec').addEventListener('click', fontDec);
document.getElementById('font-inc').addEventListener('click', fontInc);
document.getElementById('wrap-toggle').addEventListener('click', toggleWrap);
document.getElementById('format-btn').addEventListener('click', () => formatActiveDocument(false));
document.getElementById('format-toggle').addEventListener('click', toggleFormatOnSave);
document.getElementById('toggle-sidebar').addEventListener('click', toggleSidebarFn);

// ---------------- Extra-keys row (Home/End/Arrows/Tab + sticky Shift/Ctrl) ----------------
let stickyShift = false;
let stickyCtrl = false;

function updateModKeyVisuals() {
  document.getElementById('key-shift').classList.toggle('active', stickyShift);
  document.getElementById('key-ctrl').classList.toggle('active', stickyCtrl);
}
function consumeMods() {
  const m = { shift: stickyShift, ctrl: stickyCtrl };
  stickyShift = false; stickyCtrl = false;
  updateModKeyVisuals();
  return m;
}
document.getElementById('key-shift').addEventListener('click', () => { stickyShift = !stickyShift; updateModKeyVisuals(); editor.focus(); });
document.getElementById('key-ctrl').addEventListener('click', () => { stickyCtrl = !stickyCtrl; updateModKeyVisuals(); editor.focus(); });

function navCommand(base, selectVariant, wordVariant, wordSelectVariant) {
  const { shift, ctrl } = consumeMods();
  let id = base;
  if (ctrl && shift && wordSelectVariant) id = wordSelectVariant;
  else if (ctrl && wordVariant) id = wordVariant;
  else if (shift && selectVariant) id = selectVariant;
  runEditorCommand(id);
}
document.getElementById('key-home').addEventListener('click', () => navCommand('cursorHome', 'cursorHomeSelect'));
document.getElementById('key-end').addEventListener('click', () => navCommand('cursorEnd', 'cursorEndSelect'));
document.getElementById('key-left').addEventListener('click', () => navCommand('cursorLeft', 'cursorLeftSelect', 'cursorWordLeft', 'cursorWordLeftSelect'));
document.getElementById('key-right').addEventListener('click', () => navCommand('cursorRight', 'cursorRightSelect', 'cursorWordRight', 'cursorWordRightSelect'));
document.getElementById('key-up').addEventListener('click', () => navCommand('cursorUp', 'cursorUpSelect'));
document.getElementById('key-down').addEventListener('click', () => navCommand('cursorDown', 'cursorDownSelect'));
document.getElementById('key-tab').addEventListener('click', () => {
  consumeMods();
  if (!tryEmmetExpand()) runEditorCommand('tab');
});

// ---------------- Live preview ----------------
function joinPath(baseDir, rel) {
  let base = baseDir;
  let path = rel;
  if (rel.startsWith('/')) { base = ROOT; path = rel.slice(1); }
  const stack = base.split('/').filter(Boolean);
  path.split('/').forEach((seg) => {
    if (seg === '..') stack.pop();
    else if (seg !== '.' && seg !== '') stack.push(seg);
  });
  return '/' + stack.join('/');
}

function relativePath(fromDir, toAbs) {
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = toAbs.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  const relParts = [];
  for (let k = 0; k < ups; k++) relParts.push('..');
  return relParts.concat(downs).join('/');
}

function isLocalRef(src) { return src && !/^(https?:|data:|#|\/\/)/i.test(src); }

async function inlineAsset(html, tagRegex, resolver, warnings) {
  let result = html;
  let match;
  const matches = [];
  while ((match = tagRegex.exec(html)) !== null) matches.push(match);
  for (const m of matches) {
    try {
      const replacement = await resolver(m);
      if (replacement !== null) result = result.replace(m[0], replacement);
    } catch (e) {
      if (isLocalRef(m[1])) warnings.push(m[1]);
    }
  }
  return result;
}

async function buildPreviewHtml(htmlContent, baseDir) {
  let html = htmlContent;
  const warnings = [];

  html = await inlineAsset(html, /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g, async (m) => {
    if (!isLocalRef(m[1])) return null;
    const abs = joinPath(baseDir, m[1]);
    const res = await FS().readFile({ path: abs, encoding: 'utf8' });
    return `<style>${res.data}</style>`;
  }, warnings);

  html = await inlineAsset(html, /<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/g, async (m) => {
    if (!isLocalRef(m[1])) return null;
    const abs = joinPath(baseDir, m[1]);
    const res = await FS().readFile({ path: abs, encoding: 'utf8' });
    return `<script>${res.data}</script>`;
  }, warnings);

  html = await inlineAsset(html, /<img[^>]+src=["']([^"']+)["']/g, async (m) => {
    if (!isLocalRef(m[1])) return null;
    const abs = joinPath(baseDir, m[1]);
    const ext = m[1].split('.').pop().toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    const res = await FS().readFile({ path: abs });
    return m[0].replace(m[1], `data:${mime};base64,${res.data}`);
  }, warnings);

  if (warnings.length > 0) {
    const list = warnings.map((w) => w.replace(/</g, '&lt;')).join(', ');
    const banner = `<div style="position:fixed;top:0;left:0;right:0;background:#c0392b;color:#fff;` +
      `padding:8px 12px;font-family:sans-serif;font-size:12px;z-index:999999;">` +
      `⚠️ Preview couldn't find: ${list} — check the path relative to this project's root.</div>` +
      `<div style="height:38px;"></div>`;
    if (/<body[^>]*>/i.test(html)) html = html.replace(/<body[^>]*>/i, (m) => m + banner);
    else html = banner + html;
  }
  return html;
}

async function togglePreview() {
  if (!activeTab) { alert('Open a file first.'); return; }
  if (!/\.html?$/i.test(activeTab)) { alert('Preview works on HTML files — open one first.'); return; }
  const htmlContent = openTabs[activeTab].model.getValue();
  const baseDir = activeTab.substring(0, activeTab.lastIndexOf('/'));
  let finalHtml;
  try { finalHtml = await buildPreviewHtml(htmlContent, baseDir); }
  catch (e) { finalHtml = htmlContent; }
  document.getElementById('preview-frame').srcdoc = finalHtml;
  document.getElementById('preview-panel').classList.remove('hidden');
}
document.getElementById('btn-preview').addEventListener('click', togglePreview);
document.getElementById('close-preview').addEventListener('click', () => {
  document.getElementById('preview-panel').classList.add('hidden');
});
let previewMobileMode = false;
document.getElementById('preview-device-toggle').addEventListener('click', () => {
  previewMobileMode = !previewMobileMode;
  document.getElementById('preview-frame').classList.toggle('mobile-frame', previewMobileMode);
  document.getElementById('preview-device-toggle').textContent = previewMobileMode ? '🖥️ Desktop' : '📱 Mobile';
});

document.getElementById('save-btn').addEventListener('click', saveActive);
document.getElementById('save-all-btn').addEventListener('click', saveAll);

// ---------------- New file / project ----------------
async function newFile() {
  const name = prompt(`New file path (relative to ${ROOT}), e.g. notes/todo.md:`);
  if (!name) return;
  const full = joinPath(ROOT, name);
  try {
    await FS().writeFile({ path: full, data: '', encoding: 'utf8', recursive: true });
  } catch (e) { alert('Could not create file: ' + e.message); return; }
  await renderTree(ROOT, document.getElementById('file-tree'));
  openFile(full);
}
async function newProject() {
  const name = prompt(`New project name (created inside ${ROOT}):`);
  if (!name) return;
  const full = joinPath(ROOT, name);
  try { await FS().mkdir({ path: full, recursive: true }); }
  catch (e) { alert('Could not create project: ' + e.message); return; }
  switchRoot(full);
}
document.getElementById('new-file-btn').addEventListener('click', newFile);
document.getElementById('new-project-btn').addEventListener('click', newProject);

// ---------------- Quick Open (Ctrl+P) / Insert Image ----------------
let quickOpenFiles = [];
let quickOpenSelected = 0;
let quickOpenMode = 'open'; // 'open' | 'insert-image'

async function collectFilesRecursive(dir, depth, out) {
  if (out.length >= 300 || depth < 0) return;
  let entries;
  try { entries = await listDir(dir); } catch (e) { return; }
  for (const entry of entries) {
    if (out.length >= 300) return;
    const full = `${dir}/${entry.name}`;
    if (entry.isDir) { if (depth > 0) await collectFilesRecursive(full, depth - 1, out); }
    else out.push(full);
  }
}

async function openQuickOpen(mode = 'open') {
  quickOpenMode = mode;
  document.getElementById('quick-open').classList.remove('hidden');
  const input = document.getElementById('quick-open-input');
  input.placeholder = mode === 'insert-image' ? 'Pick an image to insert…' : 'Go to file… (type a name)';
  input.value = '';
  input.focus();
  document.getElementById('quick-open-list').innerHTML =
    `<div class="modal-item modal-dim">Scanning ${ROOT} …</div>`;
  quickOpenFiles = [];
  await collectFilesRecursive(ROOT, 6, quickOpenFiles);
  if (mode === 'insert-image') quickOpenFiles = quickOpenFiles.filter((f) => isImage(f));
  renderQuickOpenList('');
}
function closeQuickOpen() { document.getElementById('quick-open').classList.add('hidden'); }

function insertImageTag(imgAbsPath) {
  if (!activeTab || openTabs[activeTab].type !== 'text') {
    alert('Open a text file first, place your cursor where you want the image, then try again.');
    return;
  }
  const baseDir = activeTab.substring(0, activeTab.lastIndexOf('/'));
  const rel = relativePath(baseDir, imgAbsPath);
  const lang = langFromExt(activeTab);

  let snippet;
  let toastMsg;
  if (lang === 'css' || lang === 'scss') {
    snippet = `url('${rel}')`;
    toastMsg = 'Inserted url(...)';
  } else if (lang === 'html') {
    snippet = `<img src="${rel}" alt="">`;
    toastMsg = 'Image tag inserted';
  } else {
    snippet = rel; // JS or anything else — just the path, safest generic default
    toastMsg = 'Path inserted';
  }

  const sel = editor.getSelection();
  editor.executeEdits('insertImage', [{ range: sel, text: snippet, forceMoveMarkers: true }]);
  editor.focus();
  showToast(toastMsg);
}

function renderQuickOpenList(query) {
  const q = query.trim().toLowerCase();
  const matches = (q ? quickOpenFiles.filter((f) => f.toLowerCase().includes(q)) : quickOpenFiles).slice(0, 40);
  quickOpenSelected = 0;
  const list = document.getElementById('quick-open-list');
  list.innerHTML = '';
  if (matches.length === 0) { list.innerHTML = '<div class="modal-item modal-dim">No matches</div>'; return; }
  matches.forEach((f, i) => {
    const rel = f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f;
    const row = document.createElement('div');
    row.className = 'modal-item' + (i === 0 ? ' selected' : '');
    row.textContent = iconFor(f) + ' ' + rel;
    row.addEventListener('click', () => {
      closeQuickOpen();
      if (quickOpenMode === 'insert-image') insertImageTag(f);
      else openFile(f);
    });
    list.appendChild(row);
  });
}
function updateModalSelection(items, idx) {
  items.forEach((it, i) => it.classList.toggle('selected', i === idx));
  if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
}
document.getElementById('quick-open-input').addEventListener('input', (e) => renderQuickOpenList(e.target.value));
document.getElementById('quick-open-input').addEventListener('keydown', (e) => {
  const items = Array.from(document.getElementById('quick-open-list').querySelectorAll('.modal-item'));
  if (e.key === 'ArrowDown') { e.preventDefault(); quickOpenSelected = Math.min(items.length - 1, quickOpenSelected + 1); updateModalSelection(items, quickOpenSelected); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); quickOpenSelected = Math.max(0, quickOpenSelected - 1); updateModalSelection(items, quickOpenSelected); }
  else if (e.key === 'Enter') { e.preventDefault(); if (items[quickOpenSelected]) items[quickOpenSelected].click(); }
  else if (e.key === 'Escape') { closeQuickOpen(); }
});
document.getElementById('quick-open').addEventListener('click', (e) => {
  if (e.target.id === 'quick-open') closeQuickOpen();
});
document.getElementById('quick-open-btn').addEventListener('click', () => openQuickOpen('open'));

// ---------------- Command Palette (Ctrl+Shift+P) ----------------
function runEditorCommand(id) {
  try {
    const action = editor.getAction(id);
    if (action) { action.run(); editor.focus(); return; }
    editor.trigger('commandPalette', id, null);
  } catch (e) { /* command unavailable in this Monaco build — ignore quietly */ }
  editor.focus();
}

function commandList() {
  return [
    { label: 'Save', run: saveActive },
    { label: 'Save All', run: saveAll },
    { label: 'Format Document', run: () => formatActiveDocument(false) },
    { label: 'Format Selection', run: () => formatActiveDocument(true) },
    { label: 'Toggle Format on Save', run: toggleFormatOnSave },
    { label: 'New File…', run: newFile },
    { label: 'New Project…', run: newProject },
    { label: 'Toggle Preview', run: togglePreview },
    { label: 'Toggle Sidebar', run: toggleSidebarFn },
    { label: 'Toggle Word Wrap', run: toggleWrap },
    { label: 'Increase Font Size', run: fontInc },
    { label: 'Decrease Font Size', run: fontDec },
    { label: 'Go to File… (Quick Open)', run: () => openQuickOpen('open') },
    { label: 'Insert Image…', run: () => openQuickOpen('insert-image') },
    { label: 'Go to Full Storage (Home)', run: () => switchRoot(HOME) },
    { label: 'Git…', run: openGitPanel },
    { label: 'Git: Commit All', run: gitCommitAll },
    { label: 'Git: Push', run: gitPush },
    { label: 'Git: Pull', run: gitPull },
    { label: 'Git: Set Remote…', run: gitSetRemote },
    { label: 'Git Settings', run: gitSettings },
    { label: 'Run Current File (JavaScript / Java)', run: runCurrentFile },
    { label: 'Java Run Settings…', run: javaRunSettings },
    { label: 'Copy', run: copySelection },
    { label: 'Cut', run: cutSelection },
    { label: 'Paste', run: pasteClipboard },
    { label: 'Start Local Server (serves current project)', run: startLocalServer },
    { label: 'Stop Local Server', run: stopLocalServer },
    { label: 'Find', run: () => runEditorCommand('actions.find') },
    { label: 'Find & Replace', run: () => runEditorCommand('editor.action.startFindReplaceAction') },
    { label: 'Toggle Line Comment', run: () => runEditorCommand('editor.action.commentLine') },
    { label: 'Indent Selection', run: () => runEditorCommand('editor.action.indentLines') },
    { label: 'Outdent Selection', run: () => runEditorCommand('editor.action.outdentLines') },
    { label: 'Move Line Up', run: () => runEditorCommand('editor.action.moveLinesUpAction') },
    { label: 'Move Line Down', run: () => runEditorCommand('editor.action.moveLinesDownAction') },
    { label: 'Duplicate Line Down', run: () => runEditorCommand('editor.action.copyLinesDownAction') },
    { label: 'Delete Line', run: () => runEditorCommand('editor.action.deleteLines') },
    { label: 'Select All', run: () => { const m = editor.getModel(); if (m) editor.setSelection(m.getFullModelRange()); editor.focus(); } },
    { label: 'Undo', run: () => runEditorCommand('undo') },
    { label: 'Redo', run: () => runEditorCommand('redo') },
  ];
}
let paletteSelected = 0;
function openCommandPalette() {
  document.getElementById('command-palette').classList.remove('hidden');
  const input = document.getElementById('command-palette-input');
  input.value = '';
  input.focus();
  renderPaletteList('');
}
function closeCommandPalette() { document.getElementById('command-palette').classList.add('hidden'); }
function renderPaletteList(query) {
  const q = query.trim().toLowerCase();
  const cmds = commandList().filter((c) => c.label.toLowerCase().includes(q));
  paletteSelected = 0;
  const list = document.getElementById('command-palette-list');
  list.innerHTML = '';
  if (cmds.length === 0) { list.innerHTML = '<div class="modal-item modal-dim">No matching commands</div>'; return; }
  cmds.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'modal-item' + (i === 0 ? ' selected' : '');
    row.textContent = c.label;
    row.addEventListener('click', () => { closeCommandPalette(); c.run(); });
    list.appendChild(row);
  });
}
document.getElementById('command-palette-input').addEventListener('input', (e) => renderPaletteList(e.target.value));
document.getElementById('command-palette-input').addEventListener('keydown', (e) => {
  const items = Array.from(document.getElementById('command-palette-list').querySelectorAll('.modal-item'));
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteSelected = Math.min(items.length - 1, paletteSelected + 1); updateModalSelection(items, paletteSelected); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSelected = Math.max(0, paletteSelected - 1); updateModalSelection(items, paletteSelected); }
  else if (e.key === 'Enter') { e.preventDefault(); if (items[paletteSelected]) items[paletteSelected].click(); }
  else if (e.key === 'Escape') { closeCommandPalette(); }
});
document.getElementById('command-palette').addEventListener('click', (e) => {
  if (e.target.id === 'command-palette') closeCommandPalette();
});
document.getElementById('command-palette-btn').addEventListener('click', openCommandPalette);

// ---------------- Git integration ----------------
// A Capacitor-Filesystem-backed adapter matching the interface
// isomorphic-git expects (see isomorphic-git.org/docs/en/fs and the
// reference custom-fs examples in the wild). Every method operates on
// the same real files the editor itself reads and writes — there is
// no separate in-browser storage layer, unlike isomorphic-git's usual
// LightningFS/IndexedDB setup.
const CORS_PROXY = 'https://cors.isomorphic-git.org';

let _gitLib = null;
let _httpLib = null;
function detectGitGlobals() {
  const candidates = window.__gitNewGlobals || [];
  candidates.forEach((key) => {
    const val = window[key];
    if (!val || typeof val !== 'object') return;
    if (!_gitLib && typeof val.clone === 'function' && typeof val.statusMatrix === 'function') _gitLib = val;
    if (!_httpLib && typeof val.request === 'function') _httpLib = val;
  });
  // Fallback in case the diff missed something (e.g. a name collision).
  if (!_gitLib && window.git && typeof window.git.clone === 'function') _gitLib = window.git;
  if (!_httpLib && window.GitHttp && typeof window.GitHttp.request === 'function') _httpLib = window.GitHttp;
}
function GitLib() { if (!_gitLib) detectGitGlobals(); return _gitLib; }
function GitHttpLib() { if (!_httpLib) detectGitGlobals(); return _httpLib; }
async function ensureGitLoaded() {
  if (GitLib() && GitHttpLib() && window.Buffer) return;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (GitLib() && GitHttpLib() && window.Buffer) return;
  }
  const found = (window.__gitNewGlobals || []).join(', ') || '(none detected)';
  const missing = [];
  if (!GitLib() || !GitHttpLib()) missing.push(`git library exports (new globals seen: ${found})`);
  if (!window.Buffer) missing.push('Buffer polyfill');
  throw new Error('Still missing: ' + missing.join('; ') + '. Screenshot this exact message.');
}

function b64ToUint8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function uint8ToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function gitError(code, path) {
  const e = new Error(`${code}: ${path}`);
  e.code = code;
  return e;
}
function makeGitStats(capStat) {
  const isDir = capStat.type === 'directory';
  return {
    isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false,
    size: capStat.size || 0, mtimeMs: capStat.mtime || Date.now(), ctimeMs: capStat.ctime || capStat.mtime || Date.now(),
    mode: isDir ? 0o040000 : 0o100644, ino: 0, uid: 1, gid: 1, dev: 1,
  };
}

const gitFs = {
  promises: {
    async readFile(filepath, opts) {
      try {
        const wantsUtf8 = opts && opts.encoding === 'utf8';
        const res = await FS().readFile(wantsUtf8 ? { path: filepath, encoding: 'utf8' } : { path: filepath });
        return wantsUtf8 ? res.data : b64ToUint8(res.data);
      } catch (e) { throw gitError('ENOENT', filepath); }
    },
    async writeFile(filepath, data) {
      const isBinary = data instanceof Uint8Array;
      await FS().writeFile({
        path: filepath,
        data: isBinary ? uint8ToB64(data) : data,
        encoding: isBinary ? undefined : 'utf8',
        recursive: true,
      });
    },
    async unlink(filepath) {
      try { await FS().deleteFile({ path: filepath }); } catch (e) { throw gitError('ENOENT', filepath); }
    },
    async readdir(filepath) {
      try { const res = await FS().readdir({ path: filepath }); return res.files.map((f) => f.name); }
      catch (e) { throw gitError('ENOENT', filepath); }
    },
    async mkdir(filepath) {
      let exists = false;
      try { await FS().stat({ path: filepath }); exists = true; } catch (e) { /* good, doesn't exist yet */ }
      if (exists) throw gitError('EEXIST', filepath);
      await FS().mkdir({ path: filepath, recursive: true });
    },
    async rmdir(filepath) {
      try { await FS().rmdir({ path: filepath, recursive: false }); } catch (e) { throw gitError('ENOTEMPTY', filepath); }
    },
    async stat(filepath) {
      try { return makeGitStats(await FS().stat({ path: filepath })); } catch (e) { throw gitError('ENOENT', filepath); }
    },
    async lstat(filepath) {
      try { return makeGitStats(await FS().stat({ path: filepath })); } catch (e) { throw gitError('ENOENT', filepath); }
    },
    // These three are documented as "optional" — only needed if a repo
    // actually uses symlinks — but isomorphic-git's internal fs wrapper
    // appears to grab a reference to all of them unconditionally, which
    // throws "Cannot read properties of undefined (reading 'bind')" if
    // they're missing entirely, even before any symlink is involved.
    // Stubbing them out (rather than omitting them) fixes that, while
    // still failing clearly if something ever genuinely needs a symlink.
    async readlink(filepath) { throw gitError('ENOSYS', filepath); },
    async symlink(target, filepath) { throw gitError('ENOSYS', filepath); },
    async chmod(filepath, mode) { /* no-op: not meaningful on this filesystem */ },
  },
};

// ---------------- Git config (name/email/username/token) ----------------
function getGitConfig() {
  try { return JSON.parse(localStorage.getItem('coodev-git-config') || '{}'); } catch (e) { return {}; }
}
function setGitConfig(cfg) { localStorage.setItem('coodev-git-config', JSON.stringify(cfg)); }
function gitAuth() {
  const cfg = getGitConfig();
  return { username: cfg.username || '', password: cfg.token || '' };
}
function gitSettings() {
  const cfg = getGitConfig();
  const name = prompt('Your name (for commit authorship):', cfg.name || '');
  if (name === null) return;
  const email = prompt('Your email (for commit authorship):', cfg.email || '');
  if (email === null) return;
  const username = prompt('GitHub username:', cfg.username || '');
  if (username === null) return;
  const token = prompt('GitHub Personal Access Token (needs "repo" scope) — leave blank to keep the saved one:', '');
  if (token === null) return;
  setGitConfig({ name, email, username, token: token || cfg.token || '' });
  showToast('Git settings saved');
}

// ---------------- Git operations ----------------
function showGitBusy(msg) { const el = document.getElementById('git-busy'); el.textContent = msg; el.classList.remove('hidden'); }
function hideGitBusy() { document.getElementById('git-busy').classList.add('hidden'); }

async function gitInit() {
  try {
    await ensureGitLoaded();
    await GitLib().init({ fs: gitFs, dir: ROOT });
    showToast('Initialized empty repo');
    const url = prompt('Optional: paste a GitHub repo URL to link as "origin" (needed for Push/Pull) — or leave blank to skip for now:');
    if (url) {
      await GitLib().addRemote({ fs: gitFs, dir: ROOT, remote: 'origin', url, force: true });
      showToast('Remote "origin" set');
    }
    refreshGitPanel();
  } catch (e) { alert('Init failed: ' + e.message); }
}

async function gitSetRemote() {
  const url = prompt('GitHub repo URL to set as "origin" (needed for Push/Pull):');
  if (!url) return;
  try {
    await ensureGitLoaded();
    await GitLib().addRemote({ fs: gitFs, dir: ROOT, remote: 'origin', url, force: true });
    showToast('Remote "origin" set');
  } catch (e) { alert('Could not set remote: ' + e.message); }
}

async function gitCloneInto() {
  const url = prompt('GitHub repo URL to clone (https://github.com/user/repo.git):');
  if (!url) return;
  const name = url.replace(/\.git$/, '').split('/').pop();
  const dest = joinPath(ROOT, name);
  showGitBusy(`Cloning into ${name}…`);
  try {
    await ensureGitLoaded();
    await GitLib().clone({
      fs: gitFs, http: GitHttpLib(), dir: dest, url,
      corsProxy: CORS_PROXY, singleBranch: true, depth: 1, onAuth: gitAuth,
    });
    switchRoot(dest);
    showToast('Cloned ' + name);
  } catch (e) { alert('Clone failed: ' + e.message); }
  finally { hideGitBusy(); }
}

async function gitStatus() {
  await ensureGitLoaded();
  const matrix = await GitLib().statusMatrix({ fs: gitFs, dir: ROOT });
  // rows are [filepath, headStatus, workdirStatus, stageStatus]; 1,1,1 means unchanged
  return matrix.filter((row) => !(row[1] === 1 && row[2] === 1 && row[3] === 1));
}

async function refreshGitPanel() {
  document.getElementById('git-panel-root').textContent = ROOT;
  updateGitLibStatus();
  let isRepo = true;
  try { await FS().stat({ path: joinPath(ROOT, '.git') }); } catch (e) { isRepo = false; }
  document.getElementById('git-not-repo').classList.toggle('hidden', isRepo);
  document.getElementById('git-is-repo').classList.toggle('hidden', !isRepo);
  if (!isRepo) return;

  const list = document.getElementById('git-status-list');
  list.innerHTML = '<div class="modal-item modal-dim">Checking status…</div>';
  try {
    const rows = await gitStatus();
    list.innerHTML = '';
    if (rows.length === 0) {
      list.innerHTML = '<div class="modal-item modal-dim">No changes — working tree clean</div>';
    } else {
      rows.forEach(([filepath, head, workdir]) => {
        let label = '📝 modified';
        if (head === 0) label = '✚ new';
        else if (workdir === 0) label = '🗑️ deleted';
        const row = document.createElement('div');
        row.className = 'modal-item';
        row.textContent = `${label}  ${filepath}`;
        list.appendChild(row);
      });
    }
  } catch (e) {
    list.innerHTML = `<div class="modal-item modal-dim">Error: ${e.message}</div>`;
  }
}

async function gitCommitAll() {
  const message = document.getElementById('git-commit-message').value.trim();
  if (!message) { alert('Enter a commit message first.'); return; }
  const cfg = getGitConfig();
  if (!cfg.name || !cfg.email) { alert('Set your name/email in Git Settings first.'); return; }
  showGitBusy('Committing…');
  try {
    await ensureGitLoaded();
    const rows = await gitStatus();
    for (const [filepath, , workdirStatus] of rows) {
      if (workdirStatus === 0) await GitLib().remove({ fs: gitFs, dir: ROOT, filepath });
      else await GitLib().add({ fs: gitFs, dir: ROOT, filepath });
    }
    await GitLib().commit({ fs: gitFs, dir: ROOT, message, author: { name: cfg.name, email: cfg.email } });
    document.getElementById('git-commit-message').value = '';
    showToast('Committed');
    refreshGitPanel();
  } catch (e) { alert('Commit failed: ' + e.message); }
  finally { hideGitBusy(); }
}

async function gitPush() {
  showGitBusy('Pushing…');
  try {
    await ensureGitLoaded();
    await GitLib().push({ fs: gitFs, http: GitHttpLib(), dir: ROOT, remote: 'origin', corsProxy: CORS_PROXY, onAuth: gitAuth });
    showToast('Pushed');
  } catch (e) {
    if (/fast-forward/i.test(e.message)) {
      alert('Push rejected: GitHub has commits your phone doesn\'t have yet (often just the initial README). Tap Pull to merge those in, then Push again.');
    } else {
      alert('Push failed: ' + e.message);
    }
  }
  finally { hideGitBusy(); }
}

async function gitPull() {
  const cfg = getGitConfig();
  showGitBusy('Pulling…');
  try {
    await ensureGitLoaded();
    await GitLib().pull({
      fs: gitFs, http: GitHttpLib(), dir: ROOT, remote: 'origin', corsProxy: CORS_PROXY, onAuth: gitAuth, singleBranch: true,
      author: { name: cfg.name || 'COODEV', email: cfg.email || 'coodev@example.com' },
    });
    showToast('Pulled latest changes');
    renderTree(ROOT, document.getElementById('file-tree'));
    refreshGitPanel();
  } catch (e) { alert('Pull failed: ' + e.message); }
  finally { hideGitBusy(); }
}

function updateGitLibStatus() {
  const el = document.getElementById('git-lib-status');
  if (GitLib() && GitHttpLib() && window.Buffer) {
    el.textContent = '✅ Git library loaded';
  } else {
    const parts = [];
    if (!GitLib() || !GitHttpLib()) parts.push('git exports (' + ((window.__gitNewGlobals || []).join(', ') || 'none') + ')');
    if (!window.Buffer) parts.push('Buffer polyfill');
    el.textContent = `⚠️ Still missing: ${parts.join('; ')}`;
  }
}

function openGitPanel() {
  document.getElementById('git-panel').classList.remove('hidden');
  refreshGitPanel();
}
function closeGitPanel() { document.getElementById('git-panel').classList.add('hidden'); }

document.getElementById('git-btn').addEventListener('click', openGitPanel);
document.getElementById('git-init-btn').addEventListener('click', gitInit);
document.getElementById('git-clone-btn').addEventListener('click', gitCloneInto);
document.getElementById('git-commit-btn').addEventListener('click', gitCommitAll);
document.getElementById('git-push-btn').addEventListener('click', gitPush);
document.getElementById('git-pull-btn').addEventListener('click', gitPull);
document.getElementById('git-remote-btn').addEventListener('click', gitSetRemote);
document.getElementById('git-settings-btn').addEventListener('click', gitSettings);
document.getElementById('git-close-btn').addEventListener('click', closeGitPanel);
document.getElementById('git-panel').addEventListener('click', (e) => { if (e.target.id === 'git-panel') closeGitPanel(); });

// ---------------- Run / Output (JavaScript only for now) ----------------
// Dispatches Run based on the current file's language: JavaScript runs
// instantly on-device (a hidden sandboxed iframe); Java compiles and runs
// via JDoodle's free online compiler API (needs internet + a one-time
// free credential setup). Other languages aren't wired up yet.
function runCurrentFile() {
  if (!activeTab || openTabs[activeTab].type !== 'text') { alert('Open a file first.'); return; }
  const lang = langFromExt(activeTab);
  if (lang === 'javascript') { runJavaScriptLocal(); return; }
  if (lang === 'java') { runJavaRemote(); return; }
  alert('Run currently supports JavaScript (instant, on-device) and Java (via a free online compiler, needs internet). Other languages need their own dedicated support — ask if you want one added.');
}

function runJavaScriptLocal() {
  const code = openTabs[activeTab].model.getValue();
  const wrapped = `<script>
(function () {
  var logs = [];
  function send(type, args) {
    logs.push({ type: type, text: Array.prototype.map.call(args, function (a) {
      try { return (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a); }
      catch (e) { return String(a); }
    }).join(' ') });
    parent.postMessage({ __coodevRun: true, logs: logs }, '*');
  }
  console.log = function () { send('log', arguments); };
  console.error = function () { send('error', arguments); };
  console.warn = function () { send('warn', arguments); };
  window.onerror = function (msg, src, line) { send('error', ['Uncaught: ' + msg + ' (line ' + line + ')']); return true; };
})();
<\/script><script>
try {
${code}
} catch (e) { console.error('Uncaught: ' + e.message); }
<\/script>`;
  document.getElementById('output-list').innerHTML = '<div class="output-item output-log">Running…</div>';
  document.getElementById('output-panel').classList.remove('hidden');
  document.getElementById('run-frame').srcdoc = wrapped;
}

// ---------------- Java (via JDoodle's free online compiler) ----------------
// Java is compiled, not interpreted — there's no mature way to compile
// arbitrary .java source entirely on-device the way Pyodide runs Python
// source directly. JDoodle provides a free (200 runs/day, no card needed)
// REST API that compiles and executes real Java, at the cost of needing
// internet and sending the code to their service.
const JDOODLE_VERSION_INDEX = '6'; // JDK 25.0.2, the most current available

function getJdoodleConfig() {
  try { return JSON.parse(localStorage.getItem('coodev-jdoodle-config') || '{}'); } catch (e) { return {}; }
}
function setJdoodleConfig(cfg) { localStorage.setItem('coodev-jdoodle-config', JSON.stringify(cfg)); }

function javaRunSettings() {
  const cfg = getJdoodleConfig();
  const clientId = prompt('JDoodle Client ID — free, sign up at jdoodle.com/compiler-api (200 free runs/day, no card needed):', cfg.clientId || '');
  if (clientId === null) return;
  const clientSecret = prompt('JDoodle Client Secret:', '');
  setJdoodleConfig({ clientId, clientSecret: clientSecret || cfg.clientSecret || '' });
  showToast('Java run settings saved');
}

async function runJavaRemote() {
  const cfg = getJdoodleConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    alert('Set up free JDoodle credentials first — needed once, then Run just works from here on.');
    javaRunSettings();
    return;
  }
  const code = openTabs[activeTab].model.getValue();
  document.getElementById('output-list').innerHTML = '<div class="output-item output-log">Compiling & running on JDoodle…</div>';
  document.getElementById('output-panel').classList.remove('hidden');
  try {
    const res = await fetch('https://api.jdoodle.com/v1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        script: code,
        stdin: '',
        language: 'java',
        versionIndex: JDOODLE_VERSION_INDEX,
      }),
    });
    if (!res.ok) {
      if (res.status === 429) throw new Error('Daily free-run limit reached (200/day) — try again tomorrow.');
      throw new Error('HTTP ' + res.status);
    }
    const data = await res.json();
    const lines = [];
    if (data.output) lines.push({ type: data.isExecutionSuccess === false ? 'error' : 'log', text: data.output });
    if (data.error) lines.push({ type: 'error', text: data.error });
    if (lines.length === 0) lines.push({ type: 'log', text: '(no output)' });
    renderOutput(lines);
  } catch (e) {
    renderOutput([{
      type: 'error',
      text: 'Could not reach JDoodle: ' + e.message +
        '\n\nIf this is a network/CORS-looking error, that\'s a known possible snag calling their API directly from an app — screenshot the exact error and we\'ll add a workaround.',
    }]);
  }
}

function renderOutput(logs) {
  const list = document.getElementById('output-list');
  list.innerHTML = '';
  if (!logs || logs.length === 0) { list.innerHTML = '<div class="output-item">(no output)</div>'; return; }
  logs.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'output-item output-' + l.type;
    row.textContent = l.text;
    list.appendChild(row);
  });
  list.scrollTop = list.scrollHeight;
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.__coodevRun) renderOutput(e.data.logs);
});

document.getElementById('run-btn').addEventListener('click', runCurrentFile);
document.getElementById('output-close').addEventListener('click', () => {
  document.getElementById('output-panel').classList.add('hidden');
});

// ---------------- Global shortcuts ----------------
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openCommandPalette(); return; }
  if (mod && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openQuickOpen('open'); return; }
  if (mod && e.key === 's') { e.preventDefault(); saveActive(); return; }
  if (e.key === 'Escape') { closeQuickOpen(); closeCommandPalette(); closeActionSheet(); closeGitPanel(); }
});

window.addEventListener('beforeunload', (e) => {
  const hasDirty = Object.values(openTabs).some((t) => t.type === 'text' && t.dirty);
  if (hasDirty) { e.preventDefault(); e.returnValue = ''; }
});

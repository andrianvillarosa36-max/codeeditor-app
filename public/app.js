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

let ROOT = '/storage/emulated/0';
const HOME = '/storage/emulated/0';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
function isImage(name) { return IMAGE_EXTS.has(name.split('.').pop().toLowerCase()); }

function FS() { return Capacitor.Plugins.Filesystem; }
function StoragePermission() { return Capacitor.Plugins.StoragePermission; }

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
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
  // into firing mid-paste. Suppress it for a moment around any paste,
  // regardless of how the paste itself gets delivered underneath.
  editor.onDidPaste(() => { pasteGuardUntil = Date.now() + 1000; });
  editor.onDidChangeModelContent((e) => {
    if (activeTab && openTabs[activeTab] && openTabs[activeTab].type === 'text') {
      openTabs[activeTab].dirty = true;
      renderTabs();
    }
    if (!autoClosing) maybeAutoCloseTag(e);
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

function langFromExt(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json',
    md: 'markdown', sh: 'shell', bash: 'shell', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
    hpp: 'cpp', go: 'go', rs: 'rust', php: 'php', rb: 'ruby', xml: 'xml',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', txt: 'plaintext', env: 'ini', toml: 'ini',
  };
  return map[ext] || 'plaintext';
}

const ICON_BY_EXT = {
  html: '🟧', htm: '🟧', css: '🟦', scss: '🟦', js: '🟨', jsx: '🟨', ts: '🟦', tsx: '🟦',
  json: '📋', md: '📝', py: '🐍',
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

// ---------------- File tree ----------------
async function listDir(absPath) {
  const res = await FS().readdir({ path: absPath });
  return res.files
    .map((f) => ({ name: f.name, isDir: f.type === 'directory' }))
    .filter((f) => !f.name.startsWith('.'))
    .sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
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
      label.textContent = '📁 ' + entry.name;
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
        expanded = !expanded;
        childContainer.style.display = expanded ? 'block' : 'none';
        if (expanded) renderTree(full, childContainer);
      });
      container.appendChild(item);
      container.appendChild(childContainer);
    } else {
      item.textContent = iconFor(entry.name) + ' ' + entry.name;
      item.addEventListener('click', (e) => { e.stopPropagation(); openFile(full); });
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

// ---------------- Save ----------------
async function saveActive() {
  if (!activeTab || openTabs[activeTab].type !== 'text') return;
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
document.getElementById('toggle-sidebar').addEventListener('click', toggleSidebarFn);

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

// ---------------- Quick Open (Ctrl+P) ----------------
let quickOpenFiles = [];
let quickOpenSelected = 0;

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

async function openQuickOpen() {
  document.getElementById('quick-open').classList.remove('hidden');
  const input = document.getElementById('quick-open-input');
  input.value = '';
  input.focus();
  document.getElementById('quick-open-list').innerHTML =
    `<div class="modal-item modal-dim">Scanning ${ROOT} …</div>`;
  quickOpenFiles = [];
  await collectFilesRecursive(ROOT, 6, quickOpenFiles);
  renderQuickOpenList('');
}
function closeQuickOpen() { document.getElementById('quick-open').classList.add('hidden'); }

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
    row.addEventListener('click', () => { closeQuickOpen(); openFile(f); });
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

// ---------------- Command Palette (Ctrl+Shift+P) ----------------
function commandList() {
  return [
    { label: 'Save', run: saveActive },
    { label: 'Save All', run: saveAll },
    { label: 'New File…', run: newFile },
    { label: 'New Project…', run: newProject },
    { label: 'Toggle Preview', run: togglePreview },
    { label: 'Toggle Sidebar', run: toggleSidebarFn },
    { label: 'Toggle Word Wrap', run: toggleWrap },
    { label: 'Increase Font Size', run: fontInc },
    { label: 'Decrease Font Size', run: fontDec },
    { label: 'Go to File… (Quick Open)', run: openQuickOpen },
    { label: 'Go to Full Storage (Home)', run: () => switchRoot(HOME) },
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

// ---------------- Global shortcuts ----------------
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openCommandPalette(); return; }
  if (mod && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openQuickOpen(); return; }
  if (mod && e.key === 's') { e.preventDefault(); saveActive(); return; }
  if (e.key === 'Escape') { closeQuickOpen(); closeCommandPalette(); }
});

window.addEventListener('beforeunload', (e) => {
  const hasDirty = Object.values(openTabs).some((t) => t.type === 'text' && t.dirty);
  if (hasDirty) { e.preventDefault(); e.returnValue = ''; }
});

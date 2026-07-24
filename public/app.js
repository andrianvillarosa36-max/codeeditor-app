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
let wrapOn = true;

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
    wordWrap: 'on',
    // 'none' keeps wrapped continuation lines flush with the left edge
    // instead of matching the original line's (often deep) indentation —
    // on a narrow phone screen that indentation was eating most of the
    // width and causing a cascading "staircase" effect on long lines.
    wrappingIndent: 'none',
    scrollBeyondLastLine: false,
    // Keep pasted text exactly as-is instead of Monaco re-indenting each
    // line based on language heuristics.
    autoIndent: 'keep',
  });
  editor.onDidChangeModelContent(() => {
    if (activeTab && openTabs[activeTab] && openTabs[activeTab].type === 'text') {
      openTabs[activeTab].dirty = true;
      renderTabs();
    }
  });
  boot();
});

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
  if (granted) {
    startEditor();
  } else {
    showPermissionGate();
  }
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
        const res = await FS().readFile({ path: absPath }); // no encoding => base64
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
  if (isImg) {
    document.getElementById('image-viewer-img').src = tab.dataUri;
  } else {
    editor.setModel(tab.model);
  }
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

// ---------------- Open Editors (sidebar list) ----------------
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
    .map((p, i) => {
      const isLast = i === parts.length - 1;
      return `<span class="${isLast ? 'crumb-file' : ''}">${p}</span>`;
    })
    .join('<span class="crumb-sep">›</span>');
}

// ---------------- File tree filter ----------------
document.getElementById('tree-filter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#file-tree .tree-item').forEach((item) => {
    if (!q) { item.classList.remove('filtered-out'); return; }
    const match = item.textContent.toLowerCase().includes(q);
    item.classList.toggle('filtered-out', !match);
  });
});

// ---------------- Font size / word wrap controls ----------------
document.getElementById('font-dec').addEventListener('click', () => {
  fontSize = Math.max(10, fontSize - 2);
  editor.updateOptions({ fontSize });
});
document.getElementById('font-inc').addEventListener('click', () => {
  fontSize = Math.min(28, fontSize + 2);
  editor.updateOptions({ fontSize });
});
document.getElementById('wrap-toggle').addEventListener('click', () => {
  wrapOn = !wrapOn;
  editor.updateOptions({ wordWrap: wrapOn ? 'on' : 'off' });
  document.getElementById('wrap-toggle').textContent = wrapOn ? 'Wrap: On' : 'Wrap: Off';
});

// ---------------- Live preview ----------------
function joinPath(baseDir, rel) {
  let base = baseDir;
  let path = rel;
  if (rel.startsWith('/')) {
    base = ROOT;
    path = rel.slice(1);
  }
  const stack = base.split('/').filter(Boolean);
  path.split('/').forEach((seg) => {
    if (seg === '..') stack.pop();
    else if (seg !== '.' && seg !== '') stack.push(seg);
  });
  return '/' + stack.join('/');
}

function isLocalRef(src) {
  return src && !/^(https?:|data:|#|\/\/)/i.test(src);
}

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

document.getElementById('btn-preview').addEventListener('click', async () => {
  if (!activeTab) { alert('Open a file first.'); return; }
  if (!/\.html?$/i.test(activeTab)) { alert('Preview works on HTML files — open one first.'); return; }
  const htmlContent = openTabs[activeTab].model.getValue();
  const baseDir = activeTab.substring(0, activeTab.lastIndexOf('/'));
  let finalHtml;
  try {
    finalHtml = await buildPreviewHtml(htmlContent, baseDir);
  } catch (e) {
    finalHtml = htmlContent;
  }
  document.getElementById('preview-frame').srcdoc = finalHtml;
  document.getElementById('preview-panel').classList.remove('hidden');
});
document.getElementById('close-preview').addEventListener('click', () => {
  document.getElementById('preview-panel').classList.add('hidden');
});

document.getElementById('save-btn').addEventListener('click', saveActive);
document.getElementById('save-all-btn').addEventListener('click', saveAll);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); }
});

// ---------------- New file / project ----------------
document.getElementById('new-file-btn').addEventListener('click', async () => {
  const name = prompt(`New file path (relative to ${ROOT}), e.g. notes/todo.md:`);
  if (!name) return;
  const full = joinPath(ROOT, name);
  try {
    await FS().writeFile({ path: full, data: '', encoding: 'utf8', recursive: true });
  } catch (e) { alert('Could not create file: ' + e.message); return; }
  await renderTree(ROOT, document.getElementById('file-tree'));
  openFile(full);
});

document.getElementById('new-project-btn').addEventListener('click', async () => {
  const name = prompt(`New project name (created inside ${ROOT}):`);
  if (!name) return;
  const full = joinPath(ROOT, name);
  try {
    await FS().mkdir({ path: full, recursive: true });
  } catch (e) { alert('Could not create project: ' + e.message); return; }
  switchRoot(full);
});

document.getElementById('toggle-sidebar').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

window.addEventListener('beforeunload', (e) => {
  const hasDirty = Object.values(openTabs).some((t) => t.type === 'text' && t.dirty);
  if (hasDirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================================================
   app.js — file tree, tabs, and Monaco editor wiring.
   Reads/writes files natively via Capacitor's Filesystem plugin —
   no server, no Termux dependency. Requires the "All files access"
   permission, requested through the custom StoragePermission plugin.
   ============================================================ */

let editor;
const openTabs = {}; // absPath -> { model, dirty }
let activeTab = null;

const ROOT = '/storage/emulated/0';

function FS() { return Capacitor.Plugins.Filesystem; }
function StoragePermission() { return Capacitor.Plugins.StoragePermission; }

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  editor = monaco.editor.create(document.getElementById('editor-container'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: window.innerWidth > 700 },
    wordWrap: 'on',
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => {
    if (activeTab && openTabs[activeTab]) {
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

// ---------------- Permission gating ----------------
async function boot() {
  document.getElementById('root-path').textContent = ROOT;
  const { granted } = await StoragePermission().check();
  if (granted) {
    startEditor();
  } else {
    showPermissionGate();
  }
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
    item.textContent = (entry.isDir ? '📁 ' : '📄 ') + entry.name;

    if (entry.isDir) {
      let expanded = false;
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      childContainer.style.paddingLeft = '14px';
      childContainer.style.display = 'none';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = !expanded;
        childContainer.style.display = expanded ? 'block' : 'none';
        if (expanded) renderTree(full, childContainer);
      });
      container.appendChild(item);
      container.appendChild(childContainer);
    } else {
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
    let content;
    try {
      const res = await FS().readFile({ path: absPath, encoding: 'utf8' });
      content = res.data;
    } catch (e) { alert('Could not open file: ' + e.message); return; }
    const model = monaco.editor.createModel(content, langFromExt(absPath));
    openTabs[absPath] = { model, dirty: false };
  }
  activeTab = absPath;
  editor.setModel(openTabs[absPath].model);
  document.getElementById('empty-state').classList.add('hidden');
  renderBreadcrumb(absPath);
  renderTabs();
  if (window.innerWidth <= 700) document.getElementById('sidebar').classList.add('collapsed');
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
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTabs[p].model.dispose();
      delete openTabs[p];
      if (activeTab === p) {
        const remaining = Object.keys(openTabs);
        activeTab = remaining[0] || null;
        if (activeTab) { editor.setModel(openTabs[activeTab].model); renderBreadcrumb(activeTab); }
        else {
          editor.setModel(monaco.editor.createModel('', 'plaintext'));
          document.getElementById('empty-state').classList.remove('hidden');
          renderBreadcrumb(null);
        }
      }
      renderTabs();
    });
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => {
      activeTab = p;
      editor.setModel(openTabs[p].model);
      document.getElementById('empty-state').classList.add('hidden');
      renderBreadcrumb(p);
      renderTabs();
    });
    tabsEl.appendChild(tab);
  });
}

// ---------------- Save ----------------
async function saveActive() {
  if (!activeTab) return;
  const content = openTabs[activeTab].model.getValue();
  try {
    await FS().writeFile({ path: activeTab, data: content, encoding: 'utf8' });
  } catch (e) { alert('Save failed: ' + e.message); return; }
  openTabs[activeTab].dirty = false;
  renderTabs();
  flashSaved();
}

function flashSaved() {
  const btn = document.getElementById('save-btn');
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

// ---------------- Live preview ----------------
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
};

function joinPath(baseDir, rel) {
  if (rel.startsWith('/')) return rel; // already absolute
  const stack = baseDir.split('/').filter(Boolean);
  rel.split('/').forEach((seg) => {
    if (seg === '..') stack.pop();
    else if (seg !== '.' && seg !== '') stack.push(seg);
  });
  return '/' + stack.join('/');
}

function isLocalRef(src) {
  return src && !/^(https?:|data:|#|\/\/)/i.test(src);
}

async function inlineAsset(html, tagRegex, resolver) {
  let result = html;
  let match;
  const matches = [];
  while ((match = tagRegex.exec(html)) !== null) matches.push(match);
  for (const m of matches) {
    try {
      const replacement = await resolver(m);
      if (replacement !== null) result = result.replace(m[0], replacement);
    } catch (e) { /* leave original tag if the asset can't be read */ }
  }
  return result;
}

async function buildPreviewHtml(htmlContent, baseDir) {
  let html = htmlContent;

  // Inline <link rel="stylesheet" href="...">
  html = await inlineAsset(html, /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g, async (m) => {
    if (!isLocalRef(m[1])) return null;
    const abs = joinPath(baseDir, m[1]);
    const res = await FS().readFile({ path: abs, encoding: 'utf8' });
    return `<style>${res.data}</style>`;
  });

  // Inline <script src="...">
  html = await inlineAsset(html, /<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/g, async (m) => {
    if (!isLocalRef(m[1])) return null;
    const abs = joinPath(baseDir, m[1]);
    const res = await FS().readFile({ path: abs, encoding: 'utf8' });
    return `<script>${res.data}</script>`;
  });

  // Inline <img src="...">
  html = await inlineAsset(html, /<img[^>]+src=["']([^"']+)["']/g, async (m) => {
    if (!isLocalRef(m[1])) return null;
    const abs = joinPath(baseDir, m[1]);
    const ext = m[1].split('.').pop().toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    const res = await FS().readFile({ path: abs }); // no encoding => base64
    return m[0].replace(m[1], `data:${mime};base64,${res.data}`);
  });

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
    finalHtml = htmlContent; // fall back to unresolved HTML rather than blocking preview entirely
  }
  document.getElementById('preview-frame').srcdoc = finalHtml;
  document.getElementById('preview-panel').classList.remove('hidden');
});
document.getElementById('close-preview').addEventListener('click', () => {
  document.getElementById('preview-panel').classList.add('hidden');
});

document.getElementById('save-btn').addEventListener('click', saveActive);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); }
});

// ---------------- New file / folder ----------------
document.getElementById('new-file-btn').addEventListener('click', async () => {
  const name = prompt(`New file path (relative to ${ROOT}), e.g. notes/todo.md:`);
  if (!name) return;
  const full = `${ROOT}/${name}`;
  try {
    await FS().writeFile({ path: full, data: '', encoding: 'utf8', recursive: true });
  } catch (e) { alert('Could not create file: ' + e.message); return; }
  await renderTree(ROOT, document.getElementById('file-tree'));
  openFile(full);
});

document.getElementById('new-folder-btn').addEventListener('click', async () => {
  const name = prompt(`New folder path (relative to ${ROOT}):`);
  if (!name) return;
  const full = `${ROOT}/${name}`;
  try {
    await FS().mkdir({ path: full, recursive: true });
  } catch (e) { alert('Could not create folder: ' + e.message); return; }
  await renderTree(ROOT, document.getElementById('file-tree'));
});

document.getElementById('toggle-sidebar').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

window.addEventListener('beforeunload', (e) => {
  const hasDirty = Object.values(openTabs).some((t) => t.dirty);
  if (hasDirty) { e.preventDefault(); e.returnValue = ''; }
});

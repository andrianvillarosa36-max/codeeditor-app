# COODEV — standalone Android code editor

A real file editor for your phone, packaged as a self-contained APK.
No Termux, no background server required to use it — the app talks to
Android's storage directly using Capacitor's Filesystem plugin plus a
small native plugin that requests "All files access" (the same
permission real file manager apps use). Editing itself is powered by
Monaco, the same engine VS Code uses.

## Part 1 — Build the APK

Builds happen in the cloud via GitHub Actions (Android SDK is
pre-installed there), so nothing heavy needs installing on your phone.

**From Termux**, push this project to a GitHub repo:
```bash
cd ~/apps/codeeditor-app
git add -A
git commit -m "Update COODEV"
git push
```
(If this is a brand new repo you haven't pushed before: `git init`,
`git remote add origin <repo-url>`, then the commands above.)

Then on github.com → your repo → **Actions** tab, wait for the
"Build APK" run to finish (green check), open it, and download the
`coodev-debug-apk` artifact from **Artifacts**. Unzip it to get
`app-debug.apk`.

## Part 2 — Install it

Tap the APK on your phone, allow installs from that source if asked,
install. You'll get a **COODEV** app icon.

## Part 3 — First launch

The first time you open the app, it'll ask for storage access:

1. Tap **Grant Access** — opens Android's permission settings for the app.
2. Flip the **"Allow access to manage all files"** toggle on.
3. Go back to COODEV and tap **Continue**.

After that one-time step, the app opens straight into your phone's
storage (`/storage/emulated/0`) every time.

## Features

- **File tree** with type icons, a filter box, and a 🖼️ icon for
  images/assets folders. Long-press any file or folder for
  **Rename / Move to… / Delete**.
- **Tabs**, an Open Editors list, breadcrumbs, and an image viewer
  for png/jpg/gif/svg/webp files.
- **Live Preview** for HTML files — resolves linked CSS/JS/images
  automatically, with a 📱/🖥️ toggle to check mobile vs desktop
  widths.
- **Save** (active file) and **Save All** (every dirty tab).
- **Prettier-style formatting** — `Format` / `Format Document`, `Format Selection`,
  VS Code-style `Shift+Alt+F`, and optional **Format on Save**. JavaScript/JSX,
  TypeScript/TSX, JSON, HTML, CSS/SCSS, Markdown, and YAML use Prettier's
  browser formatter. **GDScript (`.gd`) has a built-in Godot-aware formatter**,
  including indentation, common operator/comma spacing, syntax highlighting,
  and `# fmt: off` / `# fmt: on` protected regions. Other languages fall back
  to Monaco when it has a formatter.
- **Copy / Cut / Paste** through the real Android clipboard (Command
  Palette, or a physical keyboard's usual shortcuts).
- **Go to File** (`Ctrl+P`) and **Commands** (`Ctrl+Shift+P`) — search
  by name or run any action by tap, no keyboard required.
- **Extra-keys row**: HOME/END/arrows/TAB, plus sticky SHIFT/CTRL
  toggles for select-by-arrow and jump-by-word.
- **Auto-closing tags**, and Emmet-style abbreviations on Tab:
  `!` → full HTML5 boilerplate, `tag.class#id` → that element
  (e.g. `nav.navbar` → `<nav class="navbar"></nav>`). This covers
  single elements, not full Emmet nesting like `ul>li*3`.
- **Insert Image…** — picks an image from your project and inserts
  the right reference for the file you're in (`<img>` in HTML,
  `url(...)` in CSS).
- **Local Server** — see below.

## Local Server

*Start Local Server* (Command Palette) launches a small embedded HTTP
server, serving whatever folder is your current project root at
`http://127.0.0.1:8091`. The URL is copied to your clipboard
automatically. This gives you a real server (not just the in-app
Preview) — useful for anything that behaves differently under `file://`
vs `http://`, or for pointing another tool at it.

Want it reachable from outside your phone (e.g. to show someone a
live link)? Termux can still tunnel it out — this is the one piece
that stays there, since bundling a tool like `cloudflared` directly
into the app means shipping a whole separate compiled binary per CPU
architecture, which is a different level of complexity than anything
else here:
```bash
pkg install cloudflared
cloudflared tunnel --url http://127.0.0.1:8091
```
*Stop Local Server* shuts it down.

## Notes

- Debug-signed APK — fine for your own phone, not Play-Store-ready
  as-is (needs a release signing key, and Play policy restricts this
  broad a storage permission without an approved use case).
- Monaco loads from a CDN on first open, so the very first launch
  needs internet; it typically keeps working offline after that via
  WebView caching, though that's not a guarantee the way a bundled
  offline copy would be.


### GDScript formatting

`.gd` files use the browser build of `pretty-gd-js` (v1.18.1), the formatter family used by the pretty.gd Godot/VS Code integration. If the formatter CDN is unavailable, COODEV falls back to its built-in GDScript formatter.

# Code Editor — standalone Android app

A real file editor for your phone, packaged as a self-contained APK.
No Termux, no background server — the app talks to Android's storage
directly using Capacitor's Filesystem plugin plus a small native
plugin that requests "All files access" (the same permission real
file manager apps use). Editing itself is powered by Monaco, the
same engine VS Code uses.

## Part 1 — Build the APK

Builds happen in the cloud via GitHub Actions (Android SDK is
pre-installed there), so nothing heavy needs installing on your phone.

**From Termux**, push this project to a GitHub repo:
```bash
cd ~/apps/codeeditor-app
git add -A
git commit -m "Standalone version — no Termux dependency"
git push
```
(If this is a brand new repo you haven't pushed before, see the full
`git init` / `git remote add` steps from earlier — same process.)

Then on github.com → your repo → **Actions** tab, wait for the
"Build APK" run to finish (green check), open it, and download the
`code-editor-debug-apk` artifact from **Artifacts**. Unzip it to get
`app-debug.apk`.

## Part 2 — Install it

Tap the APK on your phone, allow installs from that source if asked,
install. You'll get a **Code Editor** app icon.

## Part 3 — First launch

The first time you open the app, it'll ask for storage access:

1. Tap **Grant Access** — this opens Android's permission settings
   for the app.
2. Flip the **"Allow access to manage all files"** toggle on.
3. Go back to the Code Editor app and tap **Continue**.

After that one-time step, the app opens straight into your phone's
storage (`/storage/emulated/0`) every time — fully independent of
Termux, no server to start, nothing running in the background.

## Using it

- Tap a folder to expand it, tap a file to open it in a tab
- **Ctrl+S** (external keyboard) or the **Save** button writes the
  file back to disk for real
- **+ File** / **+ Folder** create new files/folders — give a path
  relative to your storage root (e.g. `Documents/notes/todo.md`)
- Tabs show a dot (●) when there are unsaved changes
- The ☰ button toggles the sidebar

## Notes

- This is a debug-signed APK — great for your own phone, not
  suitable for Play Store distribution as-is (needs a release
  signing key, and Play policy restricts apps requesting this broad
  a storage permission without a specific approved use case).
- Monaco still loads from a CDN on first open, so the very first
  launch needs internet; after the WebView caches it, it typically
  keeps working offline too, though this isn't guaranteed the way a
  proper offline bundle would be.
- If you ever want the old Termux-server version back (e.g. to run
  the editor from a laptop browser too), that's the separate
  `codeeditor` project — this app doesn't touch or depend on it.

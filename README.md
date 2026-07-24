# Code Editor — Android APK wrapper

This turns your Termux code editor into a real installable app icon.
The APK itself is a thin native shell (Capacitor) that opens straight
into `http://127.0.0.1:8090` — the same server you're already running
in Termux. All the real work (file access, editing, saving) still
happens through that server, which is exactly what gives it full
access to your phone's storage without extra native permission code.

## Part 1 — Build the APK (no Android Studio needed)

The build happens in the cloud via GitHub Actions, which has the
Android SDK pre-installed. You just need a free GitHub account. Your
app icon (the `</>` mark in `icons/`) gets applied automatically
during the build — nothing extra to do for that.

**On your phone, easiest via github.com in your browser** (the app
also works, but the web upload flow below is more reliable for
folders with hidden dotfiles like `.github/`):

1. Sign in at github.com, tap the **+** in the top right → **New
   repository**. Name it something like `codeeditor-app`, leave it
   Public or Private (either is fine), don't add a README (we already
   have one) → **Create repository**.
2. On the new repo's page, tap **uploading an existing file** (shown
   on the empty repo page, under "Quick setup").
3. From your file manager, select every file/folder inside this
   `codeeditor-app` folder — `package.json`, `capacitor.config.json`,
   `README.md`, `public/`, `icons/`, and `.github/` — and upload them
   all in that same batch. If your file picker won't show the hidden
   `.github` folder, unzip `codeeditor-app.zip` with a file manager
   that shows hidden files first (Termux's own `unzip` always
   preserves it — see the tip below).
4. Scroll down, tap **Commit changes**.
5. Go to the **Actions** tab. "Build APK" should already be running
   (it triggers on push to `main`). If you don't see a run, open the
   workflow on the left and tap **Run workflow**.
6. When it finishes (a few minutes — green checkmark), open the run
   and scroll to **Artifacts** at the bottom — tap
   `code-editor-debug-apk` to download it. It downloads as a zip;
   unzip it to get `app-debug.apk`.

**Tip for reliably keeping the `.github` folder:** if you'd rather
not fight your phone's file picker, do the upload from Termux instead
using `git`:
```bash
pkg install git
cd ~/apps/codeeditor-app
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/codeeditor-app.git
git push -u origin main
```
GitHub will prompt for a username + a **personal access token** (not
your password) — generate one at github.com → Settings → Developer
settings → Personal access tokens → Tokens (classic) → Generate new
token, with the `repo` scope checked.

## Part 2 — Install it on your phone

1. Transfer `app-debug.apk` to your phone if it isn't already there
   (downloading it via your phone's browser puts it in Downloads).
2. Tap the file. Android will ask to allow installs from that source
   the first time — allow it, then install.
3. You'll now have a **Code Editor** app icon like any other app.

## Part 3 — Make the Termux server start automatically

Right now you'd still need to manually run the server in Termux
before opening the app. Two ways to remove that step:

**Option A — Termux:Boot (starts on phone boot)**
```bash
pkg install termux-boot
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-editor.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd ~/apps/codeeditor
node server.js ~/storage/shared 8090
EOF
chmod +x ~/.termux/boot/start-editor.sh
```
Install the separate **Termux:Boot** app from F-Droid (same source as
Termux itself) and open it once so it's allowed to run at boot.

**Option B — Termux:Widget (tap a home-screen shortcut to start it)**
```bash
pkg install termux-widget
mkdir -p ~/.shortcuts
cat > ~/.shortcuts/start-editor.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd ~/apps/codeeditor
node server.js ~/storage/shared 8090
EOF
chmod +x ~/.shortcuts/start-editor.sh
```
Install **Termux:Widget** from F-Droid, then add its widget to your
home screen — it'll show "start-editor" as a tappable shortcut.

Either way: once the server's running in the background, tapping the
**Code Editor** app opens straight into your files.

## Notes

- This is a debug-signed APK — fine for installing on your own phone,
  but not suitable for Play Store distribution as-is (that needs a
  release signing key and a privacy review, since Play Store also
  restricts this kind of broad local-network app pattern).
- If the app shows "Waiting for the Termux server…", the server isn't
  running yet — start it via Termux or your Boot/Widget shortcut.
- Want it to look more like a real app icon instead of the default
  Capacitor icon? Drop a 1024×1024 PNG at
  `android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png` (and the
  other mipmap sizes) after the Android project is generated, or ask
  and I can generate a full icon set for you.

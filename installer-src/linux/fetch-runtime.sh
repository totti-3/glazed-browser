#!/bin/sh
# Glazed: downloads the official Electron (Chromium) runtime, verifies its SHA-256 and puts the app next to it.
# Run automatically after installation. Re-run manually with:  sudo /opt/glazed/fetch-runtime.sh
set -u
ROOT=/opt/glazed
RT="$ROOT/runtime"
VER="33.2.0"
SHA="fc9e2a5f969d0fcf7546eb3299a2450329ba4f05c1baa4f0ed7b269b45e2232b"
URL="https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-linux-x64.zip"

if [ "$(id -u)" != "0" ]; then echo "Please run as root: sudo $0" >&2; exit 1; fi
if [ "$(uname -m)" != "x86_64" ]; then echo "Glazed supports x86_64 only (found $(uname -m))." >&2; exit 1; fi

if [ ! -x "$RT/glazed" ] || [ "$(cat "$RT/.version" 2>/dev/null)" != "$VER" ]; then
  echo "Glazed: downloading the Chromium runtime (about 105 MB, one time only)..."
  ZIP="$(mktemp /var/tmp/glazed-electron-XXXXXX.zip)" || exit 1
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$ZIP" "$URL" || { echo "Download failed." >&2; rm -f "$ZIP"; exit 1; }
  elif command -v wget >/dev/null 2>&1; then wget -O "$ZIP" "$URL" || { echo "Download failed." >&2; rm -f "$ZIP"; exit 1; }
  else echo "Please install curl or wget." >&2; rm -f "$ZIP"; exit 1; fi
  GOT="$(sha256sum "$ZIP" | cut -d' ' -f1)"
  if [ "$GOT" != "$SHA" ]; then echo "Checksum mismatch - download corrupted. Run $0 again." >&2; rm -f "$ZIP"; exit 1; fi
  rm -rf "$RT"; mkdir -p "$RT"
  if command -v unzip >/dev/null 2>&1; then unzip -q "$ZIP" -d "$RT"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$ZIP" "$RT" <<'PY'
import sys, zipfile, os
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    p = z.extract(i, sys.argv[2])
    m = (i.external_attr >> 16) & 0o7777
    if m: os.chmod(p, m)
PY
  else echo "Please install unzip or python3." >&2; rm -f "$ZIP"; rm -rf "$RT"; exit 1; fi
  rm -f "$ZIP"
  mv "$RT/electron" "$RT/glazed" || exit 1
  rm -f "$RT/resources/default_app.asar"
  chmod 755 "$RT/glazed" "$RT/chrome_crashpad_handler" 2>/dev/null
  echo "$VER" > "$RT/.version"
fi

# Electron only runs an app located in <runtime>/resources/app
rm -rf "$RT/resources/app"
cp -r "$ROOT/app" "$RT/resources/app" || exit 1
# Chromium sandbox helper needs to be setuid root
if [ -f "$RT/chrome-sandbox" ]; then chown root:root "$RT/chrome-sandbox"; chmod 4755 "$RT/chrome-sandbox"; fi
echo "Glazed: ready. Start it from your application menu or with:  glazed"
exit 0

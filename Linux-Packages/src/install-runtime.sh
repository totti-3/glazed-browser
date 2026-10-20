#!/bin/sh
# Downloads the official Electron (Chromium) runtime that Glazed runs on, verifies its
# SHA-256 checksum and sets it up in /opt/glazed/runtime. Run automatically after
# installing the package; run it again manually (sudo) if the download failed.
set -u
ROOT=/opt/glazed
RT="$ROOT/runtime"
VER="33.2.0"
SHA="fc9e2a5f969d0fcf7546eb3299a2450329ba4f05c1baa4f0ed7b269b45e2232b"
URL="https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-linux-x64.zip"

if [ "$(uname -m)" != "x86_64" ]; then echo "Glazed: only x86_64 is supported (found $(uname -m))." >&2; exit 1; fi

if [ ! -x "$RT/glazed" ]; then
  echo "Glazed: downloading the Chromium runtime (about 105 MB, one time only)..."
  TMP="$(mktemp -d)" || exit 1
  trap 'rm -rf "$TMP"' EXIT
  ZIP="$TMP/electron.zip"
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$ZIP" "$URL" || { echo "Glazed: download failed." >&2; exit 1; }
  elif command -v wget >/dev/null 2>&1; then wget -O "$ZIP" "$URL" || { echo "Glazed: download failed." >&2; exit 1; }
  else echo "Glazed: please install curl or wget." >&2; exit 1; fi
  GOT="$(sha256sum "$ZIP" | cut -d' ' -f1)"
  if [ "$GOT" != "$SHA" ]; then echo "Glazed: checksum mismatch, download discarded." >&2; exit 1; fi
  rm -rf "$RT.new"; mkdir -p "$RT.new"
  if command -v unzip >/dev/null 2>&1; then unzip -q "$ZIP" -d "$RT.new"
  elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$RT.new"
  else echo "Glazed: please install unzip or python3." >&2; exit 1; fi
  mv "$RT.new/electron" "$RT.new/glazed" || exit 1
  rm -f "$RT.new/resources/default_app.asar"
  chmod 755 "$RT.new/glazed" "$RT.new/chrome_crashpad_handler" 2>/dev/null
  # the Chromium sandbox helper must be owned by root and setuid
  chown root:root "$RT.new/chrome-sandbox" 2>/dev/null && chmod 4755 "$RT.new/chrome-sandbox" 2>/dev/null
  rm -rf "$RT"; mv "$RT.new" "$RT" || exit 1
fi

# Electron only runs an app located in <runtime>/resources/app: refresh it from the package
rm -rf "$RT/resources/app"
cp -r "$ROOT/app" "$RT/resources/app" || exit 1
[ -f "$RT/resources/app/main.js" ] || { echo "Glazed: app files missing." >&2; exit 1; }
echo "Glazed: ready."

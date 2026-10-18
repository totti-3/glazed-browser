#!/usr/bin/env bash
# Glazed launcher for Linux (x64). First run downloads the official Electron (Chromium)
# runtime from GitHub, verifies its SHA-256 checksum, then starts Glazed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT="$ROOT/runtime"
EXE="$RT/glazed"
VER="33.2.0"
SHA="fc9e2a5f969d0fcf7546eb3299a2450329ba4f05c1baa4f0ed7b269b45e2232b"
URL="https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-linux-x64.zip"
LOG="$ROOT/glazed-start.log"

if [ "$(uname -m)" != "x86_64" ]; then
  echo "This launcher supports x86_64 only (found $(uname -m))." >&2; exit 1
fi

if [ ! -x "$EXE" ]; then
  echo "First start: downloading the Chromium runtime (about 105 MB, one time only)..."
  ZIP="$(mktemp -t electron-XXXXXX.zip)"
  if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar -o "$ZIP" "$URL" || { echo "Download failed." >&2; rm -f "$ZIP"; exit 1; }
  elif command -v wget >/dev/null 2>&1; then wget -O "$ZIP" "$URL" || { echo "Download failed." >&2; rm -f "$ZIP"; exit 1; }
  else echo "Please install curl or wget." >&2; exit 1; fi

  GOT="$(sha256sum "$ZIP" | cut -d' ' -f1)"
  if [ "$GOT" != "$SHA" ]; then echo "Checksum mismatch - download corrupted. Please try again." >&2; rm -f "$ZIP"; exit 1; fi

  rm -rf "$RT"; mkdir -p "$RT"
  if command -v unzip >/dev/null 2>&1; then unzip -q "$ZIP" -d "$RT"
  elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$RT"
  else echo "Please install unzip or python3." >&2; rm -f "$ZIP"; exit 1; fi
  rm -f "$ZIP"
  mv "$RT/electron" "$EXE"
  rm -f "$RT/resources/default_app.asar"
  chmod +x "$EXE" "$RT/chrome_crashpad_handler" 2>/dev/null
fi

# Electron only runs an app located in <runtime>/resources/app, so mirror our app folder there on every start
rm -rf "$RT/resources/app"
cp -r "$ROOT/app" "$RT/resources/app"
[ -f "$RT/resources/app/main.js" ] || { echo "Could not copy the app files." >&2; exit 1; }

start() {
  : > "$LOG"
  nohup "$EXE" --enable-logging --log-file="$LOG" "$@" >>"$LOG" 2>&1 &
  PID=$!
  sleep 7
  kill -0 "$PID" 2>/dev/null
}

# Try normal mode, then without the Chromium sandbox (needed where unprivileged user namespaces are disabled),
# then in safe graphics mode.
if start; then exit 0; fi
echo "Glazed closed right after start. Retrying without the sandbox..."
if start --no-sandbox; then exit 0; fi
echo "Retrying in safe graphics mode..."
if start --no-sandbox --disable-gpu; then exit 0; fi

echo
echo "Glazed could not start. Last log lines ($LOG):"
tail -n 20 "$LOG"
CRASH="${XDG_CONFIG_HOME:-$HOME/.config}/Glazed/crash.log"
[ -f "$CRASH" ] && { echo "--- crash.log ---"; tail -n 15 "$CRASH"; }
exit 1

#!/bin/sh
# Glazed launcher (/usr/bin/glazed)
D=/opt/glazed
EXE="$D/runtime/glazed"
if [ ! -x "$EXE" ]; then
  if [ "$(id -u)" = 0 ]; then
    "$D/install-runtime.sh" || exit 1
  else
    MSG="Glazed's runtime is not installed yet. Run:  sudo $D/install-runtime.sh"
    echo "$MSG" >&2
    command -v notify-send >/dev/null 2>&1 && notify-send "Glazed" "$MSG"
    exit 1
  fi
fi
# Without a setuid sandbox helper (e.g. nosuid mount) Chromium needs unprivileged user namespaces
if [ ! -u "$D/runtime/chrome-sandbox" ]; then set -- --no-sandbox "$@"; fi
exec "$EXE" "$@"

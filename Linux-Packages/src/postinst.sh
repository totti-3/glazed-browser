#!/bin/sh
chmod 755 /opt/glazed/install-runtime.sh /opt/glazed/glazed.sh 2>/dev/null
/opt/glazed/install-runtime.sh || echo "Glazed: runtime setup did not finish. Connect to the internet and run: sudo /opt/glazed/install-runtime.sh" >&2
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications 2>/dev/null
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t /usr/share/icons/hicolor 2>/dev/null
exit 0

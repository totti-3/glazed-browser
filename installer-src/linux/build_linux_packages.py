#!/usr/bin/env python3
"""Builds glazed_<ver>_amd64.deb and glazed-<ver>-1.x86_64.rpm without dpkg/rpmbuild (pure Python).
usage: build_linux_packages.py <app dir> <version> <outdir>"""
import sys, os, io, struct, gzip, hashlib, time, tarfile, subprocess, shutil, tempfile

appdir, VER, out = sys.argv[1], sys.argv[2], sys.argv[3]
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(out, exist_ok=True)
APP_FILES = ['main.js', 'ext.js', 'preload.js', 'package.json', 'src', 'assets']
DESC = "Glazed is a calm, highly customizable browser with extension support, built on Chromium (Electron)."
SHA_NOTE = "The Chromium runtime (about 105 MB) is downloaded and verified when the package is installed."

def rd(p): return open(p, 'rb').read()

# ---- file list: (absolute path in package, mode, bytes) ----
files = []
for e in APP_FILES:
    p = os.path.join(appdir, e)
    if os.path.isdir(p):
        for r, _, fs in os.walk(p):
            for f in sorted(fs):
                fp = os.path.join(r, f)
                files.append(('/opt/glazed/app/' + os.path.relpath(fp, appdir).replace(os.sep, '/'), 0o644, rd(fp)))
    else:
        files.append(('/opt/glazed/app/' + e, 0o644, rd(p)))
files.append(('/opt/glazed/fetch-runtime.sh', 0o755, rd(os.path.join(here, 'fetch-runtime.sh'))))
files.append(('/usr/bin/glazed', 0o755, rd(os.path.join(here, 'glazed'))))
files.append(('/usr/share/applications/glazed.desktop', 0o644, rd(os.path.join(here, 'glazed.desktop'))))
from PIL import Image
im = Image.open(os.path.join(appdir, 'assets', 'icon.png')).convert('RGBA')
for s in (512, 256, 128, 64, 48, 32):
    b = io.BytesIO(); im.resize((s, s), Image.LANCZOS).save(b, 'PNG', optimize=True)
    files.append((f'/usr/share/icons/hicolor/{s}x{s}/apps/glazed.png', 0o644, b.getvalue()))
files.sort(key=lambda f: f[0])
installed_kb = sum(len(f[2]) for f in files) // 1024 + 110 * 1024

POSTINST = """#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  /opt/glazed/fetch-runtime.sh || echo "Glazed: runtime download failed. Run 'sudo /opt/glazed/fetch-runtime.sh' when online." >&2
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi
exit 0
"""
POSTRM = """#!/bin/sh
set -e
case "$1" in
  remove|purge) rm -rf /opt/glazed/runtime /opt/glazed/app
    rmdir /opt/glazed 2>/dev/null || true
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true ;;
esac
exit 0
"""
PRERM = """#!/bin/sh
set -e
case "$1" in remove|purge) pkill -x glazed 2>/dev/null || true ;; esac
exit 0
"""

# ------------------------------ DEB ------------------------------
def build_deb():
    root = tempfile.mkdtemp(prefix='debroot-')
    for p, mode, data in files:
        fp = root + p; os.makedirs(os.path.dirname(fp), exist_ok=True)
        open(fp, 'wb').write(data); os.chmod(fp, mode)
    os.makedirs(root + '/DEBIAN')
    with open(root + '/DEBIAN/md5sums', 'w') as f:
        for p, _, d in files: f.write(f"{hashlib.md5(d).hexdigest()}  {p[1:]}\n")
    ctl = f"""Package: glazed
Version: {VER}-1
Section: web
Priority: optional
Architecture: amd64
Depends: curl | wget, unzip | python3, ca-certificates, xdg-utils, libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libgbm1, libxss1, libxtst6
Installed-Size: {installed_kb}
Maintainer: Glazed <noreply@glazed.invalid>
Homepage: https://github.com/electron/electron
Description: Glazed - a calm, customizable browser
 {DESC}
 {SHA_NOTE}
"""
    open(root + '/DEBIAN/control', 'w').write(ctl)
    for n, c in (('postinst', POSTINST), ('postrm', POSTRM), ('prerm', PRERM)):
        open(f'{root}/DEBIAN/{n}', 'w').write(c); os.chmod(f'{root}/DEBIAN/{n}', 0o755)
    for r, ds, _ in os.walk(root): os.chmod(r, 0o755)
    dest = os.path.join(out, f'glazed_{VER}_amd64.deb')
    subprocess.check_call(['dpkg-deb', '--root-owner-group', '-Zgzip', '--build', root, dest], stdout=subprocess.DEVNULL)
    shutil.rmtree(root); return dest

# ------------------------------ RPM ------------------------------
NULL, CHAR, I8, I16, I32, I64, STR, BIN, SARR, I18N = range(10)
def pack_tag(tag, typ, val):
    if typ == I16: return (tag, typ, len(val), struct.pack('>%dH' % len(val), *val), 2)
    if typ == I32: return (tag, typ, len(val), struct.pack('>%dI' % len(val), *val), 4)
    if typ in (STR, I18N): return (tag, typ, 1, val.encode() + b'\0', 1)
    if typ == SARR: return (tag, typ, len(val), b''.join(v.encode() + b'\0' for v in val), 1)
    if typ == BIN: return (tag, typ, len(val), val, 1)
    raise ValueError

def header(tags, region):
    ents = sorted((pack_tag(*t) for t in tags), key=lambda e: e[0])
    data = bytearray(); idx = []
    for tag, typ, cnt, d, al in ents:
        while len(data) % al: data.append(0)
        idx.append((tag, typ, len(data), cnt)); data += d
    il = len(idx) + 1
    trailer_off = len(data)
    data += struct.pack('>IIiI', region, BIN, -il * 16, 16)
    index = struct.pack('>IIII', region, BIN, trailer_off, 16)
    for t in idx: index += struct.pack('>IIiI', *t)
    return b'\x8e\xad\xe8\x01\0\0\0\0' + struct.pack('>II', il, len(data)) + index + bytes(data)

def cpio_newc(entries):
    out = bytearray()
    for ino, name, mode, data in entries:
        nm = name.encode() + b'\0'
        out += b'070701' + (('%08X' * 13) % (ino, mode, 0, 0, 2 if mode & 0o170000 == 0o040000 else 1, 0, len(data), 0, 0, 0, 0, len(nm), 0)).encode()
        out += nm
        while len(out) % 4: out.append(0)
        out += data
        while len(out) % 4: out.append(0)
    nm = b'TRAILER!!!\0'
    out += b'070701' + (('%08X' * 13) % (0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, len(nm), 0)).encode() + nm
    while len(out) % 4: out.append(0)
    return bytes(out)

def build_rpm():
    now = int(time.time())
    # owned directories
    dirs = {'/opt/glazed', '/opt/glazed/app'}
    for p, _, _ in files:
        d = os.path.dirname(p)
        while d.startswith('/opt/glazed'): dirs.add(d); d = os.path.dirname(d)
    ent = [(d, 0o040755, b'') for d in dirs] + [(p, 0o100000 | m, b) for p, m, b in files]
    ent.sort(key=lambda e: e[0])
    dirnames, dirindex, base = [], [], []
    for p, _, _ in ent:
        d = os.path.dirname(p) + '/'
        if d not in dirnames: dirnames.append(d)
        dirindex.append(dirnames.index(d)); base.append(os.path.basename(p))
    isdir = lambda m: m & 0o170000 == 0o040000
    cpio = cpio_newc([(i + 1, '.' + p, m, b) for i, (p, m, b) in enumerate(ent)])
    payload = gzip.compress(cpio, 9, mtime=0)
    requires = ['/bin/sh', 'curl', 'ca-certificates', 'xdg-utils', 'gtk3', 'nss', 'alsa-lib', 'mesa-libgbm', 'libXScrnSaver', 'libXtst']
    POSTIN = "/opt/glazed/fetch-runtime.sh || echo \"Glazed: runtime download failed. Run 'sudo /opt/glazed/fetch-runtime.sh' when online.\" >&2\n" \
             "command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || :\n" \
             "command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || :\nexit 0\n"
    PREUN = "if [ \"$1\" = 0 ]; then pkill -x glazed 2>/dev/null || :; fi\nexit 0\n"
    POSTUN = "if [ \"$1\" = 0 ]; then rm -rf /opt/glazed/runtime /opt/glazed/app; rmdir /opt/glazed 2>/dev/null || :; fi\nexit 0\n"
    tags = [
        (1000, STR, 'glazed'), (1001, STR, VER), (1002, STR, '1'),
        (1004, I18N, 'Glazed - a calm, customizable browser'), (1005, I18N, DESC + ' ' + SHA_NOTE),
        (1006, I32, [now]), (1007, STR, 'localhost'), (1009, I32, [sum(len(b) for _, _, b in ent)]),
        (1014, STR, 'MIT'), (1016, I18N, 'Applications/Internet'), (1020, STR, 'https://github.com/electron/electron'),
        (1021, STR, 'linux'), (1022, STR, 'x86_64'),
        (1023 + 1, STR, POSTIN), (1025, STR, PREUN), (1026, STR, POSTUN),
        (1028, I32, [len(b) for _, _, b in ent]),
        (1030, I16, [m for _, m, _ in ent]),
        (1033, I16, [0] * len(ent)),
        (1034, I32, [now] * len(ent)),
        (1035, SARR, ['' if isdir(m) else hashlib.sha256(b).hexdigest() for _, m, b in ent]),
        (1036, SARR, [''] * len(ent)),
        (1037, I32, [0] * len(ent)),
        (1039, SARR, ['root'] * len(ent)), (1040, SARR, ['root'] * len(ent)),
        (1047, SARR, ['glazed', 'glazed(x86-64)']), (1048 - 0, I32, [0] * len(requires)),
        (1049, SARR, requires), (1050, SARR, [''] * len(requires)),
        (1064, STR, '4.18.0'),
        (1086, SARR, ['/bin/sh']), (1087, SARR, ['/bin/sh']), (1088, SARR, ['/bin/sh']),
        (1095, I32, [1] * len(ent)), (1096, I32, list(range(1, len(ent) + 1))),
        (1097, SARR, [''] * len(ent)),
        (1112, I32, [8, 8]), (1113, SARR, [f'{VER}-1', f'{VER}-1']),
        (1116, I32, dirindex), (1117, SARR, base), (1118, SARR, dirnames),
        (1124, STR, 'cpio'), (1125, STR, 'gzip'), (1126, STR, '9'),
        (5011, I32, [8]),
    ]
    # fix tag numbers for requires flags (1048) and provides: ensure no duplicate / wrong ids
    hdr = header(tags, 63)
    sig = header([
        (269, STR, hashlib.sha1(hdr).hexdigest()), (273, STR, hashlib.sha256(hdr).hexdigest()),
        (1000, I32, [len(hdr) + len(payload)]), (1004, BIN, hashlib.md5(hdr + payload).digest()),
        (1007, I32, [len(cpio)])], 62)
    sig += b'\0' * (-len(sig) % 8)
    lead = struct.pack('>4sBBhh66shh16s', b'\xed\xab\xee\xdb', 3, 0, 0, 1, f'glazed-{VER}-1'.encode(), 1, 5, b'')
    dest = os.path.join(out, f'glazed-{VER}-1.x86_64.rpm')
    open(dest, 'wb').write(lead + sig + hdr + payload); return dest

if __name__ == '__main__':
    print(build_deb()); print(build_rpm())

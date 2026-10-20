#!/usr/bin/env python3
"""Builds glazed_<ver>_amd64.deb and glazed-<ver>-1.x86_64.rpm (no rpmbuild needed).
usage: build-linux-packages.py <app dir> <outdir> [version]"""
import os, sys, io, struct, gzip, hashlib, subprocess, shutil, time, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[1]); OUT = os.path.abspath(sys.argv[2])
VER = sys.argv[3] if len(sys.argv) > 3 else "1.3.2"
SUMMARY = "Glazed - a quiet, customizable browser"
DESC = ("Glazed is a customizable Chromium-based browser with themes, extension support and\n"
        "quality-of-life features. The Chromium (Electron) runtime is downloaded and verified\n"
        "(SHA-256) from GitHub during installation.")
def rd(n): return open(os.path.join(HERE, n), 'rb').read()

# ---------- file tree: path -> (mode, data|None, symlink target|None) ----------
files = {}
def addf(p, data, mode=0o644): files[p] = (0o100000 | mode, data, None)
def addd(p): files[p] = (0o040755, None, None)
def adds(p, t): files[p] = (0o120777, None, t)
addd('/opt/glazed'); addd('/opt/glazed/app')
for item in ('main.js', 'ext.js', 'preload.js', 'package.json', 'src', 'assets'):
    full = os.path.join(APP, item)
    if os.path.isdir(full):
        addd('/opt/glazed/app/' + item)
        for r, ds, fs in os.walk(full):
            for d in ds: addd('/opt/glazed/app/' + os.path.relpath(os.path.join(r, d), APP))
            for f in fs: addf('/opt/glazed/app/' + os.path.relpath(os.path.join(r, f), APP), open(os.path.join(r, f), 'rb').read())
    else: addf('/opt/glazed/app/' + item, open(full, 'rb').read())
addf('/opt/glazed/install-runtime.sh', rd('install-runtime.sh'), 0o755)
addf('/opt/glazed/glazed.sh', rd('glazed.sh'), 0o755)
adds('/usr/bin/glazed', '/opt/glazed/glazed.sh')
addf('/usr/share/applications/glazed.desktop', rd('glazed.desktop'))
src = Image.open(os.path.join(APP, 'assets', 'icon.png')).convert('RGBA')
for s in (48, 128, 256, 512):
    b = io.BytesIO(); src.resize((s, s), Image.LANCZOS).save(b, 'PNG', optimize=True)
    addf(f'/usr/share/icons/hicolor/{s}x{s}/apps/glazed.png', b.getvalue())
POSTINST = rd('postinst.sh').decode()
POSTRM_BODY = ('rm -rf /opt/glazed\n'
               'command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications 2>/dev/null\n'
               'command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t /usr/share/icons/hicolor 2>/dev/null\nexit 0\n')
NOW = int(time.time())

# ---------------------------------- .deb ----------------------------------
def build_deb():
    root = tempfile.mkdtemp(prefix='debroot-')
    for p, (mode, data, tgt) in sorted(files.items()):
        fp = root + p
        if mode & 0o170000 == 0o040000: os.makedirs(fp, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            if tgt: os.symlink(tgt, fp)
            else:
                open(fp, 'wb').write(data); os.chmod(fp, mode & 0o7777)
    for d, _, _ in os.walk(root): os.chmod(d, 0o755)
    size = sum(len(d) for _, d, _ in files.values() if d) // 1024
    os.makedirs(root + '/DEBIAN')
    open(root + '/DEBIAN/control', 'w').write(f"""Package: glazed
Version: {VER}
Section: web
Priority: optional
Architecture: amd64
Installed-Size: {size}
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libxss1, libxtst6, xdg-utils, ca-certificates, curl | wget, unzip | python3
Maintainer: Glazed <noreply@glazed.invalid>
Description: {SUMMARY}
 Glazed is a customizable Chromium-based browser with themes, extension
 support and quality-of-life features. The Chromium (Electron) runtime is
 downloaded and verified (SHA-256) from GitHub during installation.
""")
    open(root + '/DEBIAN/postinst', 'w').write("#!/bin/sh\nset -e\nif [ \"$1\" = configure ]; then\n" + POSTINST.replace('#!/bin/sh\n', '').replace('exit 0\n', '') + "fi\nexit 0\n")
    open(root + '/DEBIAN/postrm', 'w').write("#!/bin/sh\nif [ \"$1\" = remove ] || [ \"$1\" = purge ]; then\n" + POSTRM_BODY.replace('exit 0\n', '') + "fi\nexit 0\n")
    for s in ('postinst', 'postrm'): os.chmod(f'{root}/DEBIAN/{s}', 0o755)
    os.makedirs(OUT, exist_ok=True)
    out = f'{OUT}/glazed_{VER}_amd64.deb'
    subprocess.check_call(['dpkg-deb', '--root-owner-group', '-Zxz', '--build', root, out], stdout=subprocess.DEVNULL)
    shutil.rmtree(root); return out

# ---------------------------------- .rpm ----------------------------------
def entry(t, count, data): return (t, count, data)
def i16(v): return (3, len(v), struct.pack('>%dH' % len(v), *v))
def i32(v): return (4, len(v), struct.pack('>%dI' % len(v), *[x & 0xffffffff for x in v]))
def st(s): return (6, 1, s.encode() + b'\0')
def sa(v): return (8, len(v), b''.join(x.encode() + b'\0' for x in v))
def bn(b): return (7, len(b), b)

def header(entries, region):
    data = bytearray(); idx = []
    for tag in sorted(entries):
        t, c, d = entries[tag]
        if t == 3 and len(data) % 2: data += b'\0'
        if t == 4 and len(data) % 4: data += b'\0'
        idx.append((tag, t, len(data), c)); data += d
    n = len(idx) + 1
    trailer_off = len(data)
    data += struct.pack('>IIiI', region, 7, -(16 * n), 16)
    out = b'\x8e\xad\xe8\x01\0\0\0\0' + struct.pack('>II', n, len(data))
    out += struct.pack('>IIiI', region, 7, trailer_off, 16)
    for tag, t, o, c in idx: out += struct.pack('>IIiI', tag, t, o, c)
    return out + bytes(data)

def build_rpm():
    order = sorted(files)
    # payload (cpio newc)
    cp = io.BytesIO(); total = 0
    def cpio(name, mode, data, ino, nlink):
        nm = name.encode() + b'\0'
        h = b'070701' + b''.join(b'%08X' % v for v in (ino, mode, 0, 0, nlink, NOW, len(data), 0, 0, 0, 0, len(nm), 0))
        cp.write(h + nm); cp.write(b'\0' * ((4 - (len(h) + len(nm)) % 4) % 4))
        cp.write(data); cp.write(b'\0' * ((4 - len(data) % 4) % 4))
    dirs = []; dirindex = []; base = []; sizes = []; modes = []; digs = []; links = []
    for n, p in enumerate(order, 1):
        mode, data, tgt = files[p]
        d, b = p.rsplit('/', 1); d += '/'
        if d not in dirs: dirs.append(d)
        dirindex.append(dirs.index(d)); base.append(b); modes.append(mode & 0xffff)
        if mode & 0o170000 == 0o040000: body = b''; sizes.append(4096); digs.append(''); links.append(''); nl = 2
        elif tgt: body = tgt.encode(); sizes.append(len(body)); digs.append(''); links.append(tgt); nl = 1
        else: body = data; sizes.append(len(body)); digs.append(hashlib.sha256(body).hexdigest()); links.append(''); nl = 1
        total += len(body) if not (mode & 0o170000 == 0o040000) else 0
        cpio('.' + p, mode, body, n, nl)
    cpio('TRAILER!!!', 0, b'', 0, 1)
    raw = cp.getvalue()
    payload = gzip.compress(raw, 9, mtime=0)
    nf = len(order)
    req = ['/bin/sh', 'libgtk-3.so.0()(64bit)', 'libnss3.so()(64bit)', 'libasound.so.2()(64bit)', 'libXss.so.1()(64bit)', 'libXtst.so.6()(64bit)', 'xdg-utils']
    prov = ['glazed', 'glazed(x86-64)']
    postun = ('if [ "$1" = 0 ]; then\n' + POSTRM_BODY.replace('exit 0\n', '') + 'fi\nexit 0\n')
    h = {
        100: st('C'),
        1000: st('glazed'), 1001: st(VER), 1002: st('1'),
        1004: st(SUMMARY), 1005: st(DESC), 1006: i32([NOW]), 1007: st('glazed-build'),
        1009: i32([total]), 1014: st('Proprietary'), 1016: st('Applications/Internet'),
        1021: st('linux'), 1022: st('x86_64'),
        1024: st(POSTINST), 1086: st('/bin/sh'), 1026: st(postun), 1088: st('/bin/sh'),
        1028: i32(sizes), 1030: i16(modes), 1033: i16([0] * nf), 1034: i32([NOW] * nf),
        1035: sa(digs), 1036: sa(links), 1037: i32([0] * nf),
        1039: sa(['root'] * nf), 1040: sa(['root'] * nf), 1044: st(f'glazed-{VER}-1.src.rpm'),
        1045: i32([-1] * nf), 1047: sa(prov), 1048: i32([0] * len(req)), 1049: sa(req), 1050: sa([''] * len(req)),
        1095: i32([1] * nf), 1096: i32(list(range(1, nf + 1))), 1097: sa([''] * nf),
        1112: i32([0] * len(prov)), 1113: sa([VER + '-1'] * len(prov)),
        1116: i32(dirindex), 1117: sa(base), 1118: sa(dirs),
        1124: st('cpio'), 1125: st('gzip'), 1126: st('9'),
        5011: i32([8] * nf), 5092: sa([hashlib.sha256(payload).hexdigest()]), 5093: i32([8]),
    }
    hb = header(h, 63)
    sig = {
        1000: i32([len(hb) + len(payload)]),
        1004: bn(hashlib.md5(hb + payload).digest()),
        1007: i32([len(raw)]),
        269: st(hashlib.sha1(hb).hexdigest()),
        273: st(hashlib.sha256(hb).hexdigest()),
    }
    sb = header(sig, 62)
    sb += b'\0' * ((8 - len(sb) % 8) % 8)
    name = f'glazed-{VER}-1'.encode()[:65]
    lead = b'\xed\xab\xee\xdb\x03\x00\x00\x00\x00\x01' + name + b'\0' * (66 - len(name)) + b'\x00\x01\x00\x05' + b'\0' * 16
    os.makedirs(OUT, exist_ok=True)
    out = f'{OUT}/glazed-{VER}-1.x86_64.rpm'
    open(out, 'wb').write(lead + sb + hb + payload)
    return out

for f in (build_deb(), build_rpm()): print(f, os.path.getsize(f))

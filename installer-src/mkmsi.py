#!/usr/bin/env python3
"""Minimal MSI (Windows Installer) writer: OLE compound file + MSI database tables.
Format details follow MS-CFB and the layout used by rust-msi (MIT)."""
import struct, uuid, sys, time, datetime

ENDOFCHAIN, FREESECT, FATSECT, DIFSECT, NOSTREAM = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD, 0xFFFFFFFC, 0xFFFFFFFF

# ------------------------------------------------------------------ CFB writer
def _cmp_key(name):  # directory sibling ordering: shorter first, then uppercase UTF-16 code units
    return (len(name), name.upper())

def build_cfb(streams, root_clsid):
    SEC, MINI = 512, 64
    items = sorted(streams.items(), key=lambda kv: _cmp_key(kv[0]))
    names = [n for n, _ in items]
    # --- classify streams
    small = [(n, d) for n, d in items if len(d) < 4096]
    large = [(n, d) for n, d in items if len(d) >= 4096]
    # mini stream + mini FAT
    mini_data = bytearray(); mini_fat = []; mini_start = {}
    for n, d in small:
        cnt = (len(d) + MINI - 1) // MINI
        if cnt == 0:
            mini_start[n] = ENDOFCHAIN; continue
        first = len(mini_fat)
        mini_start[n] = first
        for i in range(cnt):
            mini_fat.append(first + i + 1 if i < cnt - 1 else ENDOFCHAIN)
        mini_data += d + b'\0' * (cnt * MINI - len(d))
    mini_fat_secs = (len(mini_fat) * 4 + SEC - 1) // SEC
    mini_stream_secs = (len(mini_data) + SEC - 1) // SEC
    dir_count = 1 + len(items)
    dir_secs = (dir_count * 128 + SEC - 1) // SEC
    large_secs = {n: (len(d) + SEC - 1) // SEC for n, d in large}
    data_secs = sum(large_secs.values()) + mini_stream_secs + mini_fat_secs + dir_secs
    # iterate FAT/DIFAT sector counts
    fat = 0; dif = 0
    while True:
        total = data_secs + fat + dif
        need_fat = (total + 127) // 128
        need_dif = 0 if need_fat <= 109 else (need_fat - 109 + 126) // 127
        if need_fat == fat and need_dif == dif: break
        fat, dif = need_fat, need_dif
    total = data_secs + fat + dif
    FAT = [FREESECT] * (fat * 128)
    pos = 0
    def alloc(n, chain=True):
        nonlocal pos
        first = pos
        for i in range(n):
            FAT[pos] = pos + 1 if (i < n - 1) else ENDOFCHAIN
            pos += 1
        return first
    layout = []  # (start, bytes)
    large_start = {}
    for n, d in large:
        s = alloc(large_secs[n]); large_start[n] = s
        layout.append((s, d))
    ms_start = alloc(mini_stream_secs) if mini_stream_secs else ENDOFCHAIN
    if mini_stream_secs: layout.append((ms_start, bytes(mini_data)))
    mf_start = alloc(mini_fat_secs) if mini_fat_secs else ENDOFCHAIN
    mf_bytes = struct.pack('<%dI' % len(mini_fat), *mini_fat) if mini_fat else b''
    if mini_fat_secs: layout.append((mf_start, mf_bytes))
    dir_start = alloc(dir_secs)
    fat_start = pos
    for i in range(fat): FAT[pos] = FATSECT; pos += 1
    dif_start = pos if dif else ENDOFCHAIN
    for i in range(dif): FAT[pos] = DIFSECT; pos += 1
    assert pos == total
    # --- directory tree (balanced BST, deepest level red)
    n_items = len(items)
    order = list(range(n_items))
    left = [NOSTREAM] * n_items; right = [NOSTREAM] * n_items; depth = [0] * n_items
    def build(lo, hi, d):
        if lo > hi: return NOSTREAM
        mid = (lo + hi) // 2
        depth[mid] = d
        left[mid] = build(lo, mid - 1, d + 1)
        right[mid] = build(mid + 1, hi, d + 1)
        return mid
    root_child = build(0, n_items - 1, 0)
    maxd = max(depth) if n_items else 0
    full = n_items == (1 << (maxd + 1)) - 1 if n_items else True
    def entry(name, typ, color, l, r, c, clsid, start, size):
        nm = name.encode('utf-16-le') + b'\0\0'
        e = nm.ljust(64, b'\0') + struct.pack('<H', len(nm)) + bytes([typ, color])
        e += struct.pack('<III', l, r, c) + clsid + struct.pack('<I', 0) + b'\0' * 16
        e += struct.pack('<IQ', start, size)
        assert len(e) == 128
        return e
    dirb = entry('Root Entry', 5, 1, NOSTREAM, NOSTREAM, (root_child + 1) if root_child != NOSTREAM else NOSTREAM,
                 root_clsid, ms_start if mini_stream_secs else ENDOFCHAIN, len(mini_data))
    for i, (n, d) in enumerate(items):
        color = 0 if (not full and depth[i] == maxd and maxd > 0) else 1
        l = left[i] + 1 if left[i] != NOSTREAM else NOSTREAM
        r = right[i] + 1 if right[i] != NOSTREAM else NOSTREAM
        if len(d) >= 4096: st = large_start[n]
        else: st = mini_start[n]
        dirb += entry(n, 2, color, l, r, NOSTREAM, b'\0' * 16, st if len(d) else ENDOFCHAIN, len(d))
    # unused entries: name empty, type 0, siblings NOSTREAM
    blank = b'\0' * 64 + struct.pack('<H', 0) + b'\0\0' + struct.pack('<III', NOSTREAM, NOSTREAM, NOSTREAM) + b'\0' * 16 + struct.pack('<I', 0) + b'\0' * 16 + struct.pack('<IQ', 0, 0)
    dirb = dirb[:dir_count * 128]
    while len(dirb) < dir_secs * SEC: dirb += blank
    layout.append((dir_start, dirb))
    # DIFAT
    fat_sector_ids = list(range(fat_start, fat_start + fat))
    header_dif = fat_sector_ids[:109] + [FREESECT] * (109 - len(fat_sector_ids[:109]))
    rest = fat_sector_ids[109:]
    dif_blocks = b''
    for i in range(dif):
        chunk = rest[i * 127:(i + 1) * 127]
        chunk += [FREESECT] * (127 - len(chunk))
        nxt = (dif_start + i + 1) if i < dif - 1 else ENDOFCHAIN
        dif_blocks += struct.pack('<128I', *chunk, nxt)
    # --- assemble
    hdr = b'\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1' + b'\0' * 16
    hdr += struct.pack('<HHHHH', 0x3E, 3, 0xFFFE, 9, 6) + b'\0' * 6
    hdr += struct.pack('<IIIIIIIII', 0, fat, dir_start, 0, 4096,
                       mf_start if mini_fat_secs else ENDOFCHAIN, mini_fat_secs, dif_start, dif)
    hdr += struct.pack('<109I', *header_dif)
    assert len(hdr) == 512
    body = bytearray(total * SEC)
    for start, data in layout:
        body[start * SEC:start * SEC + len(data)] = data
    fat_bytes = struct.pack('<%dI' % len(FAT), *FAT)
    body[fat_start * SEC:fat_start * SEC + len(fat_bytes)] = fat_bytes
    if dif: body[dif_start * SEC:dif_start * SEC + len(dif_blocks)] = dif_blocks
    return hdr + bytes(body)

# ----------------------------------------------------------- MSI stream names
B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._'
def enc_name(name, is_table):
    out = '䡀' if is_table else ''
    i = 0
    while i < len(name):
        c1 = name[i]; v1 = B64.find(c1)
        if v1 >= 0:
            if i + 1 < len(name) and B64.find(name[i + 1]) >= 0:
                out += chr(0x3800 + (B64.find(name[i + 1]) << 6) + v1); i += 2; continue
            out += chr(0x4800 + v1)
        else:
            out += c1
        i += 1
    return out

# ------------------------------------------------------------------ MSI tables
class Pool:
    def __init__(self): self.strs = []; self.idx = {}; self.ref = []
    def add(self, s):
        if s not in self.idx:
            self.strs.append(s); self.ref.append(0); self.idx[s] = len(self.strs)
        self.ref[self.idx[s] - 1] += 1
        return self.idx[s]
    def pool_bytes(self, codepage=1252):
        b = struct.pack('<I', codepage)
        for s, r in zip(self.strs, self.ref):
            ln = len(s.encode('cp1252'))
            assert ln < 65536
            b += struct.pack('<HH', ln, r)
        return b
    def data_bytes(self): return b''.join(s.encode('cp1252') for s in self.strs)

# column kinds
def S(n, pk=False, null=False, loc=False): return ('s', n, pk, null, loc)
def I2(pk=False, null=False): return ('i2', 2, pk, null, False)
def I4(pk=False, null=False): return ('i4', 4, pk, null, False)
def BIN(null=False): return ('bin', 0, False, null, False)

def bitfield(col):
    k, n, pk, null, loc = col
    bits = 0x100
    if k == 's': bits |= 0x800 | n | 0x400
    elif k == 'i2': bits |= 0x2 | 0x400
    elif k == 'i4': bits |= 0x4
    elif k == 'bin': bits |= 0x800
    if loc: bits |= 0x200
    if null: bits |= 0x1000
    if pk: bits |= 0x2000
    return bits

class MSI:
    def __init__(self):
        self.pool = Pool(); self.tables = {}; self.order = []; self.streams = {}
    def table(self, name, cols):  # cols: list of (colname, coldef)
        self.tables[name] = {'cols': cols, 'rows': []}; self.order.append(name)
    def row(self, name, *vals):
        t = self.tables[name]; assert len(vals) == len(t['cols']), (name, vals)
        t['rows'].append(vals)
    def _encode_table(self, cols, rows):
        # string refs are assigned by the caller beforehand (rows contain ints for strs)
        buf = b''
        srows = sorted(rows, key=lambda r: tuple((v if v is not None else 0) if not isinstance(v, bytes) else 0 for v in r))
        for ci, (cn, cd) in enumerate(cols):
            k = cd[0]
            for r in srows:
                v = r[ci]
                if k == 's': buf += struct.pack('<H', v or 0)
                elif k == 'i2': buf += struct.pack('<H', 0 if v is None else ((v + 0x8000) & 0xFFFF))
                elif k == 'i4': buf += struct.pack('<I', 0 if v is None else ((v + 0x80000000) & 0xFFFFFFFF))
                elif k == 'bin': buf += struct.pack('<H', 1)
        return buf
    def build(self, summary, clsid_hex='000C1084-0000-0000-C000-000000000046'):
        # system tables first so string indexes are stable
        names = list(self.order)
        sys_cols = {'_Tables': [('Name', S(64, pk=True))],
                    '_Columns': [('Table', S(64, pk=True)), ('Number', I2(pk=True)), ('Name', S(64)), ('Type', I2())]}
        enc = {}
        table_rows = [(n,) for n in names]
        col_rows = []
        for n in names:
            for i, (cn, cd) in enumerate(self.tables[n]['cols']):
                col_rows.append((n, i + 1, cn, bitfield(cd)))
        # intern strings: user table rows (to keep pool order natural, do tables, columns, then data)
        def intern(cols, rows):
            out = []
            for r in rows:
                nr = []
                for (cn, cd), v in zip(cols, r):
                    if cd[0] == 's': nr.append(self.pool.add(v) if v not in (None, '') else 0)
                    else: nr.append(v)
                out.append(tuple(nr))
            return out
        enc['_Tables'] = self._encode_table(sys_cols['_Tables'], intern(sys_cols['_Tables'], table_rows))
        enc['_Columns'] = self._encode_table(sys_cols['_Columns'], intern(sys_cols['_Columns'], col_rows))
        for n in names:
            t = self.tables[n]
            enc[n] = self._encode_table(t['cols'], intern(t['cols'], t['rows']))
        streams = dict(self.streams)
        streams[enc_name('_StringPool', True)] = self.pool.pool_bytes()
        streams[enc_name('_StringData', True)] = self.pool.data_bytes()
        for n, b in enc.items():
            if b: streams[enc_name(n, True)] = b
        streams['\x05SummaryInformation'] = summary
        for n in streams: assert len(n.encode('utf-16-le')) <= 62, n
        g = uuid.UUID(clsid_hex).bytes_le
        return build_cfb(streams, g)
    def add_binary(self, key, data):
        self.streams[enc_name('Binary.' + key, False)] = data

# ----------------------------------------------------------- summary information
def filetime(dt):
    return int((dt - datetime.datetime(1601, 1, 1)).total_seconds() * 10_000_000)

def summary_info(title, subject, author, keywords, comments, template, revision, pagecount, wordcount, appname):
    def lpstr(s):
        b = s.encode('cp1252') + b'\0'
        pad = (-len(b)) % 4
        return struct.pack('<II', 30, len(b)) + b + b'\0' * pad
    now = filetime(datetime.datetime.utcnow())
    props = {
        1: struct.pack('<IhH', 2, 1252, 0),
        2: lpstr(title), 3: lpstr(subject), 4: lpstr(author), 5: lpstr(keywords), 6: lpstr(comments),
        7: lpstr(template), 9: lpstr(revision),
        12: struct.pack('<IQ', 64, now), 13: struct.pack('<IQ', 64, now),
        14: struct.pack('<Ii', 3, pagecount), 15: struct.pack('<Ii', 3, wordcount), 18: lpstr(appname),
    }
    ids = sorted(props)
    size = 8 + 8 * len(ids)
    offs = []
    for i in ids: offs.append(size); size += len(props[i])
    sec = struct.pack('<II', size, len(ids)) + b''.join(struct.pack('<II', i, o) for i, o in zip(ids, offs)) + b''.join(props[i] for i in ids)
    fmtid = uuid.UUID('F29F85E0-4FF9-1068-AB91-08002B27B3D9').bytes_le
    hdr = struct.pack('<HHHH', 0xFFFE, 0, 0x0A06, 2) + b'\0' * 16 + struct.pack('<I', 1) + fmtid + struct.pack('<I', 48)
    return hdr + sec

#!/usr/bin/env python3
"""Structural check of an .rpm following rpm's own header/region rules (no rpm tooling needed)."""
import sys, struct, hashlib, gzip, io
d = open(sys.argv[1], 'rb').read()
assert d[:4] == b'\xed\xab\xee\xdb', 'lead magic'
pos = 96
def read_hdr(pos, region):
    assert d[pos:pos+8] == b'\x8e\xad\xe8\x01\0\0\0\0', 'header magic'
    il, dl = struct.unpack_from('>II', d, pos+8)
    idx = [struct.unpack_from('>IIiI', d, pos+16+i*16) for i in range(il)]
    ds = pos+16+il*16
    t, ty, off, cnt = idx[0]
    assert (t, ty, cnt) == (region, 7, 16), 'region tag'
    tr = struct.unpack_from('>IIiI', d, ds+off)
    assert tr[0] == region and tr[1] == 7 and tr[3] == 16 and -tr[2] == il*16, 'trailer'
    assert off + 16 == dl, 'region covers data'
    end = 0; tags = {}
    al = {3: 2, 4: 4, 5: 8}
    for t, ty, off, cnt in idx[1:]:
        assert off >= end, f'overlap tag {t}'
        assert off % al.get(ty, 1) == 0, f'align tag {t}'
        if ty in (6, 9): ln = d.index(b'\0', ds+off) - (ds+off) + 1; v = d[ds+off:ds+off+ln-1].decode()
        elif ty == 8:
            p = ds+off; v = []
            for _ in range(cnt):
                e = d.index(b'\0', p); v.append(d[p:e].decode()); p = e+1
            ln = p - (ds+off)
        else:
            sz = {2:1, 3:2, 4:4, 5:8, 7:1}[ty] * cnt; ln = sz
            v = d[ds+off:ds+off+sz] if ty == 7 else list(struct.unpack_from('>%d%s' % (cnt, {3:'H',4:'I'}.get(ty,'B')), d, ds+off))
        end = off + ln; assert end <= off + ln and end <= dl - 16 or True
        assert end <= dl - 16 + 0, f'tag {t} runs into trailer'
        tags[t] = (ty, cnt, v)
    assert [x[0] for x in idx[1:]] == sorted(x[0] for x in idx[1:]), 'tag order'
    return tags, pos, 16+il*16+dl
sig, spos, slen = read_hdr(pos, 62)
pos2 = spos + slen; pos2 += -slen % 8
hdr, hpos, hlen = read_hdr(pos2, 63)
payload = d[hpos+hlen:]
H = d[hpos:hpos+hlen]
assert sig[273][2] == hashlib.sha256(H).hexdigest(), 'sha256 header'
assert sig[269][2] == hashlib.sha1(H).hexdigest(), 'sha1 header'
assert sig[1004][2] == hashlib.md5(H+payload).digest(), 'md5'
assert sig[1000][2][0] == len(H)+len(payload), 'size'
cpio = gzip.decompress(payload); assert sig[1007][2][0] == len(cpio), 'payload size'
for need in (1000,1001,1002,1021,1022,1124): assert need in hdr, need
n = len(hdr[1117][2])
for t in (1028,1030,1033,1034,1035,1036,1037,1039,1040,1095,1096,1097,1116): assert hdr[t][1] == n, f'filecount {t}'
# walk cpio and compare with header
p = 0; i = 0; names = []
dn = hdr[1118][2]
while True:
    assert cpio[p:p+6] == b'070701'; f = [int(cpio[p+6+8*k:p+14+8*k], 16) for k in range(13)]
    nl = f[11]; name = cpio[p+110:p+110+nl-1].decode(); p = (p+110+nl+3)//4*4
    if name == 'TRAILER!!!': break
    data = cpio[p:p+f[6]]; p = (p+f[6]+3)//4*4
    full = dn[hdr[1116][2][i]] + hdr[1117][2][i]
    assert name == '.'+full, (name, full)
    assert f[6] == hdr[1028][2][i] and f[1] == hdr[1030][2][i]
    if hdr[1035][2][i]: assert hashlib.sha256(data).hexdigest() == hdr[1035][2][i], name
    names.append(full); i += 1
assert i == n, (i, n); assert names == sorted(names)
print('OK:', hdr[1000][2], hdr[1001][2], hdr[1002][2], hdr[1022][2], '-', n, 'files/dirs checked')

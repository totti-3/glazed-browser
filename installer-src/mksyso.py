import struct,sys
# usage: mksyso.py out.syso png...  (sizes from filenames like 16.png)
out=sys.argv[1]; pngs=[]
for p in sys.argv[2:]:
    pngs.append((int(p.rsplit('/',1)[-1].split('.')[0]),open(p,'rb').read()))
n=len(pngs)
# layout
root=16+2*8
t3=16+n*8; t14=16+1*8
off=root
o_t3=off; off+=t3
o_t14=off; off+=t14
o_n3=[]; 
for i in range(n): o_n3.append(off); off+=16+8      # name dir (1 lang entry)
o_n14=off; off+=16+8
o_de=[]; 
for i in range(n+1): o_de.append(off); off+=16
data=[]
grp=struct.pack('<HHH',0,1,n)
for i,(s,b) in enumerate(pngs):
    grp+=struct.pack('<BBBBHHIH',s%256,s%256,0,0,1,32,len(b),i+1)
blobs=[b for s,b in pngs]+[grp]
o_data=[]
for b in blobs:
    off=(off+3)&~3; o_data.append(off); off+=len(b)
buf=bytearray(off)
def dirh(o,nid): struct.pack_into('<IIHHHH',buf,o,0,0,0,0,0,nid)
dirh(0,2)
struct.pack_into('<II',buf,16,3,0x80000000|o_t3)
struct.pack_into('<II',buf,24,14,0x80000000|o_t14)
dirh(o_t3,n)
for i in range(n): struct.pack_into('<II',buf,o_t3+16+i*8,i+1,0x80000000|o_n3[i])
dirh(o_t14,1); struct.pack_into('<II',buf,o_t14+16,1,0x80000000|o_n14)
for i in range(n):
    dirh(o_n3[i],1); struct.pack_into('<II',buf,o_n3[i]+16,0x409,o_de[i])
dirh(o_n14,1); struct.pack_into('<II',buf,o_n14+16,0x409,o_de[n])
relocs=[]
for i,b in enumerate(blobs):
    struct.pack_into('<IIII',buf,o_de[i],o_data[i],len(b),0,0)
    relocs.append(o_de[i]); buf[o_data[i]:o_data[i]+len(b)]=b
# COFF
hdr=20; sec=40
raw=hdr+sec; reloff=raw+len(buf)
symoff=reloff+len(relocs)*10
f=struct.pack('<HHIIIHH',0x8664,1,0,symoff,1,0,0)
f+=struct.pack('<8sIIIIIIHHI',b'.rsrc',0,0,len(buf),raw,reloff,0,len(relocs),0,0xC0000040)
f+=bytes(buf)
for r in relocs: f+=struct.pack('<IIH',r,0,3)  # ADDR32NB, sym 0
f+=struct.pack('<8sIhHBB',b'.rsrc',0,1,0,3,0)
f+=struct.pack('<I',4)
open(out,'wb').write(f)

package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

// patchIcons replaces the RT_ICON images (ids 1..n) and the first RT_GROUP_ICON
// of a PE file in place. Every new image must fit into the old image's space.
func patchIcons(path string, pngs map[int][]byte) error {
	d, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	le := binary.LittleEndian
	if len(d) < 0x100 || string(d[:2]) != "MZ" {
		return fmt.Errorf("not a PE file")
	}
	pe := int(le.Uint32(d[0x3c:]))
	nsec := int(le.Uint16(d[pe+6:]))
	opt := int(le.Uint16(d[pe+20:]))
	dd := pe + 24 + 96
	if le.Uint16(d[pe+24:]) == 0x20b {
		dd = pe + 24 + 112
	}
	rrva := le.Uint32(d[dd+16:])
	type sec struct{ vs, va, rs, rp uint32 }
	var secs []sec
	for i := 0; i < nsec; i++ {
		o := pe + 24 + opt + i*40
		secs = append(secs, sec{le.Uint32(d[o+8:]), le.Uint32(d[o+12:]), le.Uint32(d[o+16:]), le.Uint32(d[o+20:])})
	}
	r2o := func(r uint32) int {
		for _, s := range secs {
			m := s.vs
			if s.rs > m {
				m = s.rs
			}
			if r >= s.va && r < s.va+m {
				return int(r - s.va + s.rp)
			}
		}
		return -1
	}
	base := r2o(rrva)
	if rrva == 0 || base < 0 {
		return fmt.Errorf("no resource section")
	}
	type ent struct{ id, off uint32 }
	list := func(o int) []ent {
		n := int(le.Uint16(d[o+12:])) + int(le.Uint16(d[o+14:]))
		var out []ent
		for i := 0; i < n; i++ {
			out = append(out, ent{le.Uint32(d[o+16+i*8:]), le.Uint32(d[o+20+i*8:])})
		}
		return out
	}
	// returns the data-entry offset (file) of the first leaf under a type/id
	leaf := func(off uint32) int {
		o := base + int(off&0x7fffffff)
		l := list(o)
		if len(l) == 0 {
			return -1
		}
		return base + int(l[0].off)
	}
	var iconDE = map[int]int{}
	groupDE := -1
	for _, t := range list(base) {
		if t.id != 3 && t.id != 14 {
			continue
		}
		for _, n := range list(base + int(t.off&0x7fffffff)) {
			de := leaf(n.off & 0x7fffffff | 0x80000000)
			if de < 0 {
				continue
			}
			if t.id == 3 {
				iconDE[int(n.id)] = de
			} else if groupDE < 0 {
				groupDE = de
			}
		}
	}
	if groupDE < 0 {
		return fmt.Errorf("no icon group")
	}
	// sizes: id -> pixel size (16,32,48,256)
	ids := []int{1, 2, 3, 4}
	px := []int{16, 32, 48, 256}
	gOff := r2o(le.Uint32(d[groupDE:]))
	gSize := int(le.Uint32(d[groupDE+4:]))
	if gOff < 0 || gSize < 6+14*len(ids) || int(le.Uint16(d[gOff+4:])) != len(ids) {
		return fmt.Errorf("unexpected icon group layout")
	}
	for i, id := range ids {
		de, ok := iconDE[id]
		png := pngs[px[i]]
		if !ok || png == nil {
			return fmt.Errorf("icon %d missing", id)
		}
		o := r2o(le.Uint32(d[de:]))
		capb := int(le.Uint32(d[de+4:]))
		if o < 0 || len(png) > capb {
			return fmt.Errorf("icon %d does not fit (%d > %d)", id, len(png), capb)
		}
		copy(d[o:o+capb], make([]byte, capb))
		copy(d[o:], png)
		le.PutUint32(d[de+4:], uint32(len(png)))
		e := gOff + 6 + i*14
		w := byte(px[i] % 256)
		d[e], d[e+1], d[e+2], d[e+3] = w, w, 0, 0
		le.PutUint16(d[e+4:], 1)
		le.PutUint16(d[e+6:], 32)
		le.PutUint32(d[e+8:], uint32(len(png)))
		le.PutUint16(d[e+12:], uint16(id))
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, d, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

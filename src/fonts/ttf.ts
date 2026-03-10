import type { Path, PathSegment, Subpath } from '../generators/pdf/types.ts';
import { MAX_CMAP_ENTRIES } from '../safety.ts';

// Big-endian binary readers — safe: return 0 for out-of-bounds
function u16(d: Uint8Array, o: number): number {
  if (o + 1 >= d.length) return 0;
  return (d[o] << 8) | d[o + 1];
}
function i16(d: Uint8Array, o: number): number { const v = u16(d, o); return v >= 0x8000 ? v - 0x10000 : v; }
function u32(d: Uint8Array, o: number): number {
  if (o + 3 >= d.length) return 0;
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

interface Table { offset: number; length: number }

interface RawPoint { x: number; y: number; onCurve: boolean }

export class TtfFont {
  private data: Uint8Array;
  private tables: Map<string, Table>;
  private scale: number;
  private numGlyphs: number;
  private locaFormat: number;
  private locaOff: number;
  private glyfOff: number;
  private hmtxOff: number;
  private numLongMetrics: number;
  private cmap: Map<number, number>;
  private outlineCache = new Map<number, Path>();
  private widthCache = new Map<number, number>();

  constructor(data: Uint8Array) {
    this.data = data;
    this.tables = this.parseTables();

    const head = this.table('head');
    const unitsPerEm = u16(data, head.offset + 18);
    this.locaFormat = i16(data, head.offset + 50);
    this.scale = 1000 / unitsPerEm;

    this.numGlyphs = u16(data, this.table('maxp').offset + 4);
    this.locaOff = this.table('loca').offset;
    this.glyfOff = this.table('glyf').offset;
    this.hmtxOff = this.table('hmtx').offset;
    this.numLongMetrics = u16(data, this.table('hhea').offset + 34);
    this.cmap = this.parseCmap();
  }

  getOutline(codePoint: number): Path | null {
    let cached = this.outlineCache.get(codePoint);
    if (cached !== undefined) return cached;

    const gid = this.cmap.get(codePoint);
    if (gid === undefined) return null;

    const contours = this.parseGlyph(gid, 0);
    if (!contours) {
      const empty: Path = { subpaths: [] };
      this.outlineCache.set(codePoint, empty);
      return empty;
    }

    const path = this.contoursToPath(contours);
    this.outlineCache.set(codePoint, path);
    return path;
  }

  getWidth(codePoint: number): number {
    let cached = this.widthCache.get(codePoint);
    if (cached !== undefined) return cached;

    const gid = this.cmap.get(codePoint);
    if (gid === undefined) return 500;

    const idx = gid < this.numLongMetrics ? gid : this.numLongMetrics - 1;
    const w = Math.round(u16(this.data, this.hmtxOff + idx * 4) * this.scale);
    this.widthCache.set(codePoint, w);
    return w;
  }

  // --- Table directory ---

  private parseTables(): Map<string, Table> {
    const d = this.data;
    const n = u16(d, 4);
    const map = new Map<string, Table>();
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
      map.set(tag, { offset: u32(d, o + 8), length: u32(d, o + 12) });
    }
    return map;
  }

  private table(tag: string): Table {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`Missing TTF table: ${tag}`);
    return t;
  }

  // --- cmap parsing ---

  private parseCmap(): Map<number, number> {
    const d = this.data;
    const off = this.table('cmap').offset;
    const numSub = u16(d, off + 2);

    let bestOff = -1, bestFmt = -1;
    for (let i = 0; i < numSub; i++) {
      const so = off + 4 + i * 8;
      const pid = u16(d, so);
      const eid = u16(d, so + 2);
      const subOff = off + u32(d, so + 4);
      const fmt = u16(d, subOff);

      if ((pid === 3 || pid === 0) && fmt === 12) { bestOff = subOff; bestFmt = 12; break; }
      if ((pid === 3 && eid === 1 || pid === 0) && fmt === 4 && bestFmt < 4) { bestOff = subOff; bestFmt = 4; }
    }

    if (bestFmt === 12) return this.parseCmap12(bestOff);
    if (bestFmt === 4) return this.parseCmap4(bestOff);
    return new Map();
  }

  private parseCmap4(off: number): Map<number, number> {
    const d = this.data;
    const map = new Map<number, number>();
    const segCount = u16(d, off + 6) / 2;
    const endOff = off + 14;
    const startOff = endOff + segCount * 2 + 2;
    const deltaOff = startOff + segCount * 2;
    const rangeOff = deltaOff + segCount * 2;

    let total = 0;
    for (let i = 0; i < segCount; i++) {
      const end = u16(d, endOff + i * 2);
      const start = u16(d, startOff + i * 2);
      if (start === 0xFFFF) break;
      const delta = i16(d, deltaOff + i * 2);
      const range = u16(d, rangeOff + i * 2);

      for (let c = start; c <= end && total < MAX_CMAP_ENTRIES; c++, total++) {
        let gid: number;
        if (range === 0) {
          gid = (c + delta) & 0xFFFF;
        } else {
          gid = u16(d, rangeOff + i * 2 + range + (c - start) * 2);
          if (gid !== 0) gid = (gid + delta) & 0xFFFF;
        }
        if (gid !== 0) map.set(c, gid);
      }
    }
    return map;
  }

  private parseCmap12(off: number): Map<number, number> {
    const d = this.data;
    const map = new Map<number, number>();
    const nGroups = u32(d, off + 12);
    let total = 0;
    for (let i = 0; i < nGroups; i++) {
      const go = off + 16 + i * 12;
      const startChar = u32(d, go);
      const endChar = u32(d, go + 4);
      const startGid = u32(d, go + 8);
      for (let c = startChar; c <= endChar && total < MAX_CMAP_ENTRIES; c++, total++) {
        map.set(c, startGid + (c - startChar));
      }
    }
    return map;
  }

  // --- Glyph parsing ---

  private parseGlyph(gid: number, depth: number): RawPoint[][] | null {
    if (depth > 10 || gid >= this.numGlyphs) return null;

    const d = this.data;
    let g0: number, g1: number;
    if (this.locaFormat === 0) {
      g0 = u16(d, this.locaOff + gid * 2) * 2;
      g1 = u16(d, this.locaOff + (gid + 1) * 2) * 2;
    } else {
      g0 = u32(d, this.locaOff + gid * 4);
      g1 = u32(d, this.locaOff + (gid + 1) * 4);
    }
    if (g0 === g1) return null;

    const off = this.glyfOff + g0;
    const nContours = i16(d, off);
    return nContours >= 0 ? this.parseSimple(off, nContours) : this.parseCompound(off, depth);
  }

  private parseSimple(off: number, nContours: number): RawPoint[][] {
    const d = this.data;
    let pos = off + 10;

    const endPts: number[] = [];
    for (let i = 0; i < nContours; i++) { endPts.push(u16(d, pos)); pos += 2; }

    const numPts = nContours > 0 ? endPts[endPts.length - 1] + 1 : 0;
    const instrLen = u16(d, pos);
    pos += 2 + instrLen;

    // Flags
    const flags: number[] = [];
    while (flags.length < numPts) {
      const f = d[pos++];
      flags.push(f);
      if (f & 0x08) { const n = d[pos++]; for (let r = 0; r < n; r++) flags.push(f); }
    }

    // X coordinates
    const xs: number[] = [];
    let x = 0;
    for (let i = 0; i < numPts; i++) {
      const f = flags[i];
      if (f & 0x02) { x += (f & 0x10) ? d[pos++] : -d[pos++]; }
      else if (!(f & 0x10)) { x += i16(d, pos); pos += 2; }
      xs.push(x);
    }

    // Y coordinates
    const ys: number[] = [];
    let y = 0;
    for (let i = 0; i < numPts; i++) {
      const f = flags[i];
      if (f & 0x04) { y += (f & 0x20) ? d[pos++] : -d[pos++]; }
      else if (!(f & 0x20)) { y += i16(d, pos); pos += 2; }
      ys.push(y);
    }

    // Build contours
    const contours: RawPoint[][] = [];
    let start = 0;
    for (const end of endPts) {
      const pts: RawPoint[] = [];
      for (let i = start; i <= end; i++) pts.push({ x: xs[i], y: ys[i], onCurve: (flags[i] & 0x01) !== 0 });
      contours.push(pts);
      start = end + 1;
    }
    return contours;
  }

  private parseCompound(off: number, depth: number): RawPoint[][] {
    const d = this.data;
    let pos = off + 10;
    const all: RawPoint[][] = [];

    let more = true;
    while (more) {
      const fl = u16(d, pos);
      const gid = u16(d, pos + 2);
      pos += 4;

      let dx = 0, dy = 0, a = 1, b = 0, c = 0, dd = 1;

      if (fl & 0x01) {
        if (fl & 0x02) { dx = i16(d, pos); dy = i16(d, pos + 2); }
        pos += 4;
      } else {
        if (fl & 0x02) { dx = (d[pos] << 24) >> 24; dy = (d[pos + 1] << 24) >> 24; }
        pos += 2;
      }

      if (fl & 0x08) { const s = i16(d, pos) / 16384; a = dd = s; pos += 2; }
      else if (fl & 0x40) { a = i16(d, pos) / 16384; dd = i16(d, pos + 2) / 16384; pos += 4; }
      else if (fl & 0x80) { a = i16(d, pos) / 16384; b = i16(d, pos + 2) / 16384; c = i16(d, pos + 4) / 16384; dd = i16(d, pos + 6) / 16384; pos += 8; }

      const comp = this.parseGlyph(gid, depth + 1);
      if (comp) {
        for (const contour of comp) {
          all.push(contour.map(p => ({
            x: Math.round(a * p.x + c * p.y + dx),
            y: Math.round(b * p.x + dd * p.y + dy),
            onCurve: p.onCurve,
          })));
        }
      }

      more = (fl & 0x20) !== 0;
    }
    return all;
  }

  // --- Convert TrueType contours (quadratic beziers) to Path (cubic beziers) ---

  private contoursToPath(contours: RawPoint[][]): Path {
    const s = this.scale;
    const subpaths: Subpath[] = [];

    for (const contour of contours) {
      if (contour.length === 0) continue;
      const segs: PathSegment[] = [];
      const pts = contour;
      const n = pts.length;

      // Find start point
      let sx: number, sy: number, si: number;
      if (pts[0].onCurve) {
        sx = pts[0].x * s; sy = pts[0].y * s; si = 1;
      } else if (pts[n - 1].onCurve) {
        sx = pts[n - 1].x * s; sy = pts[n - 1].y * s; si = 0;
      } else {
        sx = (pts[0].x + pts[n - 1].x) / 2 * s;
        sy = (pts[0].y + pts[n - 1].y) / 2 * s;
        si = 0;
      }

      segs.push({ type: 'move', x: sx, y: sy });
      let cx = sx, cy = sy;

      let i = si;
      while (i < n) {
        const pt = pts[i];
        if (pt.onCurve) {
          const px = pt.x * s, py = pt.y * s;
          segs.push({ type: 'line', x: px, y: py });
          cx = px; cy = py;
          i++;
        } else {
          // Off-curve: quadratic bezier
          const qx = pt.x * s, qy = pt.y * s;
          let ex: number, ey: number;

          if (i + 1 < n && pts[i + 1].onCurve) {
            ex = pts[i + 1].x * s; ey = pts[i + 1].y * s;
            i += 2;
          } else if (i + 1 < n) {
            // Implicit on-curve between two off-curve
            ex = (pt.x + pts[i + 1].x) / 2 * s;
            ey = (pt.y + pts[i + 1].y) / 2 * s;
            i += 1;
          } else {
            // Wrap to start
            ex = sx; ey = sy;
            i++;
          }

          // Quadratic → cubic: CP1 = P0 + 2/3*(Q-P0), CP2 = P1 + 2/3*(Q-P1)
          segs.push({
            type: 'cubic',
            cx1: cx + 2 / 3 * (qx - cx), cy1: cy + 2 / 3 * (qy - cy),
            cx2: ex + 2 / 3 * (qx - ex), cy2: ey + 2 / 3 * (qy - ey),
            x: ex, y: ey,
          });
          cx = ex; cy = ey;
        }
      }

      subpaths.push({ segments: segs, closed: true });
    }

    return { subpaths };
  }
}

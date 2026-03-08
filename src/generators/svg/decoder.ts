import type { PixelGrid } from '../../types.ts';
import type { Matrix, RGBA, Path, PathSegment, Subpath } from '../pdf/types.ts';
import { fillPath, strokePath, identity, multiplyMatrix, transformPoint } from '../pdf/rasterizer.ts';
import { getGlyphOutline, getFallbackWidth } from '../pdf/font.ts';
import { decodeJpeg } from '../jpeg/decoder.ts';
import { decodePng } from '../png/decoder.ts';
import { decodeGif } from '../gif/decoder.ts';
import { parseXml, attr, type XmlNode } from '../docx/xml.ts';
import type { SvgStyle, SvgPaint, SvgDefs, SvgGradient, SvgGradientStop } from './types.ts';
import { DEFAULT_STYLE } from './types.ts';

const MAX_DIM = 1024;
const KAPPA = 0.5522847498;

// --- Entry point ---

export function decodeSvg(data: Uint8Array): PixelGrid {
  const text = new TextDecoder('utf-8').decode(data);
  const root = parseXml(text);

  const svg = root.tag === 'svg' ? root : findSvgRoot(root);
  if (!svg) throw new Error('No <svg> element found');

  const { vw, vh, viewBox } = parseViewport(svg);

  const scale = Math.min(MAX_DIM / vw, MAX_DIM / vh);
  const width = Math.max(1, Math.round(vw * scale));
  const height = Math.max(1, Math.round(vh * scale));
  const buffer = new Uint8Array(width * height * 4);
  buffer.fill(255);

  let ctm: Matrix;
  if (viewBox) {
    const sx = width / viewBox.w;
    const sy = height / viewBox.h;
    const s = Math.min(sx, sy);
    const tx = (width - viewBox.w * s) / 2 - viewBox.x * s;
    const ty = (height - viewBox.h * s) / 2 - viewBox.y * s;
    ctm = [s, 0, 0, s, tx, ty];
  } else {
    ctm = [scale, 0, 0, scale, 0, 0];
  }

  const defs = collectDefs(svg);
  renderElement(buffer, width, height, svg, ctm, DEFAULT_STYLE, defs);

  return { width, height, data: buffer };
}

function findSvgRoot(node: XmlNode): XmlNode | null {
  if (node.tag === 'svg') return node;
  for (const child of node.children) {
    const found = findSvgRoot(child);
    if (found) return found;
  }
  return null;
}

function parseViewport(svg: XmlNode): {
  vw: number; vh: number;
  viewBox: { x: number; y: number; w: number; h: number } | null;
} {
  const vbStr = attr(svg, 'viewBox');
  let viewBox: { x: number; y: number; w: number; h: number } | null = null;
  if (vbStr) {
    const p = vbStr.trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4 && p.every(n => !isNaN(n))) {
      viewBox = { x: p[0], y: p[1], w: p[2], h: p[3] };
    }
  }

  const vw = parseSvgLength(attr(svg, 'width')) ?? viewBox?.w ?? 300;
  const vh = parseSvgLength(attr(svg, 'height')) ?? viewBox?.h ?? 150;
  return { vw, vh, viewBox };
}

function parseSvgLength(val: string | null): number | null {
  if (!val) return null;
  const m = val.match(/^([\d.]+)\s*(px|pt|em|rem|%|cm|mm|in)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  switch (m[2]) {
    case 'pt': return n * 1.333;
    case 'cm': return n * 37.795;
    case 'mm': return n * 3.7795;
    case 'in': return n * 96;
    case 'em': case 'rem': return n * 16;
    default: return n;
  }
}

// --- Defs collection ---

function collectDefs(root: XmlNode): SvgDefs {
  const defs: SvgDefs = { gradients: new Map(), elements: new Map() };
  walkTree(root, node => {
    const id = attr(node, 'id');
    if (id) defs.elements.set(id, node);
    if (node.tag === 'linearGradient' && id) {
      defs.gradients.set(id, parseLinearGradient(node));
    } else if (node.tag === 'radialGradient' && id) {
      defs.gradients.set(id, parseRadialGradient(node));
    }
  });
  // Resolve gradient href inheritance
  for (const [, grad] of defs.gradients) {
    resolveGradientHref(grad, defs);
  }
  return defs;
}

function walkTree(node: XmlNode, fn: (n: XmlNode) => void): void {
  fn(node);
  for (const child of node.children) walkTree(child, fn);
}

function parseGradientStops(node: XmlNode): SvgGradientStop[] {
  const stops: SvgGradientStop[] = [];
  for (const child of node.children) {
    if (child.tag !== 'stop') continue;
    let offset = parseFloat(attr(child, 'offset') ?? '0');
    if (isNaN(offset)) offset = 0;
    if (String(attr(child, 'offset') ?? '').includes('%')) offset /= 100;

    // stop-color from attribute or inline style
    let colorStr = attr(child, 'stop-color');
    let opacityStr = attr(child, 'stop-opacity');
    const style = attr(child, 'style');
    if (style) {
      for (const decl of style.split(';')) {
        const [p, v] = decl.split(':').map(s => s.trim());
        if (p === 'stop-color') colorStr = v;
        if (p === 'stop-opacity') opacityStr = v;
      }
    }

    const color = parseColor(colorStr ?? 'black') ?? { r: 0, g: 0, b: 0, a: 255 };
    if (opacityStr) {
      const o = parseFloat(opacityStr);
      if (!isNaN(o)) color.a = Math.round(255 * Math.max(0, Math.min(1, o)));
    }
    stops.push({ offset: Math.max(0, Math.min(1, offset)), color });
  }
  return stops;
}

function parseLinearGradient(node: XmlNode): SvgGradient {
  return {
    type: 'linear',
    x1: parseFloat(attr(node, 'x1') ?? '0'),
    y1: parseFloat(attr(node, 'y1') ?? '0'),
    x2: parseFloat(attr(node, 'x2') ?? '1'),
    y2: parseFloat(attr(node, 'y2') ?? '0'),
    stops: parseGradientStops(node),
    transform: parseTransform(attr(node, 'gradientTransform')),
  };
}

function parseRadialGradient(node: XmlNode): SvgGradient {
  const cx = parseFloat(attr(node, 'cx') ?? '0.5');
  const cy = parseFloat(attr(node, 'cy') ?? '0.5');
  return {
    type: 'radial',
    cx, cy,
    r: parseFloat(attr(node, 'r') ?? '0.5'),
    fx: parseFloat(attr(node, 'fx') ?? String(cx)),
    fy: parseFloat(attr(node, 'fy') ?? String(cy)),
    stops: parseGradientStops(node),
    transform: parseTransform(attr(node, 'gradientTransform')),
  };
}

function resolveGradientHref(grad: SvgGradient, defs: SvgDefs): void {
  if (grad.stops.length > 0) return;
  // Check the original node for xlink:href to inherit stops
  const node = [...defs.elements.values()].find(n =>
    (n.tag === 'linearGradient' || n.tag === 'radialGradient') &&
    defs.gradients.get(attr(n, 'id') ?? '') === grad
  );
  if (!node) return;
  const href = attr(node, 'xlink:href') ?? attr(node, 'href');
  if (!href?.startsWith('#')) return;
  const parent = defs.gradients.get(href.slice(1));
  if (parent && parent.stops.length > 0) {
    grad.stops.push(...parent.stops);
  }
}

// --- Color parsing ---

const NAMED_COLORS: Record<string, RGBA> = {
  black: { r: 0, g: 0, b: 0, a: 255 },
  white: { r: 255, g: 255, b: 255, a: 255 },
  red: { r: 255, g: 0, b: 0, a: 255 },
  green: { r: 0, g: 128, b: 0, a: 255 },
  blue: { r: 0, g: 0, b: 255, a: 255 },
  yellow: { r: 255, g: 255, b: 0, a: 255 },
  orange: { r: 255, g: 165, b: 0, a: 255 },
  purple: { r: 128, g: 0, b: 128, a: 255 },
  cyan: { r: 0, g: 255, b: 255, a: 255 },
  magenta: { r: 255, g: 0, b: 255, a: 255 },
  lime: { r: 0, g: 255, b: 0, a: 255 },
  maroon: { r: 128, g: 0, b: 0, a: 255 },
  navy: { r: 0, g: 0, b: 128, a: 255 },
  olive: { r: 128, g: 128, b: 0, a: 255 },
  teal: { r: 0, g: 128, b: 128, a: 255 },
  silver: { r: 192, g: 192, b: 192, a: 255 },
  gray: { r: 128, g: 128, b: 128, a: 255 },
  grey: { r: 128, g: 128, b: 128, a: 255 },
  aqua: { r: 0, g: 255, b: 255, a: 255 },
  fuchsia: { r: 255, g: 0, b: 255, a: 255 },
  coral: { r: 255, g: 127, b: 80, a: 255 },
  salmon: { r: 250, g: 128, b: 114, a: 255 },
  gold: { r: 255, g: 215, b: 0, a: 255 },
  indigo: { r: 75, g: 0, b: 130, a: 255 },
  violet: { r: 238, g: 130, b: 238, a: 255 },
  pink: { r: 255, g: 192, b: 203, a: 255 },
  brown: { r: 165, g: 42, b: 42, a: 255 },
  beige: { r: 245, g: 245, b: 220, a: 255 },
  tan: { r: 210, g: 180, b: 140, a: 255 },
  skyblue: { r: 135, g: 206, b: 235, a: 255 },
  steelblue: { r: 70, g: 130, b: 180, a: 255 },
  tomato: { r: 255, g: 99, b: 71, a: 255 },
  darkgray: { r: 169, g: 169, b: 169, a: 255 },
  darkgrey: { r: 169, g: 169, b: 169, a: 255 },
  lightgray: { r: 211, g: 211, b: 211, a: 255 },
  lightgrey: { r: 211, g: 211, b: 211, a: 255 },
  darkgreen: { r: 0, g: 100, b: 0, a: 255 },
  darkblue: { r: 0, g: 0, b: 139, a: 255 },
  darkred: { r: 139, g: 0, b: 0, a: 255 },
  whitesmoke: { r: 245, g: 245, b: 245, a: 255 },
  none: { r: 0, g: 0, b: 0, a: 0 },
};

function parseColor(value: string): RGBA | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return null;

  // Hex
  if (v[0] === '#') {
    if (v.length === 4) {
      return {
        r: parseInt(v[1] + v[1], 16), g: parseInt(v[2] + v[2], 16),
        b: parseInt(v[3] + v[3], 16), a: 255,
      };
    }
    if (v.length === 7) {
      return {
        r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16),
        b: parseInt(v.slice(5, 7), 16), a: 255,
      };
    }
  }

  // rgb() / rgba()
  const rgbMatch = v.match(/rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?))?\s*\)/);
  if (rgbMatch) {
    const parseComp = (s: string): number => {
      if (s.endsWith('%')) return Math.round(parseFloat(s) * 2.55);
      return Math.round(parseFloat(s));
    };
    const r = Math.max(0, Math.min(255, parseComp(rgbMatch[1])));
    const g = Math.max(0, Math.min(255, parseComp(rgbMatch[2])));
    const b = Math.max(0, Math.min(255, parseComp(rgbMatch[3])));
    let a = 255;
    if (rgbMatch[4]) {
      const av = rgbMatch[4].endsWith('%') ? parseFloat(rgbMatch[4]) / 100 : parseFloat(rgbMatch[4]);
      a = Math.round(Math.max(0, Math.min(1, av)) * 255);
    }
    return { r, g, b, a };
  }

  return NAMED_COLORS[v] ? { ...NAMED_COLORS[v] } : null;
}

function parsePaint(value: string | null, defs: SvgDefs): SvgPaint {
  if (!value || value === 'none') return { type: 'none' };
  const urlMatch = value.match(/url\(\s*#([^)]+)\s*\)/);
  if (urlMatch) return { type: 'gradient', id: urlMatch[1] };
  const color = parseColor(value);
  if (color) return { type: 'color', color };
  return { type: 'none' };
}

// --- Transform parsing ---

function parseTransform(value: string | null): Matrix {
  if (!value) return identity();
  let result = identity();
  const regex = /(translate|rotate|scale|matrix|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    let m: Matrix;
    switch (match[1]) {
      case 'translate':
        m = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        m = [sx, 0, 0, args.length > 1 ? args[1] : sx, 0, 0];
        break;
      }
      case 'rotate': {
        const a = (args[0] || 0) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        if (args.length >= 3) {
          const cx = args[1], cy = args[2];
          m = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
        } else {
          m = [cos, sin, -sin, cos, 0, 0];
        }
        break;
      }
      case 'matrix':
        m = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case 'skewX': {
        const t = Math.tan((args[0] || 0) * Math.PI / 180);
        m = [1, 0, t, 1, 0, 0];
        break;
      }
      case 'skewY': {
        const t = Math.tan((args[0] || 0) * Math.PI / 180);
        m = [1, t, 0, 1, 0, 0];
        break;
      }
      default: m = identity();
    }
    result = multiplyMatrix(result, m);
  }
  return result;
}

// --- Style resolution ---

function resolveStyle(node: XmlNode, parent: SvgStyle, defs: SvgDefs): SvgStyle {
  const style: SvgStyle = { ...parent };

  // Presentation attributes
  applyStyleProp(style, defs, 'fill', attr(node, 'fill'));
  applyStyleProp(style, defs, 'stroke', attr(node, 'stroke'));
  applyStyleProp(style, defs, 'stroke-width', attr(node, 'stroke-width'));
  applyStyleProp(style, defs, 'opacity', attr(node, 'opacity'));
  applyStyleProp(style, defs, 'fill-opacity', attr(node, 'fill-opacity'));
  applyStyleProp(style, defs, 'stroke-opacity', attr(node, 'stroke-opacity'));
  applyStyleProp(style, defs, 'fill-rule', attr(node, 'fill-rule'));
  applyStyleProp(style, defs, 'display', attr(node, 'display'));
  applyStyleProp(style, defs, 'visibility', attr(node, 'visibility'));

  // Inline style overrides
  const inlineStyle = attr(node, 'style');
  if (inlineStyle) {
    for (const decl of inlineStyle.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim();
      const val = decl.slice(colon + 1).trim();
      if (prop && val) applyStyleProp(style, defs, prop, val);
    }
  }

  return style;
}

function applyStyleProp(style: SvgStyle, defs: SvgDefs, prop: string, val: string | null): void {
  if (!val) return;
  switch (prop) {
    case 'fill': style.fill = parsePaint(val, defs); break;
    case 'stroke': style.stroke = parsePaint(val, defs); break;
    case 'stroke-width': { const n = parseFloat(val); if (!isNaN(n)) style.strokeWidth = n; break; }
    case 'opacity': { const n = parseFloat(val); if (!isNaN(n)) style.opacity = Math.max(0, Math.min(1, n)); break; }
    case 'fill-opacity': { const n = parseFloat(val); if (!isNaN(n)) style.fillOpacity = Math.max(0, Math.min(1, n)); break; }
    case 'stroke-opacity': { const n = parseFloat(val); if (!isNaN(n)) style.strokeOpacity = Math.max(0, Math.min(1, n)); break; }
    case 'fill-rule': if (val === 'evenodd' || val === 'nonzero') style.fillRule = val; break;
    case 'display': style.display = val !== 'none'; break;
    case 'visibility': if (val === 'hidden' || val === 'collapse') style.display = false; break;
  }
}

// --- SVG path `d` parser ---

function tokenizePath(d: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  while (i < d.length) {
    const c = d[i];
    if (c === ' ' || c === ',' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[a-zA-Z]/.test(c)) { tokens.push(c); i++; continue; }

    // Number
    const start = i;
    if (c === '-' || c === '+') i++;
    let hasDot = false;
    while (i < d.length && ((d[i] >= '0' && d[i] <= '9') || (d[i] === '.' && !hasDot))) {
      if (d[i] === '.') hasDot = true;
      i++;
    }
    if (i < d.length && (d[i] === 'e' || d[i] === 'E')) {
      i++;
      if (i < d.length && (d[i] === '+' || d[i] === '-')) i++;
      while (i < d.length && d[i] >= '0' && d[i] <= '9') i++;
    }
    if (i > start) tokens.push(parseFloat(d.slice(start, i)));
    else i++;
  }
  return tokens;
}

function parseSvgPath(d: string): Path {
  const tokens = tokenizePath(d);
  const subpaths: Subpath[] = [];
  let segs: PathSegment[] = [];
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let lastCpX = 0, lastCpY = 0; // for S/T reflection
  let lastCmd = '';
  let i = 0;

  function num(): number {
    while (i < tokens.length && typeof tokens[i] === 'string') i++;
    return i < tokens.length ? tokens[i++] as number : 0;
  }

  function flag(): number {
    // Arc flags can be 0/1 jammed together without separator
    if (i >= tokens.length) return 0;
    if (typeof tokens[i] === 'number') {
      const v = tokens[i] as number;
      if (v === 0 || v === 1) { i++; return v; }
      // Multi-digit: first digit is the flag
      const s = String(v);
      if (s[0] === '0' || s[0] === '1') {
        const rest = parseFloat(s.slice(1));
        tokens[i] = rest;
        return parseInt(s[0]);
      }
      i++;
      return v;
    }
    return num();
  }

  function finishSubpath(closed: boolean): void {
    if (segs.length > 0) {
      subpaths.push({ segments: segs, closed });
      segs = [];
    }
  }

  while (i < tokens.length) {
    let cmd: string;
    if (typeof tokens[i] === 'string') {
      cmd = tokens[i] as string;
      i++;
    } else {
      // Implicit repeat: M becomes L, m becomes l, others repeat
      cmd = lastCmd;
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
    }

    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? curX : 0;
    const oy = rel ? curY : 0;

    switch (cmd.toUpperCase()) {
      case 'M': {
        finishSubpath(false);
        curX = num() + (rel ? curX : 0);
        curY = num() + (rel ? curY : 0);
        startX = curX; startY = curY;
        segs.push({ type: 'move', x: curX, y: curY });
        lastCpX = curX; lastCpY = curY;
        break;
      }
      case 'L': {
        const x = num() + ox, y = num() + oy;
        segs.push({ type: 'line', x, y });
        curX = x; curY = y; lastCpX = x; lastCpY = y;
        break;
      }
      case 'H': {
        const x = num() + (rel ? curX : 0);
        segs.push({ type: 'line', x, y: curY });
        curX = x; lastCpX = x; lastCpY = curY;
        break;
      }
      case 'V': {
        const y = num() + (rel ? curY : 0);
        segs.push({ type: 'line', x: curX, y });
        curY = y; lastCpX = curX; lastCpY = y;
        break;
      }
      case 'C': {
        const cx1 = num() + ox, cy1 = num() + oy;
        const cx2 = num() + ox, cy2 = num() + oy;
        const x = num() + ox, y = num() + oy;
        segs.push({ type: 'cubic', x, y, cx1, cy1, cx2, cy2 });
        lastCpX = cx2; lastCpY = cy2; curX = x; curY = y;
        break;
      }
      case 'S': {
        // Reflected control point from last cubic
        const cx1 = 2 * curX - lastCpX;
        const cy1 = 2 * curY - lastCpY;
        const cx2 = num() + ox, cy2 = num() + oy;
        const x = num() + ox, y = num() + oy;
        segs.push({ type: 'cubic', x, y, cx1, cy1, cx2, cy2 });
        lastCpX = cx2; lastCpY = cy2; curX = x; curY = y;
        break;
      }
      case 'Q': {
        const qx = num() + ox, qy = num() + oy;
        const x = num() + ox, y = num() + oy;
        // Quadratic to cubic conversion
        const cx1 = curX + 2 / 3 * (qx - curX);
        const cy1 = curY + 2 / 3 * (qy - curY);
        const cx2 = x + 2 / 3 * (qx - x);
        const cy2 = y + 2 / 3 * (qy - y);
        segs.push({ type: 'cubic', x, y, cx1, cy1, cx2, cy2 });
        lastCpX = qx; lastCpY = qy; curX = x; curY = y;
        break;
      }
      case 'T': {
        // Reflected quadratic control point
        const qx = 2 * curX - lastCpX;
        const qy = 2 * curY - lastCpY;
        const x = num() + ox, y = num() + oy;
        const cx1 = curX + 2 / 3 * (qx - curX);
        const cy1 = curY + 2 / 3 * (qy - curY);
        const cx2 = x + 2 / 3 * (qx - x);
        const cy2 = y + 2 / 3 * (qy - y);
        segs.push({ type: 'cubic', x, y, cx1, cy1, cx2, cy2 });
        lastCpX = qx; lastCpY = qy; curX = x; curY = y;
        break;
      }
      case 'A': {
        const rx0 = Math.abs(num()), ry0 = Math.abs(num());
        const rotation = num() * Math.PI / 180;
        const largeArc = flag();
        const sweep = flag();
        const x = num() + ox, y = num() + oy;
        arcToCubic(segs, curX, curY, rx0, ry0, rotation, largeArc, sweep, x, y);
        curX = x; curY = y; lastCpX = x; lastCpY = y;
        break;
      }
      case 'Z': {
        finishSubpath(true);
        curX = startX; curY = startY;
        lastCpX = curX; lastCpY = curY;
        break;
      }
    }
    lastCmd = cmd;
  }
  finishSubpath(false);
  return { subpaths };
}

// SVG arc endpoint → center parameterization → cubic bezier segments
function arcToCubic(
  segs: PathSegment[], x1: number, y1: number,
  rx: number, ry: number, phi: number,
  fA: number, fS: number, x2: number, y2: number,
): void {
  if (rx === 0 || ry === 0) {
    segs.push({ type: 'line', x: x2, y: y2 });
    return;
  }

  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Correct radii if too small
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }

  // Center parameterization (SVG spec F.6.5)
  const rx2 = rx * rx, ry2 = ry * ry;
  const x1p2 = x1p * x1p, y1p2 = y1p * y1p;
  let sq = (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2);
  if (sq < 0) sq = 0;
  const sign = fA === fS ? -1 : 1;
  const root = sign * Math.sqrt(sq);
  const cxp = root * rx * y1p / ry;
  const cyp = -root * ry * x1p / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const theta1 = vecAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = vecAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (fS === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
  if (fS === 1 && dTheta < 0) dTheta += 2 * Math.PI;

  // Split into ≤90° segments and approximate each as cubic bezier
  const numSegs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const step = dTheta / numSegs;

  for (let s = 0; s < numSegs; s++) {
    const a1 = theta1 + s * step;
    const a2 = theta1 + (s + 1) * step;
    const alpha = 4 * Math.tan((a2 - a1) / 4) / 3;

    const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
    const cos2 = Math.cos(a2), sin2 = Math.sin(a2);

    // Control points in ellipse-local space
    const ep1x = rx * (cos1 - alpha * sin1);
    const ep1y = ry * (sin1 + alpha * cos1);
    const ep2x = rx * (cos2 + alpha * sin2);
    const ep2y = ry * (sin2 - alpha * cos2);
    const epx = rx * cos2;
    const epy = ry * sin2;

    // Rotate and translate to world space
    segs.push({
      type: 'cubic',
      cx1: cosPhi * ep1x - sinPhi * ep1y + cx,
      cy1: sinPhi * ep1x + cosPhi * ep1y + cy,
      cx2: cosPhi * ep2x - sinPhi * ep2y + cx,
      cy2: sinPhi * ep2x + cosPhi * ep2y + cy,
      x: cosPhi * epx - sinPhi * epy + cx,
      y: sinPhi * epx + cosPhi * epy + cy,
    });
  }
}

function vecAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
  let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
  if (ux * vy - uy * vx < 0) a = -a;
  return a;
}

// --- Element rendering ---

function renderElement(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, parentStyle: SvgStyle, defs: SvgDefs,
): void {
  const tag = node.tag;
  if (tag === 'defs' || tag === 'clipPath' || tag === 'symbol' ||
      tag === 'metadata' || tag === 'title' || tag === 'desc') return;

  const style = resolveStyle(node, parentStyle, defs);
  if (!style.display) return;

  const transform = parseTransform(attr(node, 'transform'));
  const localCtm = multiplyMatrix(ctm, transform);

  switch (tag) {
    case 'svg': case 'g': case 'a':
      for (const child of node.children) renderElement(buf, w, h, child, localCtm, style, defs);
      break;
    case 'path': renderPath(buf, w, h, node, localCtm, style, defs); break;
    case 'rect': renderRect(buf, w, h, node, localCtm, style, defs); break;
    case 'circle': renderCircle(buf, w, h, node, localCtm, style, defs); break;
    case 'ellipse': renderEllipse(buf, w, h, node, localCtm, style, defs); break;
    case 'line': renderLine(buf, w, h, node, localCtm, style, defs); break;
    case 'polyline': case 'polygon':
      renderPoly(buf, w, h, node, localCtm, style, defs, tag === 'polygon');
      break;
    case 'text': renderText(buf, w, h, node, localCtm, style, defs); break;
    case 'image': renderImage(buf, w, h, node, localCtm); break;
    case 'use': renderUse(buf, w, h, node, localCtm, style, defs); break;
  }
}

// --- Shape rendering ---

function renderShapePath(
  buf: Uint8Array, w: number, h: number,
  path: Path, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  // Fill
  if (style.fill.type === 'color') {
    const c = { ...style.fill.color };
    c.a = Math.round(c.a * style.opacity * style.fillOpacity);
    if (c.a > 0) fillPath(buf, w, h, path, ctm, c, style.fillRule);
  } else if (style.fill.type === 'gradient') {
    const grad = defs.gradients.get(style.fill.id);
    if (grad && grad.stops.length > 0) {
      const c = averageGradientColor(grad.stops, style.opacity * style.fillOpacity);
      fillPath(buf, w, h, path, ctm, c, style.fillRule);
    }
  }

  // Stroke
  if (style.stroke.type === 'color' && style.strokeWidth > 0) {
    const c = { ...style.stroke.color };
    c.a = Math.round(c.a * style.opacity * style.strokeOpacity);
    if (c.a > 0) strokePath(buf, w, h, path, ctm, c, style.strokeWidth);
  } else if (style.stroke.type === 'gradient' && style.strokeWidth > 0) {
    const grad = defs.gradients.get(style.stroke.id);
    if (grad && grad.stops.length > 0) {
      const c = averageGradientColor(grad.stops, style.opacity * style.strokeOpacity);
      strokePath(buf, w, h, path, ctm, c, style.strokeWidth);
    }
  }
}

function averageGradientColor(stops: SvgGradientStop[], opacity: number): RGBA {
  let r = 0, g = 0, b = 0, a = 0;
  for (const s of stops) {
    r += s.color.r; g += s.color.g; b += s.color.b; a += s.color.a;
  }
  const n = stops.length;
  return {
    r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n),
    a: Math.round((a / n) * opacity),
  };
}

function renderPath(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const d = attr(node, 'd');
  if (!d) return;
  const path = parseSvgPath(d);
  renderShapePath(buf, w, h, path, ctm, style, defs);
}

function renderRect(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const x = parseFloat(attr(node, 'x') ?? '0');
  const y = parseFloat(attr(node, 'y') ?? '0');
  const rw = parseFloat(attr(node, 'width') ?? '0');
  const rh = parseFloat(attr(node, 'height') ?? '0');
  if (rw <= 0 || rh <= 0) return;

  let rx = parseFloat(attr(node, 'rx') ?? '0');
  let ry = parseFloat(attr(node, 'ry') ?? '0');
  if (rx > 0 && ry === 0) ry = rx;
  if (ry > 0 && rx === 0) rx = ry;
  rx = Math.min(rx, rw / 2);
  ry = Math.min(ry, rh / 2);

  const segs: PathSegment[] = [];
  if (rx > 0 && ry > 0) {
    const kx = rx * KAPPA, ky = ry * KAPPA;
    segs.push({ type: 'move', x: x + rx, y });
    segs.push({ type: 'line', x: x + rw - rx, y });
    segs.push({ type: 'cubic', x: x + rw, y: y + ry, cx1: x + rw - rx + kx, cy1: y, cx2: x + rw, cy2: y + ry - ky });
    segs.push({ type: 'line', x: x + rw, y: y + rh - ry });
    segs.push({ type: 'cubic', x: x + rw - rx, y: y + rh, cx1: x + rw, cy1: y + rh - ry + ky, cx2: x + rw - rx + kx, cy2: y + rh });
    segs.push({ type: 'line', x: x + rx, y: y + rh });
    segs.push({ type: 'cubic', x, y: y + rh - ry, cx1: x + rx - kx, cy1: y + rh, cx2: x, cy2: y + rh - ry + ky });
    segs.push({ type: 'line', x, y: y + ry });
    segs.push({ type: 'cubic', x: x + rx, y, cx1: x, cy1: y + ry - ky, cx2: x + rx - kx, cy2: y });
  } else {
    segs.push({ type: 'move', x, y });
    segs.push({ type: 'line', x: x + rw, y });
    segs.push({ type: 'line', x: x + rw, y: y + rh });
    segs.push({ type: 'line', x, y: y + rh });
  }
  renderShapePath(buf, w, h, { subpaths: [{ segments: segs, closed: true }] }, ctm, style, defs);
}

function renderCircle(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const cx = parseFloat(attr(node, 'cx') ?? '0');
  const cy = parseFloat(attr(node, 'cy') ?? '0');
  const r = parseFloat(attr(node, 'r') ?? '0');
  if (r <= 0) return;
  renderShapePath(buf, w, h, ellipsePath(cx, cy, r, r), ctm, style, defs);
}

function renderEllipse(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const cx = parseFloat(attr(node, 'cx') ?? '0');
  const cy = parseFloat(attr(node, 'cy') ?? '0');
  const rx = parseFloat(attr(node, 'rx') ?? '0');
  const ry = parseFloat(attr(node, 'ry') ?? '0');
  if (rx <= 0 || ry <= 0) return;
  renderShapePath(buf, w, h, ellipsePath(cx, cy, rx, ry), ctm, style, defs);
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): Path {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    subpaths: [{
      segments: [
        { type: 'move', x: cx + rx, y: cy },
        { type: 'cubic', x: cx, y: cy + ry, cx1: cx + rx, cy1: cy + ky, cx2: cx + kx, cy2: cy + ry },
        { type: 'cubic', x: cx - rx, y: cy, cx1: cx - kx, cy1: cy + ry, cx2: cx - rx, cy2: cy + ky },
        { type: 'cubic', x: cx, y: cy - ry, cx1: cx - rx, cy1: cy - ky, cx2: cx - kx, cy2: cy - ry },
        { type: 'cubic', x: cx + rx, y: cy, cx1: cx + kx, cy1: cy - ry, cx2: cx + rx, cy2: cy - ky },
      ],
      closed: true,
    }],
  };
}

function renderLine(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const x1 = parseFloat(attr(node, 'x1') ?? '0');
  const y1 = parseFloat(attr(node, 'y1') ?? '0');
  const x2 = parseFloat(attr(node, 'x2') ?? '0');
  const y2 = parseFloat(attr(node, 'y2') ?? '0');
  const path: Path = {
    subpaths: [{
      segments: [{ type: 'move', x: x1, y: y1 }, { type: 'line', x: x2, y: y2 }],
      closed: false,
    }],
  };
  renderShapePath(buf, w, h, path, ctm, style, defs);
}

function renderPoly(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
  closed: boolean,
): void {
  const pts = attr(node, 'points');
  if (!pts) return;
  const nums = pts.trim().split(/[\s,]+/).map(Number);
  if (nums.length < 4) return;
  const segs: PathSegment[] = [{ type: 'move', x: nums[0], y: nums[1] }];
  for (let j = 2; j + 1 < nums.length; j += 2) {
    segs.push({ type: 'line', x: nums[j], y: nums[j + 1] });
  }
  renderShapePath(buf, w, h, { subpaths: [{ segments: segs, closed }] }, ctm, style, defs);
}

// --- Text rendering ---

function renderText(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const x = parseFloat(attr(node, 'x') ?? '0');
  const y = parseFloat(attr(node, 'y') ?? '0');

  // Parse font-size from style or attribute
  let fontSize = 16;
  const fsAttr = attr(node, 'font-size');
  if (fsAttr) { const n = parseFloat(fsAttr); if (!isNaN(n)) fontSize = n; }
  const inlineStyle = attr(node, 'style');
  if (inlineStyle) {
    const m = inlineStyle.match(/font-size\s*:\s*([\d.]+)/);
    if (m) { const n = parseFloat(m[1]); if (!isNaN(n)) fontSize = n; }
  }

  const textContent = gatherText(node);
  let curX = x;

  for (const ch of textContent) {
    const cp = ch.codePointAt(0)!;
    const advance = getFallbackWidth(cp) * fontSize / 1000;
    if (cp === 32 || cp === 0x09 || cp === 0x0A || cp === 0x0D) {
      curX += advance;
      continue;
    }

    const outline = getGlyphOutline(cp);
    const glyphScale = fontSize / 1000;
    const glyphCtm = multiplyMatrix(ctm, [glyphScale, 0, 0, -glyphScale, curX, y]);

    if (style.fill.type === 'color') {
      const c = { ...style.fill.color };
      c.a = Math.round(c.a * style.opacity * style.fillOpacity);
      if (c.a > 0) fillPath(buf, w, h, outline, glyphCtm, c, 'nonzero');
    }

    curX += advance;
  }
}

function gatherText(node: XmlNode): string {
  let text = node.text;
  for (const child of node.children) {
    if (child.tag === 'tspan') text += gatherText(child);
  }
  return text;
}

// --- Image rendering ---

function renderImage(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix,
): void {
  const href = attr(node, 'href') ?? attr(node, 'xlink:href');
  if (!href) return;

  const x = parseFloat(attr(node, 'x') ?? '0');
  const y = parseFloat(attr(node, 'y') ?? '0');
  const iw = parseFloat(attr(node, 'width') ?? '0');
  const ih = parseFloat(attr(node, 'height') ?? '0');
  if (iw <= 0 || ih <= 0) return;

  const dataMatch = href.match(/^data:image\/[^;]+;base64,(.+)$/);
  if (!dataMatch) return;

  let imageData: Uint8Array;
  try {
    imageData = Buffer.from(dataMatch[1], 'base64');
  } catch { return; }

  let decoded: PixelGrid;
  try { decoded = decodeEmbeddedImage(imageData); } catch { return; }

  // Compute destination rectangle in device space
  const [dx, dy] = transformPoint(ctm, x, y);
  const scaleFactor = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
  const dw = Math.round(iw * scaleFactor);
  const dh = Math.round(ih * scaleFactor);
  const ddx = Math.round(dx);
  const ddy = Math.round(dy);

  compositeImageYDown(buf, w, h, decoded, ddx, ddy, dw, dh);
}

function decodeEmbeddedImage(data: Uint8Array): PixelGrid {
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return decodeJpeg(data);
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return decodePng(data);
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return decodeGif(data);
  throw new Error('Unsupported embedded image format');
}

function compositeImageYDown(
  buffer: Uint8Array, bufW: number, bufH: number,
  image: PixelGrid, dx: number, dy: number, dw: number, dh: number,
): void {
  if (dw <= 0 || dh <= 0) return;
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(bufW - 1, dx + dw - 1);
  const y1 = Math.min(bufH - 1, dy + dh - 1);

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const sx = Math.floor((px - dx) * image.width / dw);
      const sy = Math.floor((py - dy) * image.height / dh);
      if (sx < 0 || sx >= image.width || sy < 0 || sy >= image.height) continue;
      const srcOff = (sy * image.width + sx) * 4;
      const dstOff = (py * bufW + px) * 4;
      const sa = image.data[srcOff + 3];
      if (sa === 0) continue;
      if (sa === 255) {
        buffer[dstOff] = image.data[srcOff];
        buffer[dstOff + 1] = image.data[srcOff + 1];
        buffer[dstOff + 2] = image.data[srcOff + 2];
        buffer[dstOff + 3] = 255;
      } else {
        const srcA = sa / 255;
        const invA = 1 - srcA;
        buffer[dstOff] = Math.round(image.data[srcOff] * srcA + buffer[dstOff] * invA);
        buffer[dstOff + 1] = Math.round(image.data[srcOff + 1] * srcA + buffer[dstOff + 1] * invA);
        buffer[dstOff + 2] = Math.round(image.data[srcOff + 2] * srcA + buffer[dstOff + 2] * invA);
        buffer[dstOff + 3] = Math.min(255, Math.round(sa + buffer[dstOff + 3] * invA));
      }
    }
  }
}

// --- <use> element ---

function renderUse(
  buf: Uint8Array, w: number, h: number,
  node: XmlNode, ctm: Matrix, style: SvgStyle, defs: SvgDefs,
): void {
  const href = attr(node, 'href') ?? attr(node, 'xlink:href');
  if (!href?.startsWith('#')) return;
  const target = defs.elements.get(href.slice(1));
  if (!target) return;
  const x = parseFloat(attr(node, 'x') ?? '0');
  const y = parseFloat(attr(node, 'y') ?? '0');
  const localCtm = multiplyMatrix(ctm, [1, 0, 0, 1, x, y]);
  renderElement(buf, w, h, target, localCtm, style, defs);
}

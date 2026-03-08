import type { Matrix, Path, PathSegment, Subpath, RGBA } from './types.ts';
import type { PixelGrid } from '../../types.ts';

// --- Matrix math ---

export function identity(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
}

function matrixScale(m: Matrix): number {
  // Approximate scale factor
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

// --- Bezier flattening ---

interface LineSegment {
  x0: number; y0: number;
  x1: number; y1: number;
}

function flattenCubic(
  x0: number, y0: number, cx1: number, cy1: number,
  cx2: number, cy2: number, x3: number, y3: number,
  result: LineSegment[], depth: number,
): void {
  if (depth > 10) {
    result.push({ x0, y0, x1: x3, y1: y3 });
    return;
  }

  // Flatness test: max distance of control points from chord
  const dx = x3 - x0;
  const dy = y3 - y0;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 0.001) {
    result.push({ x0, y0, x1: x3, y1: y3 });
    return;
  }

  const d1 = Math.abs((cx1 - x0) * dy - (cy1 - y0) * dx);
  const d2 = Math.abs((cx2 - x0) * dy - (cy2 - y0) * dx);
  const d = (d1 + d2) / Math.sqrt(lenSq);

  if (d < 0.5) {
    result.push({ x0, y0, x1: x3, y1: y3 });
    return;
  }

  // Subdivide at t=0.5
  const mx01 = (x0 + cx1) / 2, my01 = (y0 + cy1) / 2;
  const mx12 = (cx1 + cx2) / 2, my12 = (cy1 + cy2) / 2;
  const mx23 = (cx2 + x3) / 2, my23 = (cy2 + y3) / 2;
  const mx012 = (mx01 + mx12) / 2, my012 = (my01 + my12) / 2;
  const mx123 = (mx12 + mx23) / 2, my123 = (my12 + my23) / 2;
  const mx0123 = (mx012 + mx123) / 2, my0123 = (my012 + my123) / 2;

  flattenCubic(x0, y0, mx01, my01, mx012, my012, mx0123, my0123, result, depth + 1);
  flattenCubic(mx0123, my0123, mx123, my123, mx23, my23, x3, y3, result, depth + 1);
}

function flattenPath(path: Path, ctm: Matrix): LineSegment[] {
  const segments: LineSegment[] = [];

  for (const subpath of path.subpaths) {
    let curX = 0, curY = 0;
    let startX = 0, startY = 0;

    for (const seg of subpath.segments) {
      const [tx, ty] = transformPoint(ctm, seg.x, seg.y);

      if (seg.type === 'move') {
        curX = tx; curY = ty;
        startX = tx; startY = ty;
      } else if (seg.type === 'line') {
        segments.push({ x0: curX, y0: curY, x1: tx, y1: ty });
        curX = tx; curY = ty;
      } else if (seg.type === 'cubic') {
        const [tcx1, tcy1] = transformPoint(ctm, seg.cx1!, seg.cy1!);
        const [tcx2, tcy2] = transformPoint(ctm, seg.cx2!, seg.cy2!);
        flattenCubic(curX, curY, tcx1, tcy1, tcx2, tcy2, tx, ty, segments, 0);
        curX = tx; curY = ty;
      }
    }

    if (subpath.closed && (curX !== startX || curY !== startY)) {
      segments.push({ x0: curX, y0: curY, x1: startX, y1: startY });
    }
  }

  return segments;
}

// --- Scanline fill ---

interface Edge {
  yMin: number;
  yMax: number;
  x: number; // x at yMin
  dx: number; // dx per scanline
  dir: number; // +1 or -1
}

function buildEdges(segments: LineSegment[]): Edge[] {
  const edges: Edge[] = [];
  for (const seg of segments) {
    if (Math.abs(seg.y0 - seg.y1) < 0.001) continue; // skip horizontal

    const goingDown = seg.y0 < seg.y1;
    const yMin = goingDown ? seg.y0 : seg.y1;
    const yMax = goingDown ? seg.y1 : seg.y0;
    const xAtYMin = goingDown ? seg.x0 : seg.x1;
    const xAtYMax = goingDown ? seg.x1 : seg.x0;
    const dx = (xAtYMax - xAtYMin) / (yMax - yMin);

    edges.push({ yMin, yMax, x: xAtYMin, dx, dir: goingDown ? 1 : -1 });
  }
  return edges;
}

function blendPixel(buf: Uint8Array, offset: number, color: RGBA): void {
  const srcA = color.a / 255;
  const invA = 1 - srcA;
  buf[offset] = Math.round(color.r * srcA + buf[offset] * invA);
  buf[offset + 1] = Math.round(color.g * srcA + buf[offset + 1] * invA);
  buf[offset + 2] = Math.round(color.b * srcA + buf[offset + 2] * invA);
  buf[offset + 3] = Math.min(255, Math.round(color.a + buf[offset + 3] * invA));
}

export function fillPath(
  buffer: Uint8Array, width: number, height: number,
  path: Path, ctm: Matrix, color: RGBA, rule: 'nonzero' | 'evenodd',
): void {
  const segments = flattenPath(path, ctm);
  const edges = buildEdges(segments);
  if (edges.length === 0) return;

  let yMin = Infinity, yMax = -Infinity;
  for (const e of edges) {
    if (e.yMin < yMin) yMin = e.yMin;
    if (e.yMax > yMax) yMax = e.yMax;
  }

  const scanStart = Math.max(0, Math.floor(yMin));
  const scanEnd = Math.min(height - 1, Math.ceil(yMax));

  for (let y = scanStart; y <= scanEnd; y++) {
    const scanY = y + 0.5;
    const intersections: { x: number; dir: number }[] = [];

    for (const edge of edges) {
      if (scanY < edge.yMin || scanY >= edge.yMax) continue;
      const ix = edge.x + (scanY - edge.yMin) * edge.dx;
      intersections.push({ x: ix, dir: edge.dir });
    }

    intersections.sort((a, b) => a.x - b.x);

    if (rule === 'nonzero') {
      let winding = 0;
      let i = 0;
      while (i < intersections.length) {
        const startX = intersections[i].x;
        winding += intersections[i].dir;
        i++;

        while (i < intersections.length && winding !== 0) {
          winding += intersections[i].dir;
          if (winding === 0) {
            const endX = intersections[i].x;
            const x0 = Math.max(0, Math.floor(startX));
            const x1 = Math.min(width - 1, Math.floor(endX));
            for (let x = x0; x <= x1; x++) {
              blendPixel(buffer, (y * width + x) * 4, color);
            }
          }
          i++;
        }
      }
    } else {
      // Even-odd
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const x0 = Math.max(0, Math.floor(intersections[i].x));
        const x1 = Math.min(width - 1, Math.floor(intersections[i + 1].x));
        for (let x = x0; x <= x1; x++) {
          blendPixel(buffer, (y * width + x) * 4, color);
        }
      }
    }
  }
}

export function strokePath(
  buffer: Uint8Array, width: number, height: number,
  path: Path, ctm: Matrix, color: RGBA, lineWidth: number,
): void {
  const scale = matrixScale(ctm);
  const halfW = Math.max(0.5, (lineWidth * scale) / 2);
  const segments = flattenPath(path, ctm);

  for (const seg of segments) {
    strokeLine(buffer, width, height, seg.x0, seg.y0, seg.x1, seg.y1, halfW, color);
  }
}

function strokeLine(
  buffer: Uint8Array, width: number, height: number,
  x0: number, y0: number, x1: number, y1: number,
  halfW: number, color: RGBA,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return;

  // Normal direction
  const nx = -dy / len * halfW;
  const ny = dx / len * halfW;

  // Build rectangle path from the stroke line
  const corners = [
    { x: x0 + nx, y: y0 + ny },
    { x: x1 + nx, y: y1 + ny },
    { x: x1 - nx, y: y1 - ny },
    { x: x0 - nx, y: y0 - ny },
  ];

  // Scanline fill this rectangle directly
  const rectPath: Path = {
    subpaths: [{
      segments: [
        { type: 'move', x: corners[0].x, y: corners[0].y },
        { type: 'line', x: corners[1].x, y: corners[1].y },
        { type: 'line', x: corners[2].x, y: corners[2].y },
        { type: 'line', x: corners[3].x, y: corners[3].y },
      ],
      closed: true,
    }],
  };

  // Use identity CTM since corners are already in device space
  fillPath(buffer, width, height, rectPath, identity(), color, 'nonzero');
}

export function compositeImage(
  buffer: Uint8Array, bufWidth: number, bufHeight: number,
  image: PixelGrid, ctm: Matrix,
): void {
  // The CTM maps the unit square [0,0]-[1,1] to the image position on the page
  // We need to find which destination pixels are covered and sample the source image

  // Transform the 4 corners of the unit square to find the bounding box in device space
  const corners = [
    transformPoint(ctm, 0, 0),
    transformPoint(ctm, 1, 0),
    transformPoint(ctm, 0, 1),
    transformPoint(ctm, 1, 1),
  ];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
  }

  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(bufWidth - 1, Math.ceil(maxX));
  const y1 = Math.min(bufHeight - 1, Math.ceil(maxY));

  // Invert the CTM to map from device space back to unit square
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
  if (Math.abs(det) < 1e-10) return;

  const invDet = 1 / det;
  const inv: Matrix = [
    ctm[3] * invDet,
    -ctm[1] * invDet,
    -ctm[2] * invDet,
    ctm[0] * invDet,
    (ctm[2] * ctm[5] - ctm[3] * ctm[4]) * invDet,
    (ctm[1] * ctm[4] - ctm[0] * ctm[5]) * invDet,
  ];

  for (let dy = y0; dy <= y1; dy++) {
    for (let dx = x0; dx <= x1; dx++) {
      const [u, v] = transformPoint(inv, dx + 0.5, dy + 0.5);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

      const sx = Math.floor(u * image.width);
      // PDF image origin is bottom-left, but pixel data is stored top-to-bottom
      const sy = Math.min(image.height - 1, Math.floor((1 - v) * image.height));
      const srcOff = (sy * image.width + sx) * 4;
      const dstOff = (dy * bufWidth + dx) * 4;

      const sr = image.data[srcOff];
      const sg = image.data[srcOff + 1];
      const sb = image.data[srcOff + 2];
      const sa = image.data[srcOff + 3];

      blendPixel(buffer, dstOff, { r: sr, g: sg, b: sb, a: sa });
    }
  }
}

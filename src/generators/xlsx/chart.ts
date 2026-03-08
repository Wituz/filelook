import { parseXml, findChild, findChildren, attr } from '../docx/xml.ts';
import type { XmlNode } from '../docx/types.ts';
import type { Matrix, Path, RGBA } from '../pdf/types.ts';
import { fillPath, strokePath, identity } from '../pdf/rasterizer.ts';
import { getGlyphOutline, getFallbackWidth } from '../pdf/font.ts';
import type { XlsxChart, XlsxChartSeries, XlsxTheme } from './types.ts';
import { resolveThemeColor } from './model.ts';

const FALLBACK_PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
const KAPPA = 0.5522847498; // bezier approximation for quarter circle

// --- Chart XML parsing ---

export function parseChart(files: Map<string, Uint8Array>, chartPath: string, theme: XlsxTheme): XlsxChart | null {
  const data = files.get(chartPath);
  if (!data) return null;
  const xml = parseXml(new TextDecoder().decode(data));

  const chartSpace = xml;
  const chart = findChild(chartSpace, 'c', 'chart');
  if (!chart) return null;
  const plotArea = findChild(chart, 'c', 'plotArea');
  if (!plotArea) return null;

  // Detect chart type
  const typeMap: Record<string, string> = {
    doughnutChart: 'doughnut', pieChart: 'pie', barChart: 'bar',
    bar3DChart: 'bar', lineChart: 'line', scatterChart: 'scatter',
    areaChart: 'area',
  };

  let chartType = '';
  let chartNode: XmlNode | null = null;
  for (const child of plotArea.children) {
    if (child.prefix === 'c' && typeMap[child.tag]) {
      chartType = typeMap[child.tag];
      chartNode = child;
      break;
    }
  }
  if (!chartType || !chartNode) return null;

  // Parse title
  let title: string | null = null;
  const titleNode = findChild(chart, 'c', 'title');
  if (titleNode) {
    const tx = findChild(titleNode, 'c', 'tx');
    if (tx) {
      const rich = findChild(tx, 'c', 'rich');
      if (rich) {
        for (const p of findChildren(rich, 'a', 'p')) {
          for (const r of findChildren(p, 'a', 'r')) {
            const t = findChild(r, 'a', 't');
            if (t) title = (title ?? '') + t.text;
          }
        }
      }
    }
  }

  // Parse series
  const series: XlsxChartSeries[] = [];
  const categories: string[] = [];
  let categoriesParsed = false;

  for (const ser of findChildren(chartNode, 'c', 'ser')) {
    // Series name
    const tx = findChild(ser, 'c', 'tx');
    let name = '';
    if (tx) {
      const strRef = findChild(tx, 'c', 'strRef');
      if (strRef) {
        const strCache = findChild(strRef, 'c', 'strCache');
        if (strCache) {
          const pt = findChildren(strCache, 'c', 'pt')[0];
          if (pt) {
            const v = findChild(pt, 'c', 'v');
            if (v) name = v.text;
          }
        }
      }
    }

    // Values
    const values: number[] = [];
    const valNode = findChild(ser, 'c', 'val') ?? findChild(ser, 'c', 'yVal');
    if (valNode) {
      const numRef = findChild(valNode, 'c', 'numRef');
      if (numRef) {
        const numCache = findChild(numRef, 'c', 'numCache');
        if (numCache) {
          for (const pt of findChildren(numCache, 'c', 'pt')) {
            const v = findChild(pt, 'c', 'v');
            values.push(v ? parseFloat(v.text) || 0 : 0);
          }
        }
      }
    }

    // Categories (only parse once)
    if (!categoriesParsed) {
      const catNode = findChild(ser, 'c', 'cat') ?? findChild(ser, 'c', 'xVal');
      if (catNode) {
        const strRef = findChild(catNode, 'c', 'strRef');
        if (strRef) {
          const strCache = findChild(strRef, 'c', 'strCache');
          if (strCache) {
            for (const pt of findChildren(strCache, 'c', 'pt')) {
              const v = findChild(pt, 'c', 'v');
              if (v) categories.push(v.text);
            }
          }
        }
        const numRef = findChild(catNode, 'c', 'numRef');
        if (numRef && categories.length === 0) {
          const numCache = findChild(numRef, 'c', 'numCache');
          if (numCache) {
            for (const pt of findChildren(numCache, 'c', 'pt')) {
              const v = findChild(pt, 'c', 'v');
              if (v) categories.push(v.text);
            }
          }
        }
        categoriesParsed = true;
      }
    }

    // Series color — check data points first, then series-level
    let color = FALLBACK_PALETTE[series.length % FALLBACK_PALETTE.length];
    const spPr = findChild(ser, 'c', 'spPr');
    if (spPr) {
      const c = resolveSpPrColor(spPr, theme);
      if (c) color = c;
    }
    // Data point colors
    for (const dPt of findChildren(ser, 'c', 'dPt')) {
      const dpSpPr = findChild(dPt, 'c', 'spPr');
      if (dpSpPr) {
        const c = resolveSpPrColor(dpSpPr, theme);
        if (c) color = c; // last one wins for simple series color
      }
    }

    series.push({ name, values, color });
  }

  // For pie/doughnut, extract per-slice colors from dPt elements
  if ((chartType === 'doughnut' || chartType === 'pie') && series.length > 0) {
    const ser0 = findChildren(chartNode, 'c', 'ser')[0];
    if (ser0) {
      const sliceColors = extractSliceColors(ser0, theme, series[0].values.length);
      if (sliceColors.length > 0) {
        // Encode slice colors as separate single-value series
        const mainValues = series[0].values;
        series.length = 0;
        for (let i = 0; i < mainValues.length; i++) {
          series.push({
            name: categories[i] ?? `Slice ${i}`,
            values: [mainValues[i]],
            color: sliceColors[i] ?? FALLBACK_PALETTE[i % FALLBACK_PALETTE.length],
          });
        }
      }
    }
  }

  return { chartType, series, categories, title, x: 0, y: 0, width: 0, height: 0 };
}

function resolveSpPrColor(spPr: XmlNode, theme: XlsxTheme): string | null {
  const solidFill = findChild(spPr, 'a', 'solidFill');
  if (!solidFill) return null;
  const srgb = findChild(solidFill, 'a', 'srgbClr');
  if (srgb) return attr(srgb, 'val');
  const scheme = findChild(solidFill, 'a', 'schemeClr');
  if (scheme) {
    const val = attr(scheme, 'val');
    if (!val) return null;
    const aliases: Record<string, string> = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' };
    const name = aliases[val] ?? val;
    return theme.colors.get(name) ?? null;
  }
  return null;
}

function extractSliceColors(ser: XmlNode, theme: XlsxTheme, count: number): string[] {
  const colors: string[] = new Array(count).fill('');
  for (const dPt of findChildren(ser, 'c', 'dPt')) {
    const idx = findChild(dPt, 'c', 'idx');
    if (!idx) continue;
    const idxVal = parseInt(attr(idx, 'val') ?? '', 10);
    if (isNaN(idxVal) || idxVal < 0 || idxVal >= count) continue;
    const spPr = findChild(dPt, 'c', 'spPr');
    if (spPr) {
      const c = resolveSpPrColor(spPr, theme);
      if (c) colors[idxVal] = c;
    }
  }
  // Fill blanks with fallback
  for (let i = 0; i < colors.length; i++) {
    if (!colors[i]) colors[i] = FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
  }
  return colors;
}

// --- Chart renderers ---

function parseHex(hex: string): RGBA {
  if (!hex || hex.length < 6) return { r: 128, g: 128, b: 128, a: 255 };
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r: isNaN(r) ? 128 : r, g: isNaN(g) ? 128 : g, b: isNaN(b) ? 128 : b, a: 255 };
}

export function renderChart(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  switch (chart.chartType) {
    case 'doughnut': renderDoughnut(buffer, w, h, chart, scale); break;
    case 'pie': renderPie(buffer, w, h, chart, scale); break;
    case 'bar': renderBar(buffer, w, h, chart, scale); break;
    case 'line': renderLine(buffer, w, h, chart, scale); break;
    case 'scatter': renderScatter(buffer, w, h, chart, scale); break;
    case 'area': renderArea(buffer, w, h, chart, scale); break;
  }
}

// --- Doughnut / Pie ---

function buildArcPath(
  cx: number, cy: number, r: number,
  startAngle: number, sweepAngle: number,
  innerR: number,
): Path {
  const subpaths: Path['subpaths'] = [];
  const segments: Path['subpaths'][0]['segments'] = [];

  if (innerR > 0) {
    // Outer arc
    const outerSegs = arcSegments(cx, cy, r, startAngle, sweepAngle);
    segments.push(...outerSegs);
    // Line to inner arc end
    const innerEndAngle = startAngle + sweepAngle;
    segments.push({
      type: 'line',
      x: cx + innerR * Math.cos(innerEndAngle),
      y: cy + innerR * Math.sin(innerEndAngle),
    });
    // Inner arc (reversed)
    const innerSegs = arcSegments(cx, cy, innerR, startAngle + sweepAngle, -sweepAngle);
    // Skip the move, use lines
    for (let i = 1; i < innerSegs.length; i++) segments.push(innerSegs[i]);
  } else {
    // Pie wedge
    segments.push({ type: 'move', x: cx, y: cy });
    const outerSegs = arcSegments(cx, cy, r, startAngle, sweepAngle);
    // First segment is a move, convert to line
    segments.push({ type: 'line', x: outerSegs[0].x, y: outerSegs[0].y });
    for (let i = 1; i < outerSegs.length; i++) segments.push(outerSegs[i]);
  }

  subpaths.push({ segments, closed: true });
  return { subpaths };
}

function arcSegments(
  cx: number, cy: number, r: number,
  startAngle: number, sweepAngle: number,
): Path['subpaths'][0]['segments'] {
  const segments: Path['subpaths'][0]['segments'] = [];
  const numQuads = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const step = sweepAngle / numQuads;
  let angle = startAngle;

  segments.push({
    type: 'move',
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  });

  for (let i = 0; i < numQuads; i++) {
    const a1 = angle;
    const a2 = angle + step;
    const alpha = 4 * Math.tan(step / 4) / 3;

    segments.push({
      type: 'cubic',
      cx1: cx + r * (Math.cos(a1) - alpha * Math.sin(a1)),
      cy1: cy + r * (Math.sin(a1) + alpha * Math.cos(a1)),
      cx2: cx + r * (Math.cos(a2) + alpha * Math.sin(a2)),
      cy2: cy + r * (Math.sin(a2) - alpha * Math.cos(a2)),
      x: cx + r * Math.cos(a2),
      y: cy + r * Math.sin(a2),
    });

    angle = a2;
  }

  return segments;
}

function renderDoughnut(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  const cx = (chart.x + chart.width / 2) * scale;
  const cy = (chart.y + chart.height / 2) * scale;
  const outerR = Math.min(chart.width, chart.height) / 2 * 0.85 * scale;
  const innerR = outerR * 0.5;

  const total = chart.series.reduce((s, ser) => s + ser.values.reduce((a, b) => a + b, 0), 0);
  if (total === 0) return;

  let angle = -Math.PI / 2; // Start at top
  for (const ser of chart.series) {
    const val = ser.values.reduce((a, b) => a + b, 0);
    const sweep = (val / total) * Math.PI * 2;
    if (sweep < 0.001) { angle += sweep; continue; }

    const path = buildArcPath(cx, cy, outerR, angle, sweep, innerR);
    fillPath(buffer, w, h, path, identity(), parseHex(ser.color), 'nonzero');
    angle += sweep;
  }
}

function renderPie(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  const cx = (chart.x + chart.width / 2) * scale;
  const cy = (chart.y + chart.height / 2) * scale;
  const radius = Math.min(chart.width, chart.height) / 2 * 0.85 * scale;

  const total = chart.series.reduce((s, ser) => s + ser.values.reduce((a, b) => a + b, 0), 0);
  if (total === 0) return;

  let angle = -Math.PI / 2;
  for (const ser of chart.series) {
    const val = ser.values.reduce((a, b) => a + b, 0);
    const sweep = (val / total) * Math.PI * 2;
    if (sweep < 0.001) { angle += sweep; continue; }

    const path = buildArcPath(cx, cy, radius, angle, sweep, 0);
    fillPath(buffer, w, h, path, identity(), parseHex(ser.color), 'nonzero');
    angle += sweep;
  }
}

// --- Bar chart ---

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice: number;
  if (round) {
    nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  } else {
    nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  }
  return nice * Math.pow(10, exp);
}

function calcAxisRange(min: number, max: number): { min: number; max: number; step: number } {
  if (max === min) { max = min + 1; }
  const range = niceNum(max - min, false);
  const step = niceNum(range / 5, true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  return { min: niceMin, max: niceMax, step };
}

function renderBar(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  const plotLeft = (chart.x + 50) * scale;
  const plotRight = (chart.x + chart.width - 10) * scale;
  const plotTop = (chart.y + 10) * scale;
  const plotBottom = (chart.y + chart.height - 25) * scale;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Find data range
  let dataMin = Infinity, dataMax = -Infinity;
  for (const ser of chart.series) {
    for (const v of ser.values) {
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
  }
  if (dataMin > 0) dataMin = 0;
  const axis = calcAxisRange(dataMin, dataMax);

  const numCats = chart.categories.length || (chart.series[0]?.values.length ?? 0);
  if (numCats === 0) return;
  const numSeries = chart.series.length;
  const catWidth = plotW / numCats;
  const barWidth = (catWidth / Math.max(numSeries, 1)) * 0.7;
  const barGap = (catWidth - barWidth * numSeries) / 2;

  // Draw bars
  for (let s = 0; s < numSeries; s++) {
    const ser = chart.series[s];
    for (let c = 0; c < ser.values.length; c++) {
      const val = ser.values[c];
      const barH = ((val - axis.min) / (axis.max - axis.min)) * plotH;
      const bx = plotLeft + c * catWidth + barGap + s * barWidth;
      const by = plotBottom - barH;

      const path: Path = {
        subpaths: [{
          segments: [
            { type: 'move', x: bx, y: by },
            { type: 'line', x: bx + barWidth, y: by },
            { type: 'line', x: bx + barWidth, y: plotBottom },
            { type: 'line', x: bx, y: plotBottom },
          ],
          closed: true,
        }],
      };
      fillPath(buffer, w, h, path, identity(), parseHex(ser.color), 'nonzero');
    }
  }

  // Axis lines
  renderAxisLine(buffer, w, h, plotLeft, plotBottom, plotRight, plotBottom);
  renderAxisLine(buffer, w, h, plotLeft, plotTop, plotLeft, plotBottom);
}

// --- Line chart ---

function renderLine(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  const plotLeft = (chart.x + 50) * scale;
  const plotRight = (chart.x + chart.width - 10) * scale;
  const plotTop = (chart.y + 10) * scale;
  const plotBottom = (chart.y + chart.height - 25) * scale;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  let dataMin = Infinity, dataMax = -Infinity;
  for (const ser of chart.series) {
    for (const v of ser.values) {
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
  }
  if (dataMin > 0) dataMin = 0;
  const axis = calcAxisRange(dataMin, dataMax);
  const numPts = chart.series[0]?.values.length ?? 0;
  if (numPts === 0) return;

  for (const ser of chart.series) {
    const segments: Path['subpaths'][0]['segments'] = [];
    for (let i = 0; i < ser.values.length; i++) {
      const px = plotLeft + (i / Math.max(numPts - 1, 1)) * plotW;
      const py = plotBottom - ((ser.values[i] - axis.min) / (axis.max - axis.min)) * plotH;
      segments.push({ type: i === 0 ? 'move' : 'line', x: px, y: py });
    }
    const path: Path = { subpaths: [{ segments, closed: false }] };
    strokePath(buffer, w, h, path, identity(), parseHex(ser.color), 2);

    // Data point dots
    for (let i = 0; i < ser.values.length; i++) {
      const px = plotLeft + (i / Math.max(numPts - 1, 1)) * plotW;
      const py = plotBottom - ((ser.values[i] - axis.min) / (axis.max - axis.min)) * plotH;
      renderDot(buffer, w, h, px, py, 3, parseHex(ser.color));
    }
  }

  renderAxisLine(buffer, w, h, plotLeft, plotBottom, plotRight, plotBottom);
  renderAxisLine(buffer, w, h, plotLeft, plotTop, plotLeft, plotBottom);
}

// --- Scatter chart ---

function renderScatter(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  // Simplified: treat values as y, index as x
  renderLine(buffer, w, h, chart, scale);
}

// --- Area chart ---

function renderArea(
  buffer: Uint8Array, w: number, h: number,
  chart: XlsxChart, scale: number,
): void {
  const plotLeft = (chart.x + 50) * scale;
  const plotRight = (chart.x + chart.width - 10) * scale;
  const plotTop = (chart.y + 10) * scale;
  const plotBottom = (chart.y + chart.height - 25) * scale;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  let dataMin = Infinity, dataMax = -Infinity;
  for (const ser of chart.series) {
    for (const v of ser.values) {
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
  }
  if (dataMin > 0) dataMin = 0;
  const axis = calcAxisRange(dataMin, dataMax);
  const numPts = chart.series[0]?.values.length ?? 0;
  if (numPts === 0) return;

  for (const ser of chart.series) {
    const segments: Path['subpaths'][0]['segments'] = [];
    // Start at bottom-left
    segments.push({ type: 'move', x: plotLeft, y: plotBottom });
    for (let i = 0; i < ser.values.length; i++) {
      const px = plotLeft + (i / Math.max(numPts - 1, 1)) * plotW;
      const py = plotBottom - ((ser.values[i] - axis.min) / (axis.max - axis.min)) * plotH;
      segments.push({ type: 'line', x: px, y: py });
    }
    // Close back to bottom-right then bottom-left
    segments.push({ type: 'line', x: plotLeft + plotW, y: plotBottom });
    const path: Path = { subpaths: [{ segments, closed: true }] };
    const color = parseHex(ser.color);
    color.a = 128;
    fillPath(buffer, w, h, path, identity(), color, 'nonzero');
  }

  renderAxisLine(buffer, w, h, plotLeft, plotBottom, plotRight, plotBottom);
  renderAxisLine(buffer, w, h, plotLeft, plotTop, plotLeft, plotBottom);
}

// --- Helpers ---

function renderAxisLine(
  buffer: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const path: Path = {
    subpaths: [{ segments: [
      { type: 'move', x: x0, y: y0 },
      { type: 'line', x: x1, y: y1 },
    ], closed: false }],
  };
  strokePath(buffer, w, h, path, identity(), { r: 128, g: 128, b: 128, a: 255 }, 1);
}

function renderDot(
  buffer: Uint8Array, w: number, h: number,
  cx: number, cy: number, r: number, color: RGBA,
): void {
  // Approximate circle with 4 cubic beziers
  const segments: Path['subpaths'][0]['segments'] = [
    { type: 'move', x: cx + r, y: cy },
    { type: 'cubic', cx1: cx + r, cy1: cy + r * KAPPA, cx2: cx + r * KAPPA, cy2: cy + r, x: cx, y: cy + r },
    { type: 'cubic', cx1: cx - r * KAPPA, cy1: cy + r, cx2: cx - r, cy2: cy + r * KAPPA, x: cx - r, y: cy },
    { type: 'cubic', cx1: cx - r, cy1: cy - r * KAPPA, cx2: cx - r * KAPPA, cy2: cy - r, x: cx, y: cy - r },
    { type: 'cubic', cx1: cx + r * KAPPA, cy1: cy - r, cx2: cx + r, cy2: cy - r * KAPPA, x: cx + r, y: cy },
  ];
  fillPath(buffer, w, h, { subpaths: [{ segments, closed: true }] }, identity(), color, 'nonzero');
}

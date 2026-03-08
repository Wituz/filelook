import type { PixelGrid } from '../../types.ts';
import type { Matrix, Path, RGBA } from '../pdf/types.ts';
import { fillPath, strokePath, identity } from '../pdf/rasterizer.ts';
import { getGlyphOutline, getFallbackWidth } from '../pdf/font.ts';
import { decodeJpeg } from '../jpeg/decoder.ts';
import { decodePng } from '../png/decoder.ts';
import { extractFiles } from './zip.ts';
import { parseDocxModel } from './model.ts';
import { layoutDocument } from './layout.ts';
import type {
  LayoutLine, LayoutTextItem, LayoutImageItem,
  LayoutFloatingImage, LayoutBackground, LayoutBorderLine,
} from './types.ts';

const MAX_DIM = 1024;

function parseHexColor(hex: string | null): RGBA {
  if (!hex || hex.length < 6) return { r: 0, g: 0, b: 0, a: 255 };
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r: isNaN(r) ? 0 : r, g: isNaN(g) ? 0 : g, b: isNaN(b) ? 0 : b, a: 255 };
}

export function decodeDocx(data: Uint8Array): PixelGrid {
  const files = extractFiles(data);
  const { doc, floats } = parseDocxModel(files);
  const layout = layoutDocument(doc, floats);

  // Compute scale to fit page into MAX_DIM
  const scaleX = MAX_DIM / doc.pageWidth;
  const scaleY = MAX_DIM / doc.pageHeight;
  const scale = Math.min(scaleX, scaleY);

  const width = Math.round(doc.pageWidth * scale);
  const height = Math.round(doc.pageHeight * scale);
  const buffer = new Uint8Array(width * height * 4);

  // White background
  buffer.fill(255);

  // Render backgrounds
  for (const bg of layout.backgrounds) {
    renderBackground(buffer, width, height, bg, scale);
  }

  // Render table borders
  for (const border of layout.tableBorders) {
    renderBorderLine(buffer, width, height, border, scale);
  }

  // Render paragraph borders
  for (const border of layout.borders) {
    renderBorderLine(buffer, width, height, border, scale);
  }

  // Render text lines
  for (const line of layout.lines) {
    renderLine(buffer, width, height, line, scale, doc.images);
  }

  // Render floating images
  for (const fi of layout.floatingImages) {
    renderFloatingImage(buffer, width, height, fi, doc.images, scale);
  }

  return { width, height, data: buffer };
}

function renderLine(buffer: Uint8Array, w: number, h: number, line: LayoutLine, scale: number, images: Map<string, Uint8Array>): void {
  for (const item of line.items) {
    if (item.type === 'text') {
      renderTextItem(buffer, w, h, line, item, scale);
    } else if (item.type === 'image') {
      renderInlineImage(buffer, w, h, line, item, scale, images);
    }
  }

  // Render underlines
  for (const item of line.items) {
    if (item.type === 'text' && item.underline) {
      // Find contiguous underlined spans
      const x0 = (line.x + item.x) * scale;
      const nextItem = findNextItem(line.items, item);
      const charWidth = getGlyphOutline(item.char) ? measureRenderedChar(item.char, item.fontSize, item.bold) : 0;
      const x1 = (line.x + item.x + charWidth) * scale;
      const underY = (line.y + item.fontSize * 1.05) * scale;

      if (x1 > x0) {
        const path: Path = {
          subpaths: [{
            segments: [
              { type: 'move', x: x0, y: underY },
              { type: 'line', x: x1, y: underY },
            ],
            closed: false,
          }],
        };
        const color = parseHexColor(item.color);
        strokePath(buffer, w, h, path, identity(), color, 0.5 * scale);
      }
    }
  }
}

function measureRenderedChar(cp: number, fontSize: number, bold: boolean): number {
  return getFallbackWidth(cp) * fontSize / 1000 * (bold ? 1.05 : 1);
}

function findNextItem(items: (LayoutTextItem | LayoutImageItem)[], current: LayoutTextItem): LayoutTextItem | null {
  const idx = items.indexOf(current);
  if (idx < 0 || idx + 1 >= items.length) return null;
  const next = items[idx + 1];
  return next.type === 'text' ? next : null;
}

function renderTextItem(buffer: Uint8Array, w: number, h: number, line: LayoutLine, item: LayoutTextItem, scale: number): void {
  const cp = item.char;
  if (cp === 32 || cp === 0x09) return; // don't render spaces/tabs

  const outline = getGlyphOutline(cp);
  const fontSize = item.fontSize;
  const glyphScale = fontSize * scale / 1000;
  const x = (line.x + item.x) * scale;
  const y = (line.y + fontSize) * scale; // baseline

  // Y-down coordinate system: glyph Y is up, so we negate it
  const ctm: Matrix = [glyphScale, 0, 0, -glyphScale, x, y];
  const color = parseHexColor(item.color);

  fillPath(buffer, w, h, outline, ctm, color, 'nonzero');
}

function renderInlineImage(buffer: Uint8Array, w: number, h: number, line: LayoutLine, item: LayoutImageItem, scale: number, images: Map<string, Uint8Array>): void {
  const imageData = images.get(item.rId);
  if (!imageData) return;

  let decoded: PixelGrid;
  try {
    decoded = decodeEmbeddedImage(imageData);
  } catch {
    return;
  }

  const dx = Math.round((line.x + item.x) * scale);
  const dy = Math.round(line.y * scale);
  const dw = Math.round(item.width * scale);
  const dh = Math.round(item.height * scale);

  compositeImageDocx(buffer, w, h, decoded, dx, dy, dw, dh);
}

function renderBackground(buffer: Uint8Array, w: number, h: number, bg: LayoutBackground, scale: number): void {
  const color = parseHexColor(bg.color);
  const x0 = Math.max(0, Math.floor(bg.x * scale));
  const y0 = Math.max(0, Math.floor(bg.y * scale));
  const x1 = Math.min(w - 1, Math.floor((bg.x + bg.width) * scale));
  const y1 = Math.min(h - 1, Math.floor((bg.y + bg.height) * scale));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const off = (y * w + x) * 4;
      buffer[off] = color.r;
      buffer[off + 1] = color.g;
      buffer[off + 2] = color.b;
      buffer[off + 3] = 255;
    }
  }
}

function renderBorderLine(buffer: Uint8Array, w: number, h: number, border: LayoutBorderLine, scale: number): void {
  const path: Path = {
    subpaths: [{
      segments: [
        { type: 'move', x: border.x0 * scale, y: border.y0 * scale },
        { type: 'line', x: border.x1 * scale, y: border.y1 * scale },
      ],
      closed: false,
    }],
  };
  const color = parseHexColor(border.color);
  strokePath(buffer, w, h, path, identity(), color, Math.max(0.5, border.width * scale));
}

function renderFloatingImage(
  buffer: Uint8Array, w: number, h: number,
  fi: LayoutFloatingImage, images: Map<string, Uint8Array>, scale: number,
): void {
  const imageData = images.get(fi.rId);
  if (!imageData) return;

  let decoded: PixelGrid;
  try {
    decoded = decodeEmbeddedImage(imageData);
  } catch {
    return; // silently skip corrupted images
  }

  const dx = Math.round(fi.x * scale);
  const dy = Math.round(fi.y * scale);
  const dw = Math.round(fi.width * scale);
  const dh = Math.round(fi.height * scale);

  compositeImageDocx(buffer, w, h, decoded, dx, dy, dw, dh);
}

function decodeEmbeddedImage(data: Uint8Array): PixelGrid {
  // Detect by magic bytes
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    return decodeJpeg(data);
  }
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return decodePng(data);
  }
  throw new Error('Unsupported embedded image format');
}

// DOCX-specific image compositor — Y-down, no flip
function compositeImageDocx(
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
      // Map destination pixel to source
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

import type { PixelGrid } from '../../types.ts';
import type { Matrix, RGBA, Path } from '../pdf/types.ts';
import { fillPath, identity } from '../pdf/rasterizer.ts';
import { getGlyphOutline, getFallbackWidth } from '../pdf/font.ts';
import { decodeJpeg } from '../jpeg/decoder.ts';
import { decodePng } from '../png/decoder.ts';
import { decodeGif } from '../gif/decoder.ts';
import { extractFiles } from '../docx/zip.ts';
import { parsePptxSlide } from './model.ts';
import type { PptxSlide, PptxTextShape, PptxPictureShape, PptxParagraph, PptxRun } from './types.ts';

const MAX_DIM = 1024;

function parseHexColor(hex: string | null): RGBA {
  if (!hex || hex.length < 6) return { r: 0, g: 0, b: 0, a: 255 };
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r: isNaN(r) ? 0 : r, g: isNaN(g) ? 0 : g, b: isNaN(b) ? 0 : b, a: 255 };
}

export function decodePptx(data: Uint8Array): PixelGrid {
  const files = extractFiles(data);
  const { slide, images } = parsePptxSlide(files);

  const scaleX = MAX_DIM / slide.width;
  const scaleY = MAX_DIM / slide.height;
  const scale = Math.min(scaleX, scaleY);

  const width = Math.round(slide.width * scale);
  const height = Math.round(slide.height * scale);
  const buffer = new Uint8Array(width * height * 4);

  // Fill background
  if (slide.background) {
    const bg = parseHexColor(slide.background);
    for (let i = 0; i < width * height; i++) {
      buffer[i * 4] = bg.r;
      buffer[i * 4 + 1] = bg.g;
      buffer[i * 4 + 2] = bg.b;
      buffer[i * 4 + 3] = 255;
    }
  } else {
    // White background
    buffer.fill(255);
  }

  // Render shapes in document order (painter's algorithm)
  for (const shape of slide.shapes) {
    if (shape.type === 'picture') {
      renderPicture(buffer, width, height, shape, images, scale);
    } else if (shape.type === 'text') {
      renderTextShape(buffer, width, height, shape, scale);
    }
  }

  return { width, height, data: buffer };
}

function renderPicture(
  buffer: Uint8Array, w: number, h: number,
  shape: PptxPictureShape, images: Map<string, Uint8Array>, scale: number,
): void {
  const imageData = images.get(shape.rId);
  if (!imageData) return;

  let decoded: PixelGrid;
  try {
    decoded = decodeEmbeddedImage(imageData);
  } catch {
    return;
  }

  const dx = Math.round(shape.x * scale);
  const dy = Math.round(shape.y * scale);
  const dw = Math.round(shape.width * scale);
  const dh = Math.round(shape.height * scale);

  compositeImage(buffer, w, h, decoded, dx, dy, dw, dh);
}

function renderTextShape(
  buffer: Uint8Array, w: number, h: number,
  shape: PptxTextShape, scale: number,
): void {
  // Fill shape background
  if (shape.fill) {
    const color = parseHexColor(shape.fill);
    const x0 = Math.max(0, Math.floor(shape.x * scale));
    const y0 = Math.max(0, Math.floor(shape.y * scale));
    const x1 = Math.min(w - 1, Math.floor((shape.x + shape.width) * scale));
    const y1 = Math.min(h - 1, Math.floor((shape.y + shape.height) * scale));

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const off = (py * w + px) * 4;
        buffer[off] = color.r;
        buffer[off + 1] = color.g;
        buffer[off + 2] = color.b;
        buffer[off + 3] = 255;
      }
    }
  }

  // Layout and render text
  const margin = 4; // small internal margin in points
  const textX = shape.x + margin;
  const textWidth = shape.width - margin * 2;
  const shapeBottom = shape.y + shape.height;

  // Pre-layout all paragraphs to compute total text height for vertical centering
  const allParaLines: { para: PptxParagraph; lines: LayoutLine[] }[] = [];
  let totalTextHeight = 0;
  for (const para of shape.paragraphs) {
    const lines = layoutParagraph(para, textWidth);
    allParaLines.push({ para, lines });
    totalTextHeight += para.spaceBefore;
    for (const line of lines) totalTextHeight += line.fontSize * 1.2;
    totalTextHeight += para.spaceAfter;
  }

  // Vertical anchor: t=top, ctr=center, b=bottom
  const availableHeight = shape.height - margin * 2;
  let curY = shape.y + margin;
  if (totalTextHeight < availableHeight) {
    if (shape.anchor === 'ctr') curY += (availableHeight - totalTextHeight) / 2;
    else if (shape.anchor === 'b') curY += availableHeight - totalTextHeight;
  }

  for (const { para, lines } of allParaLines) {
    curY += para.spaceBefore;
    if (curY >= shapeBottom) break;

    for (const line of lines) {
      if (curY >= shapeBottom) break;

      // Compute line X based on alignment
      let lineX = textX;
      if (para.alignment === 'center') {
        lineX = textX + (textWidth - line.width) / 2;
      } else if (para.alignment === 'right') {
        lineX = textX + textWidth - line.width;
      }

      // Render shadow pass first, then foreground
      for (const glyph of line.glyphs) {
        if (glyph.char === 32 || glyph.char === 0x09 || !glyph.shadow) continue;
        const outline = getGlyphOutline(glyph.char);
        const glyphScale = glyph.fontSize * scale / 1000;
        const shadowOff = Math.max(1, Math.round(glyph.fontSize * scale * 0.04));
        const x = (lineX + glyph.x) * scale + shadowOff;
        const y = (curY + glyph.fontSize) * scale + shadowOff;
        const ctm: Matrix = [glyphScale, 0, 0, -glyphScale, x, y];
        fillPath(buffer, w, h, outline, ctm, { r: 0, g: 0, b: 0, a: 100 }, 'nonzero');
      }

      // Render foreground glyphs
      for (const glyph of line.glyphs) {
        if (glyph.char === 32 || glyph.char === 0x09) continue;
        const outline = getGlyphOutline(glyph.char);
        const glyphScale = glyph.fontSize * scale / 1000;
        const x = (lineX + glyph.x) * scale;
        const y = (curY + glyph.fontSize) * scale;
        const ctm: Matrix = [glyphScale, 0, 0, -glyphScale, x, y];
        const color = parseHexColor(glyph.color);
        fillPath(buffer, w, h, outline, ctm, color, 'nonzero');
      }

      curY += line.fontSize * 1.2; // line height
    }

    curY += para.spaceAfter;
  }
}

interface LayoutGlyph {
  char: number;
  x: number;
  fontSize: number;
  bold: boolean;
  color: string | null;
  shadow: boolean;
}

interface LayoutLine {
  glyphs: LayoutGlyph[];
  width: number;
  fontSize: number;
}

function layoutParagraph(para: PptxParagraph, maxWidth: number): LayoutLine[] {
  const lines: LayoutLine[] = [];
  let glyphs: LayoutGlyph[] = [];
  let x = 0;
  let maxFontSize = 0;
  let lastSpaceIdx = -1;
  let lastSpaceX = 0;

  // Add bullet if present
  if (para.bullet && para.runs.length > 0) {
    const bulletFontSize = para.runs[0].fontSize;
    const bulletWidth = measureChar(para.bullet.codePointAt(0)!, bulletFontSize, false);
    glyphs.push({ char: para.bullet.codePointAt(0)!, x, fontSize: bulletFontSize, bold: false, color: para.runs[0].color, shadow: para.runs[0].shadow });
    x += bulletWidth;
    // Space after bullet
    x += measureChar(32, bulletFontSize, false);
    maxFontSize = Math.max(maxFontSize, bulletFontSize);
  }

  for (const run of para.runs) {
    maxFontSize = Math.max(maxFontSize, run.fontSize);
    for (const ch of run.text) {
      const cp = ch.codePointAt(0)!;
      const charW = measureChar(cp, run.fontSize, run.bold);

      if (cp === 32) {
        lastSpaceIdx = glyphs.length;
        lastSpaceX = x;
      }

      // Word wrap
      if (x + charW > maxWidth && glyphs.length > 0 && cp !== 32) {
        if (lastSpaceIdx >= 0) {
          // Break at last space
          const lineGlyphs = glyphs.slice(0, lastSpaceIdx);
          lines.push({ glyphs: lineGlyphs, width: lastSpaceX, fontSize: maxFontSize });

          // Start new line with remaining glyphs
          const remaining = glyphs.slice(lastSpaceIdx + 1);
          const offsetX = glyphs[lastSpaceIdx + 1]?.x ?? x;
          glyphs = remaining.map(g => ({ ...g, x: g.x - offsetX }));
          x -= offsetX;
          lastSpaceIdx = -1;
          lastSpaceX = 0;
        } else {
          // No space found, break at current position
          lines.push({ glyphs, width: x, fontSize: maxFontSize });
          glyphs = [];
          x = 0;
          lastSpaceIdx = -1;
          lastSpaceX = 0;
        }
      }

      glyphs.push({ char: cp, x, fontSize: run.fontSize, bold: run.bold, color: run.color, shadow: run.shadow });
      x += charW;
    }
  }

  if (glyphs.length > 0) {
    lines.push({ glyphs, width: x, fontSize: maxFontSize || 18 });
  }

  return lines;
}

function measureChar(cp: number, fontSize: number, bold: boolean): number {
  return getFallbackWidth(cp) * fontSize / 1000 * (bold ? 1.05 : 1);
}

function decodeEmbeddedImage(data: Uint8Array): PixelGrid {
  // JPEG
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    return decodeJpeg(data);
  }
  // PNG
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return decodePng(data);
  }
  // GIF
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return decodeGif(data);
  }
  throw new Error('Unsupported embedded image format');
}

// Y-down image compositor, no flip (same as DOCX)
function compositeImage(
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

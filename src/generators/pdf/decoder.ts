import type { PixelGrid } from '../../types.ts';
import { PdfParser } from './parser.ts';
import { PageRenderer } from './renderer.ts';

export function decodePdf(data: Uint8Array): PixelGrid {
  const parser = new PdfParser(data);
  const page = parser.parse();

  // Render at a reasonable internal resolution based on MediaBox aspect ratio
  const [x0, y0, x1, y1] = page.mediaBox;
  const pageW = Math.abs(x1 - x0);
  const pageH = Math.abs(y1 - y0);

  // Handle rotation swapping dimensions
  const rotate = page.rotate % 360;
  const effectiveW = (rotate === 90 || rotate === 270) ? pageH : pageW;
  const effectiveH = (rotate === 90 || rotate === 270) ? pageW : pageH;

  const maxDim = 1024;
  let renderW: number;
  let renderH: number;

  if (effectiveW >= effectiveH) {
    renderW = maxDim;
    renderH = Math.max(1, Math.round(maxDim * (effectiveH / effectiveW)));
  } else {
    renderH = maxDim;
    renderW = Math.max(1, Math.round(maxDim * (effectiveW / effectiveH)));
  }

  const renderer = new PageRenderer(page, renderW, renderH);
  renderer.setParser(parser);
  return renderer.render();
}

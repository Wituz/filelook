import type { PixelGrid, FitMode } from './types.ts';

interface ScaledRect {
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  dstX: number;
  dstY: number;
  dstW: number;
  dstH: number;
}

function computeScaledRect(
  srcW: number, srcH: number, dstW: number, dstH: number, fit: FitMode,
): ScaledRect {
  if (fit === 'fill') {
    return { srcX: 0, srcY: 0, srcW, srcH, dstX: 0, dstY: 0, dstW, dstH };
  }

  const scaleX = dstW / srcW;
  const scaleY = dstH / srcH;

  if (fit === 'cover') {
    // Crop source to fit destination aspect ratio
    const scale = Math.max(scaleX, scaleY);
    const cropW = Math.round(dstW / scale);
    const cropH = Math.round(dstH / scale);
    return {
      srcX: Math.round((srcW - cropW) / 2),
      srcY: Math.round((srcH - cropH) / 2),
      srcW: cropW, srcH: cropH,
      dstX: 0, dstY: 0, dstW, dstH,
    };
  }

  // contain: letterbox with transparent pixels
  const scale = Math.min(scaleX, scaleY);
  const outW = Math.round(srcW * scale);
  const outH = Math.round(srcH * scale);
  return {
    srcX: 0, srcY: 0, srcW, srcH,
    dstX: Math.round((dstW - outW) / 2),
    dstY: Math.round((dstH - outH) / 2),
    dstW: outW, dstH: outH,
  };
}

function sampleBilinear(
  src: Uint8Array, w: number, x: number, y: number,
): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = y0 + 1; // clamped by caller
  const fx = x - x0;
  const fy = y - y0;

  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const tl = src[(y0 * w + x0) * 4 + c];
    const tr = src[(y0 * w + x1) * 4 + c];
    const bl = src[(y1 * w + x0) * 4 + c];
    const br = src[(y1 * w + x1) * 4 + c];
    const top = tl + (tr - tl) * fx;
    const bottom = bl + (br - bl) * fx;
    result[c] = Math.round(top + (bottom - top) * fy);
  }
  return result;
}

export function resize(source: PixelGrid, targetWidth: number, targetHeight: number, fit: FitMode): PixelGrid {
  if (source.width === targetWidth && source.height === targetHeight) return source;

  const rect = computeScaledRect(source.width, source.height, targetWidth, targetHeight, fit);
  const out = new Uint8Array(targetWidth * targetHeight * 4);

  for (let dy = 0; dy < rect.dstH; dy++) {
    const srcY = Math.min(rect.srcY + (dy / rect.dstH) * rect.srcH, source.height - 1);
    for (let dx = 0; dx < rect.dstW; dx++) {
      const srcX = Math.min(rect.srcX + (dx / rect.dstW) * rect.srcW, source.width - 1);
      const [r, g, b, a] = sampleBilinear(source.data, source.width, srcX, srcY);
      const i = ((rect.dstY + dy) * targetWidth + (rect.dstX + dx)) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }

  return { width: targetWidth, height: targetHeight, data: out };
}

import type { PixelGrid } from '../../types.ts';
import { extractFiles } from '../docx/zip.ts';
import { renderDocumentToPixels } from '../docx/decoder.ts';
import { parseOdtModel } from './model.ts';

export function decodeOdt(data: Uint8Array): PixelGrid {
  const files = extractFiles(data);
  const { doc, floats } = parseOdtModel(files);
  return renderDocumentToPixels(doc, floats);
}

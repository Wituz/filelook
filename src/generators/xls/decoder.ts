import type { PixelGrid } from '../../types.ts';
import { extractOle2Streams } from './ole2.ts';
import { readBiffRecords } from './biff.ts';
import { parseXlsModel } from './model.ts';
import { renderSpreadsheet } from '../xlsx/decoder.ts';

export function decodeXls(data: Uint8Array): PixelGrid {
  const streams = extractOle2Streams(data);
  const wb = streams.get('Workbook') ?? streams.get('Book');
  if (!wb) throw new Error('Invalid XLS: no Workbook stream');
  const records = readBiffRecords(wb);
  const workbook = parseXlsModel(records);
  return renderSpreadsheet(workbook).pixels;
}

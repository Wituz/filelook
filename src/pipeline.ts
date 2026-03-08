import { readFileSync } from 'node:fs';
import type { ThumbnailInput, ThumbnailOptions, ResolvedOptions } from './types.ts';
import { detectType } from './detect.ts';
import { resize } from './resize.ts';
import { encodePng } from './encode-png.ts';
import { Generator } from './generator.ts';
import { JpegGenerator } from './generators/jpeg/index.ts';
import { PngGenerator } from './generators/png/index.ts';
import { BmpGenerator } from './generators/bmp/index.ts';
import { GifGenerator } from './generators/gif/index.ts';
import { WebpGenerator } from './generators/webp/index.ts';
import { IcoGenerator } from './generators/ico/index.ts';
import { TiffGenerator } from './generators/tiff/index.ts';
import { PnmGenerator } from './generators/pnm/index.ts';
import { QoiGenerator } from './generators/qoi/index.ts';
import { DdsGenerator } from './generators/dds/index.ts';
import { PsdGenerator } from './generators/psd/index.ts';
import { PcxGenerator } from './generators/pcx/index.ts';
import { TgaGenerator } from './generators/tga/index.ts';
import { OdtGenerator } from './generators/odt/index.ts';
import { PptxGenerator } from './generators/pptx/index.ts';
import { XlsxGenerator } from './generators/xlsx/index.ts';
import { XlsGenerator } from './generators/xls/index.ts';
import { DocGenerator } from './generators/doc/index.ts';
import { DocxGenerator } from './generators/docx/index.ts';
import { PdfGenerator } from './generators/pdf/index.ts';
import { SvgGenerator } from './generators/svg/index.ts';
import { CsvGenerator } from './generators/csv/index.ts';

const generators: readonly Generator[] = [
  new JpegGenerator(),
  new PngGenerator(),
  new BmpGenerator(),
  new GifGenerator(),
  new WebpGenerator(),
  new IcoGenerator(),
  new TiffGenerator(),
  new PnmGenerator(),
  new QoiGenerator(),
  new DdsGenerator(),
  new PsdGenerator(),
  new OdtGenerator(),
  new PptxGenerator(),
  new XlsxGenerator(),
  new DocGenerator(),
  new XlsGenerator(),
  new DocxGenerator(),
  new PdfGenerator(),
  new SvgGenerator(),
  new CsvGenerator(),
  new PcxGenerator(),
  new TgaGenerator(),
];

const DEFAULTS: ResolvedOptions = {
  width: 256,
  height: 256,
  type: null,
  fit: 'cover',
};

function resolveOptions(options?: ThumbnailOptions): ResolvedOptions {
  return {
    width: options?.width ?? DEFAULTS.width,
    height: options?.height ?? DEFAULTS.height,
    type: options?.type ?? DEFAULTS.type,
    fit: options?.fit ?? DEFAULTS.fit,
  };
}

function loadInput(input: ThumbnailInput): Uint8Array {
  if (Buffer.isBuffer(input)) return new Uint8Array(input);
  if (typeof input === 'string') return new Uint8Array(readFileSync(input));
  throw new Error('Input must be a file path (string) or Buffer');
}

export function generateThumbnail(input: ThumbnailInput, options?: ThumbnailOptions): Buffer {
  const resolved = resolveOptions(options);
  const data = loadInput(input);

  const type = resolved.type ?? detectType(data, generators);
  if (!type) throw new Error('Could not detect file type');

  const generator = generators.find(g => g.canHandle(type));
  if (!generator) throw new Error(`No generator for type: ${type}`);

  const pixels = generator.decode(data);
  const resized = resize(pixels, resolved.width, resolved.height, resolved.fit);
  return Buffer.from(encodePng(resized));
}

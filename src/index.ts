import { writeFileSync } from 'node:fs';
import { generateThumbnail } from './pipeline.ts';
import type { ThumbnailInput, ThumbnailOptions } from './types.ts';

export type { ThumbnailOptions, ThumbnailInput, FileType, FitMode, PixelGrid } from './types.ts';

export function thumbnail(input: ThumbnailInput, options?: ThumbnailOptions): Buffer {
  return generateThumbnail(input, options);
}

export function thumbnailAsBase64(input: ThumbnailInput, options?: ThumbnailOptions): string {
  return generateThumbnail(input, options).toString('base64');
}

export function thumbnailToFile(input: ThumbnailInput, outputPath: string, options?: ThumbnailOptions): void {
  writeFileSync(outputPath, generateThumbnail(input, options));
}

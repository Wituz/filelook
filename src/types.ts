export interface PixelGrid {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // RGBA, length = width * height * 4
}

export type FileType = 'jpeg' | 'png' | 'bmp' | 'gif' | 'webp' | 'ico' | 'cur' | 'ani' | 'tiff' | 'pbm' | 'pgm' | 'ppm' | 'qoi' | 'dds' | 'psd' | 'pcx' | 'tga' | 'ppt' | 'pptx' | 'xlsx' | 'xls' | 'doc' | 'docx' | 'odt' | 'pdf' | 'csv' | 'svg' | 'mp4';

export type FitMode = 'cover' | 'contain' | 'fill';

export type ThumbnailInput = string | Buffer;

export interface ThumbnailOptions {
  readonly width?: number;
  readonly height?: number;
  readonly type?: FileType;
  readonly fit?: FitMode;
}

export interface ResolvedOptions {
  readonly width: number;
  readonly height: number;
  readonly type: FileType | null;
  readonly fit: FitMode;
}

export interface DecodeHints {
  readonly targetWidth: number;
  readonly targetHeight: number;
}

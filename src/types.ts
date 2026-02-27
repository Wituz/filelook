export interface PixelGrid {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // RGBA, length = width * height * 4
}

export type FileType = 'jpeg' | 'png';

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

// Security limits for parsing untrusted input

export const MAX_INPUT_BYTES = 512 * 1024 * 1024; // 512 MB
export const MAX_PIXELS = 100_000_000; // 100 megapixels
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB
export const MAX_RECURSION_DEPTH = 200;
export const MAX_CMAP_ENTRIES = 1_000_000;
export const MAX_STREAM_BYTES = 256 * 1024 * 1024; // 256 MB
export const MAX_CONTINUE_RECORDS = 10_000;

export function validateDimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Invalid image dimensions: ${width}x${height}`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`Image too large: ${width}x${height} exceeds ${MAX_PIXELS} pixel limit`);
  }
}

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { thumbnail, thumbnailToFile } from '../src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

describe('thumbnail', () => {
  it('generates a PNG thumbnail from a JPEG file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.jpg'), { width: 64, height: 64 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a JPEG Buffer', () => {
    const buf = readFileSync(join(FIXTURES, 'sample.jpg'));
    const result = thumbnail(buf, { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
  });

  it('generates a PNG thumbnail from a BMP file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.bmp'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a GIF file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.gif'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });


  it('generates a PNG thumbnail from an ICO file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.ico'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a CUR file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.cur'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from an ANI file path (first frame)', () => {
    const result = thumbnail(join(FIXTURES, 'sample.ani'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a TIFF file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.tiff'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PBM file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.pbm'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PGM file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.pgm'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PPM file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.ppm'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a QOI file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.qoi'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a DDS file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.dds'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PSD file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.psd'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PCX file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.pcx'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a TGA file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.tga'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a WebP file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample1.webp'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from an animated WebP file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.webp'), { width: 32, height: 32 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PPTX file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.pptx'), { width: 64, height: 64 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a DOCX file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.docx'), { width: 64, height: 64 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a CSV file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.csv'), { width: 64, height: 64 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('generates a PNG thumbnail from a PDF file path', () => {
    const result = thumbnail(join(FIXTURES, 'sample.pdf'), { width: 64, height: 64 });

    assert.ok(Buffer.isBuffer(result));
    assert.deepStrictEqual([...result.subarray(0, 8)], PNG_MAGIC);
    assert.ok(result.length > 100);
  });

  it('writes a thumbnail to a file', () => {
    const outPath = join(FIXTURES, 'output.png');
    try {
      thumbnailToFile(join(FIXTURES, 'sample.jpg'), outPath, { width: 48, height: 48 });
      const written = readFileSync(outPath);
      assert.deepStrictEqual([...written.subarray(0, 8)], PNG_MAGIC);
    } finally {
      if (existsSync(outPath)) unlinkSync(outPath);
    }
  });
});

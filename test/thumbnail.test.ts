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

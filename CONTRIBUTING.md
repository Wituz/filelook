# Adding a new thumbnail generator

Each file type lives in its own folder under `src/generators/<type>/` with three files. The shared pipeline handles detection, resizing, and PNG encoding - your generator only needs to decode raw bytes into pixels.

## Steps

### 1. Create the folder

```
src/generators/<type>/
  types.ts      Internal types for your format (not exported to consumers)
  decoder.ts    Decode logic: raw bytes → PixelGrid
  index.ts      Generator subclass
```

### 2. Define internal types (`types.ts`)

Put any format-specific interfaces, enums, and constants here. These are private to your generator - nothing outside the folder should import them.

```ts
// Example: src/generators/bmp/types.ts
export interface BmpHeader {
  width: number;
  height: number;
  bitsPerPixel: number;
  dataOffset: number;
}
```

### 3. Write the decoder (`decoder.ts`)

Export a single decode function that takes raw file bytes and returns a `PixelGrid`:

```ts
import type { PixelGrid } from '../../types.ts';
import type { BmpHeader } from './types.ts';

export function decodeBmp(data: Uint8Array): PixelGrid {
  // Parse headers, extract pixel data, convert to RGBA
  // ...
  return { width, height, data: rgbaBuffer };
}
```

`PixelGrid.data` must be a `Uint8Array` of RGBA bytes, length = `width * height * 4`.

### 4. Create the generator (`index.ts`)

Extend the abstract `Generator` class:

```ts
import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeBmp } from './decoder.ts';

export class BmpGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['bmp'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'bmp', bytes: [0x42, 0x4D], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeBmp(data);
  }
}
```

- **`supportedTypes`** - the file type string(s) this generator handles.
- **`signatures`** - magic byte patterns for auto-detection. Each entry maps a byte sequence at a given offset to a `FileType`.
- **`decode()`** - the only method you implement. Takes raw file bytes, returns RGBA pixels.

### 5. Register it

Add your file type to the `FileType` union in `src/types.ts`:

```ts
export type FileType = 'jpeg' | 'png' | 'bmp';
```

Add your generator to the registry in `src/pipeline.ts`:

```ts
import { BmpGenerator } from './generators/bmp/index.ts';

const generators: readonly Generator[] = [
  new JpegGenerator(),
  new PngGenerator(),
  new BmpGenerator(),
];
```

That's it. The pipeline, resizer, encoder, and public API require no changes.

## Best practices

- **Keep decoding pure.** No filesystem access, no side effects. Accept `Uint8Array`, return `PixelGrid`.
- **Throw on unsupported variants.** If your format has features you can't decode yet (e.g. a rare compression mode), throw a descriptive error rather than producing a corrupt image.
- **Colocate everything.** All types, constants, and helpers specific to your format belong in your generator's folder. Don't add to shared files unless it's genuinely shared.
- **Use `node:zlib` freely.** It's a Node built-in, not an external dependency. Many formats use deflate/inflate internally.
- **Comment the *why*.** The byte offset for a header field is self-evident; the reason you skip 14 bytes before the palette isn't.
- **Add a test.** Place a small fixture file in `test/fixtures/` and add a test case verifying the output starts with PNG magic bytes and has a non-trivial size.

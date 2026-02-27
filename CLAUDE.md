# filelook

npm package that generates thumbnails for any file type (PDF, documents, presentations, images, etc). Zero external dependencies — each file type has a hand-written thumbnail generator.

## Stack

Node.js 25 (nvm) · TypeScript (strict) · ESM · src/ → dist/

## API

Single auto-detecting entry point with three output variants:
- `thumbnail(input, options?)` → `Buffer`
- `thumbnailAsBase64(input, options?)` → `string`
- `thumbnailToFile(input, outputPath, options?)` → `void`

`input` accepts a file path or `Buffer`. File type is auto-detected; can be overridden via `options.type`. Every option has a sensible default.

## Project structure

```
src/
  index.ts              Public API facade
  pipeline.ts           Orchestrator: load → detect → decode → resize → encode
  types.ts              Shared types only (PixelGrid, ThumbnailOptions, FitMode)
  generator.ts          Abstract Generator base class
  detect.ts             Magic-byte file type detection
  resize.ts             Bilinear interpolation resizer
  encode-png.ts         PNG encoder (shared output format)
  generators/
    <type>/             One folder per file type, colocated:
      index.ts          Generator subclass (extends Generator)
      decoder.ts        Format-specific decode logic
      types.ts          Internal types for this format only
```

Each file type is fully self-contained in its own `generators/<type>/` folder. Shared code stays thin at the top level. No god files.

### Adding a new thumbnail generator

1. Create `src/generators/<type>/` with `index.ts`, `decoder.ts`, `types.ts`
2. Extend `Generator` from `src/generator.ts` — implement `supportedTypes`, `signatures`, and `decode()`
3. Register the new generator in the `generators` array in `src/pipeline.ts`

No changes to existing generators, the resizer, encoder, or public API.

## Code style

- Concise code. Comments explain *why*, never *what*.
- DRY — use inheritance and shared structure to avoid repetition.
- kebab-case files, PascalCase classes/types.
- Throw typed exceptions on errors, never return result objects.
- Public API uses type-safe option objects with defaults for every setting.

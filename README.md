# filelook

Generate thumbnails for any file type. Zero external dependencies - every format is decoded from scratch.

> **Early development.** The API is unstable and format coverage is limited. Contributions welcome.

## Supported formats

| Format | Status |
|--------|--------|
| JPEG (baseline + progressive) | Supported |
| PNG | Supported |
| PDF | Planned |
| DOCX / PPTX / XLSX | Planned |
| BMP / GIF / WebP | Planned |

The goal is to support as many file types as possible, each with a hand-written thumbnail generator and no runtime dependencies.

## Install

```bash
npm install filelook
```

## Usage

```ts
import { thumbnail, thumbnailAsBase64, thumbnailToFile } from 'filelook';

// File path or Buffer → PNG Buffer
const buf = thumbnail('./document.pdf');
const buf = thumbnail(fileBuffer, { width: 128, height: 128 });

// → base64 string
const b64 = thumbnailAsBase64('./photo.jpg');

// → write to disk
thumbnailToFile('./photo.jpg', './thumb.png');
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `width` | `number` | `256` | Thumbnail width in pixels |
| `height` | `number` | `256` | Thumbnail height in pixels |
| `type` | `FileType` | auto-detect | Override file type detection |
| `fit` | `FitMode` | `'cover'` | `'cover'`, `'contain'`, or `'fill'` |

## Adding new formats

See [CONTRIBUTING.md](./CONTRIBUTING.md) for a guide on implementing a new thumbnail generator.

## License

ISC

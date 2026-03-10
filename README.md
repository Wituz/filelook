# filelook

Generate thumbnails for any file type. Zero external dependencies - every format is decoded in pure TypeScript or bundled WASM.

## Supported formats

| Format | Notes |
|--------|-------|
| JPEG | Baseline + progressive |
| PNG | All bit depths and color types |
| BMP | 24/32-bit |
| GIF | First frame, with transparency |
| WebP | Lossy (VP8), lossless (VP8L), animated (first frame) |
| TIFF | Uncompressed |
| ICO / CUR | Includes embedded PNG and BMP |
| ANI | Animated cursors (first frame) |
| PSD | Photoshop (composite image) |
| DDS | DirectDraw Surface |
| TGA | Targa |
| PCX | ZSoft Paintbrush |
| PBM / PGM / PPM | Netpbm formats |
| QOI | Quite OK Image |
| DOCX | Word documents (text, images, layout) |
| PPTX | PowerPoint slides (first slide, text, images) |
| PDF | Vector graphics, embedded images, text (fallback font) |
| CSV | Auto-delimiter detection, styled table layout |
| MP4 | H.264 video (first frame) — **work in progress** |

## Install

```bash
# This is not yet published, but will eventually be available at
npm install filelook
```

## Usage

```ts
import { thumbnail, thumbnailAsBase64, thumbnailToFile } from 'filelook';

// File path or Buffer → PNG Buffer
const buf = thumbnail('./photo.webp');
const buf2 = thumbnail(fileBuffer, { width: 128, height: 128 });

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

## License

ISC

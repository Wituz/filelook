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
| PDF | Vector graphics, embedded images, text (fallback font) |
| DOCX | Word documents (text, images, layout) |
| DOC | Word 97-2003 (text, images, layout) |
| ODT | OpenDocument Text |
| PPTX | PowerPoint slides (first slide, text, images) |
| PPT | PowerPoint 97-2003 (first slide, text, images) |
| XLSX | Excel spreadsheets (grid, charts, images) |
| XLS | Excel 97-2003 (grid layout) |
| SVG | Scalable Vector Graphics (shapes, paths, text, images) |
| CSV | Auto-delimiter detection, styled table layout |
| MP4 | H.264 video (first frame) — **work in progress** |

## Install

```bash
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

## Contributing

File type contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for a step-by-step guide on adding a new thumbnail generator.

## License

ISC

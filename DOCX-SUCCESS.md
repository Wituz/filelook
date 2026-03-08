# DOCX Thumbnail Generator — Success Story

## Overview

Implemented a full DOCX thumbnail generator from scratch with zero external dependencies. The generator unzips DOCX files, parses the XML document structure, performs text reflow layout, and renders a pixel-perfect page thumbnail — all using hand-written code.

## Architecture

Six new files in `src/generators/docx/`:

| File | Lines | Purpose |
|------|-------|---------|
| `types.ts` | ~170 | Document model types, layout types, defaults |
| `zip.ts` | ~80 | ZIP parser (EOCD + central directory, Store/Deflate) |
| `xml.ts` | ~140 | Recursive descent XML parser with namespace support |
| `model.ts` | ~340 | DOCX XML → document model with full style chain resolution |
| `layout.ts` | ~310 | Text reflow engine: line breaking, float regions, table layout |
| `decoder.ts` | ~200 | Orchestrator + renderer using PDF rasterizer/font + image compositing |

## What It Supports

- **Text**: Bold, italic, underline, color, variable font sizes
- **Paragraphs**: Left/center/right/justify alignment, spacing, indentation, shading, borders
- **Tables**: Column widths, cell shading, border rendering (outer + inner gridlines)
- **Images**: Both inline and floating (JPEG/PNG), with wrap modes (square, tight, topAndBottom, none)
- **Lists**: Bullet markers from `w:numPr`
- **Styles**: Full inheritance chain (defaults → basedOn parent → named style → direct formatting)
- **Page layout**: Reads `w:sectPr` for page size and margins, defaults to US Letter

## What It Reuses from PDF

The PDF generator's rasterizer and fallback font system were designed to be reusable:

- `fillPath` / `strokePath` — scanline-based path rendering for glyph outlines and borders
- `getGlyphOutline` — hand-drawn geometric glyphs for ASCII 32–126
- `getFallbackWidth` — proportional glyph advance widths
- `Matrix` / `Path` / `RGBA` types — shared graphics primitives

The key difference: DOCX uses Y-down coordinates (vs PDF's Y-up), so a separate `compositeImageDocx` was written without the Y-flip.

## Pipeline

```
DOCX file (ZIP of XML)
  → extractFiles()        — ZIP central directory parse + deflate
  → parseDocxModel()      — XML parse → relationships, styles, body blocks, images
  → layoutDocument()      — text reflow with greedy line breaking + float region manager
  → render to PixelGrid   — glyph fill, image composite, border stroke
  → resize + encode PNG   — standard pipeline output
```

## Key Design Decisions

1. **Greedy line breaker** with `RegionManager` exclusion zones for floating images
2. **Style resolution** walks the `basedOn` chain (max depth 10) to resolve effective properties
3. **Page 1 only** — layout stops at page breaks or margin overflow
4. **Silent skip** for unsupported elements (SmartArt, charts, WordArt, EMF/WMF)
5. **Unit conversions** handled centrally: EMU÷12700, twips÷20, half-points÷2, eighths÷8

## Result

All 21 tests pass (20 existing + 1 new DOCX test). The generated thumbnail shows a recognizable document page with properly flowed text, formatted paragraphs, embedded images, and table structures.

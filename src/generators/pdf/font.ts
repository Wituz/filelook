import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PdfObject, PdfDict, PdfFont, Path, Subpath, PathSegment } from './types.ts';
import { isPdfName, isPdfDict, isPdfStream } from './types.ts';
import { TtfFont } from '../../fonts/ttf.ts';

// --- Standard encoding tables ---

// prettier-ignore
const WIN_ANSI: Record<number, string> = {
  32:'space',33:'exclam',34:'quotedbl',35:'numbersign',36:'dollar',37:'percent',38:'ampersand',39:'quotesingle',
  40:'parenleft',41:'parenright',42:'asterisk',43:'plus',44:'comma',45:'hyphen',46:'period',47:'slash',
  48:'zero',49:'one',50:'two',51:'three',52:'four',53:'five',54:'six',55:'seven',
  56:'eight',57:'nine',58:'colon',59:'semicolon',60:'less',61:'equal',62:'greater',63:'question',
  64:'at',65:'A',66:'B',67:'C',68:'D',69:'E',70:'F',71:'G',
  72:'H',73:'I',74:'J',75:'K',76:'L',77:'M',78:'N',79:'O',
  80:'P',81:'Q',82:'R',83:'S',84:'T',85:'U',86:'V',87:'W',
  88:'X',89:'Y',90:'Z',91:'bracketleft',92:'backslash',93:'bracketright',94:'asciicircum',95:'underscore',
  96:'grave',97:'a',98:'b',99:'c',100:'d',101:'e',102:'f',103:'g',
  104:'h',105:'i',106:'j',107:'k',108:'l',109:'m',110:'n',111:'o',
  112:'p',113:'q',114:'r',115:'s',116:'t',117:'u',118:'v',119:'w',
  120:'x',121:'y',122:'z',123:'braceleft',124:'bar',125:'braceright',126:'asciitilde',
  128:'Euro',130:'quotesinglbase',131:'florin',132:'quotedblbase',133:'ellipsis',134:'dagger',135:'daggerdbl',
  136:'circumflex',137:'perthousand',138:'Scaron',139:'guilsinglleft',140:'OE',
  142:'Zcaron',145:'quoteleft',146:'quoteright',147:'quotedblleft',148:'quotedblright',
  149:'bullet',150:'endash',151:'emdash',152:'tilde',153:'trademark',154:'scaron',
  155:'guilsinglright',156:'oe',158:'zcaron',159:'Ydieresis',
  160:'space',161:'exclamdown',162:'cent',163:'sterling',164:'currency',165:'yen',166:'brokenbar',
  167:'section',168:'dieresis',169:'copyright',170:'ordfeminine',171:'guillemotleft',
  172:'logicalnot',173:'hyphen',174:'registered',175:'macron',176:'degree',177:'plusminus',
  178:'twosuperior',179:'threesuperior',180:'acute',181:'mu',182:'paragraph',183:'periodcentered',
  184:'cedilla',185:'onesuperior',186:'ordmasculine',187:'guillemotright',
  188:'onequarter',189:'onehalf',190:'threequarters',191:'questiondown',
  192:'Agrave',193:'Aacute',194:'Acircumflex',195:'Atilde',196:'Adieresis',197:'Aring',198:'AE',199:'Ccedilla',
  200:'Egrave',201:'Eacute',202:'Ecircumflex',203:'Edieresis',204:'Igrave',205:'Iacute',206:'Icircumflex',
  207:'Idieresis',208:'Eth',209:'Ntilde',210:'Ograve',211:'Oacute',212:'Ocircumflex',213:'Otilde',
  214:'Odieresis',215:'multiply',216:'Oslash',217:'Ugrave',218:'Uacute',219:'Ucircumflex',220:'Udieresis',
  221:'Yacute',222:'Thorn',223:'germandbls',224:'agrave',225:'aacute',226:'acircumflex',227:'atilde',
  228:'adieresis',229:'aring',230:'ae',231:'ccedilla',232:'egrave',233:'eacute',234:'ecircumflex',235:'edieresis',
  236:'igrave',237:'iacute',238:'icircumflex',239:'idieresis',240:'eth',241:'ntilde',242:'ograve',243:'oacute',
  244:'ocircumflex',245:'otilde',246:'odieresis',247:'divide',248:'oslash',249:'ugrave',250:'uacute',
  251:'ucircumflex',252:'udieresis',253:'yacute',254:'thorn',255:'ydieresis',
};

// Common glyph name -> Unicode mapping
const GLYPH_TO_UNICODE: Record<string, number> = {};
// Populate from WinAnsi (covers most common glyphs)
for (const [code, name] of Object.entries(WIN_ANSI)) {
  const c = parseInt(code);
  if (c < 128) {
    GLYPH_TO_UNICODE[name] = c;
  }
}
// Single-letter glyph names map directly
for (let i = 32; i <= 126; i++) {
  const ch = String.fromCharCode(i);
  if (!GLYPH_TO_UNICODE[ch]) GLYPH_TO_UNICODE[ch] = i;
}
// Extra mappings
Object.assign(GLYPH_TO_UNICODE, {
  Euro: 0x20AC, ellipsis: 0x2026, endash: 0x2013, emdash: 0x2014,
  bullet: 0x2022, trademark: 0x2122, copyright: 0x00A9, registered: 0x00AE,
  degree: 0x00B0, plusminus: 0x00B1, fi: 0xFB01, fl: 0xFB02,
  quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201C, quotedblright: 0x201D,
  guillemotleft: 0x00AB, guillemotright: 0x00BB,
});

// --- Font dictionary parsing ---

export function parseFont(
  fontDict: PdfDict,
  resolver: (obj: PdfObject) => PdfObject,
): PdfFont {
  const baseFont = fontDict.get('BaseFont') ?? null;
  const baseFontName = isPdfName(baseFont) ? baseFont.name : '';

  const subtype = fontDict.get('Subtype') ?? null;
  const subtypeName = isPdfName(subtype) ? subtype.name : '';

  let widths = new Map<number, number>();
  let firstChar = 0;
  let lastChar = 255;
  let defaultWidth = 600;

  if (subtypeName === 'Type0') {
    // Composite font: get descendant CIDFont
    const descendants = resolver(fontDict.get('DescendantFonts')!);
    if (Array.isArray(descendants) && descendants.length > 0) {
      const cidFont = resolver(descendants[0]) as PdfDict;
      if (isPdfDict(cidFont)) {
        const dw = cidFont.get('DW');
        if (typeof dw === 'number') defaultWidth = dw;
        widths = parseCidWidths(cidFont, resolver);
      }
    }
  } else {
    // Simple font
    const fc = fontDict.get('FirstChar');
    const lc = fontDict.get('LastChar');
    if (typeof fc === 'number') firstChar = fc;
    if (typeof lc === 'number') lastChar = lc;

    const wArr = resolver(fontDict.get('Widths') ?? null);
    if (Array.isArray(wArr)) {
      for (let i = 0; i < wArr.length; i++) {
        const w = wArr[i];
        if (typeof w === 'number') widths.set(firstChar + i, w);
      }
    }
  }

  // Parse encoding
  let encoding: Map<number, string> | null = null;
  const enc = resolver(fontDict.get('Encoding') ?? null);
  if (isPdfName(enc)) {
    if (enc.name === 'WinAnsiEncoding') {
      encoding = new Map(Object.entries(WIN_ANSI).map(([k, v]) => [parseInt(k), v]));
    }
    // MacRomanEncoding and StandardEncoding are close enough to WinAnsi for thumbnails
  } else if (isPdfDict(enc)) {
    const base = enc.get('BaseEncoding') ?? null;
    if (isPdfName(base) && base.name === 'WinAnsiEncoding') {
      encoding = new Map(Object.entries(WIN_ANSI).map(([k, v]) => [parseInt(k), v]));
    } else {
      encoding = new Map(Object.entries(WIN_ANSI).map(([k, v]) => [parseInt(k), v]));
    }
    // Apply Differences
    const diffs = enc.get('Differences');
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const item of diffs) {
        if (typeof item === 'number') {
          code = item;
        } else if (isPdfName(item)) {
          if (!encoding) encoding = new Map();
          encoding.set(code, item.name);
          code++;
        }
      }
    }
  }

  // Parse ToUnicode CMap
  let toUnicode: Map<number, number> | null = null;
  const touniRef = fontDict.get('ToUnicode');
  if (touniRef) {
    const touniStream = resolver(touniRef);
    if (isPdfStream(touniStream)) {
      // Need to decode stream — caller should handle this via the parser
      // For now, try to parse the raw data
      toUnicode = parseToUnicodeCMap(touniStream.rawData);
    }
  }

  return {
    widths,
    firstChar,
    lastChar,
    toUnicode,
    encoding,
    baseFont: baseFontName,
    defaultWidth,
  };
}

function parseCidWidths(cidFont: PdfDict, resolver: (obj: PdfObject) => PdfObject): Map<number, number> {
  const widths = new Map<number, number>();
  const w = resolver(cidFont.get('W') ?? null);
  if (!Array.isArray(w)) return widths;

  let i = 0;
  while (i < w.length) {
    const first = w[i] as number;
    i++;
    if (i >= w.length) break;

    if (Array.isArray(w[i])) {
      // [first [w1 w2 w3 ...]]
      const arr = w[i] as number[];
      for (let j = 0; j < arr.length; j++) {
        widths.set(first + j, arr[j]);
      }
      i++;
    } else {
      // [first last width]
      const last = w[i] as number;
      i++;
      const width = w[i] as number;
      i++;
      for (let c = first; c <= last; c++) {
        widths.set(c, width);
      }
    }
  }

  return widths;
}

// --- ToUnicode CMap parser ---

export function parseToUnicodeCMap(data: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  const text = new TextDecoder('latin1').decode(data);

  // Parse beginbfchar / endbfchar
  let match: RegExpExecArray | null;

  const charRegex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  while ((match = charRegex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let line: RegExpExecArray | null;
    while ((line = lineRegex.exec(block)) !== null) {
      const src = parseInt(line[1], 16);
      const dst = parseInt(line[2], 16);
      map.set(src, dst);
    }
  }

  // Parse beginbfrange / endbfrange
  const rangeRegex = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  while ((match = rangeRegex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
    let line: RegExpExecArray | null;
    while ((line = lineRegex.exec(block)) !== null) {
      const srcStart = parseInt(line[1], 16);
      const srcEnd = parseInt(line[2], 16);

      if (line[3]) {
        // Single value range
        let dst = parseInt(line[3], 16);
        for (let c = srcStart; c <= srcEnd; c++) {
          map.set(c, dst++);
        }
      } else if (line[4]) {
        // Array of values
        const vals = line[4].match(/<([0-9A-Fa-f]+)>/g);
        if (vals) {
          for (let i = 0; i < vals.length && srcStart + i <= srcEnd; i++) {
            const hex = vals[i].replace(/[<>]/g, '');
            map.set(srcStart + i, parseInt(hex, 16));
          }
        }
      }
    }
  }

  return map;
}

// --- Glyph width lookup ---

export function getGlyphWidth(font: PdfFont, charCode: number): number {
  const w = font.widths.get(charCode);
  if (w !== undefined) return w;
  // Standard fonts (Helvetica, etc.) don't embed widths — use fallback font metrics
  if (font.widths.size === 0) {
    const unicode = charToUnicode(font, charCode);
    return getFallbackWidth(unicode);
  }
  return font.defaultWidth;
}

// --- Character code -> Unicode mapping ---

export function charToUnicode(font: PdfFont, charCode: number): number {
  // 1. Try ToUnicode CMap
  if (font.toUnicode) {
    const u = font.toUnicode.get(charCode);
    if (u !== undefined) return u;
  }

  // 2. Try Encoding -> glyph name -> Unicode
  if (font.encoding) {
    const glyphName = font.encoding.get(charCode);
    if (glyphName) {
      const u = GLYPH_TO_UNICODE[glyphName];
      if (u !== undefined) return u;
    }
  }

  // 3. Identity assumption
  return charCode;
}

// --- Fallback font: Inter (loaded from bundled TTF) ---

const NOTDEF_PATH: Path = {
  subpaths: [
    { segments: [
      { type: 'move', x: 100, y: 0 }, { type: 'line', x: 460, y: 0 },
      { type: 'line', x: 460, y: 700 }, { type: 'line', x: 100, y: 700 },
    ], closed: true },
    { segments: [
      { type: 'move', x: 140, y: 40 }, { type: 'line', x: 420, y: 40 },
      { type: 'line', x: 420, y: 660 }, { type: 'line', x: 140, y: 660 },
    ], closed: true },
  ],
};

let _ttfFont: TtfFont | null = null;
function ttfFont(): TtfFont {
  if (!_ttfFont) {
    const fontDir = join(dirname(fileURLToPath(import.meta.url)), '../../fonts');
    _ttfFont = new TtfFont(new Uint8Array(readFileSync(join(fontDir, 'regular.ttf'))));
  }
  return _ttfFont;
}

export function getGlyphOutline(codePoint: number): Path {
  return ttfFont().getOutline(codePoint) ?? NOTDEF_PATH;
}

export function getFallbackWidth(codePoint: number): number {
  return ttfFont().getWidth(codePoint);
}

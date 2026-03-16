import type { PixelGrid } from '../../types.ts';
import type {
  PdfObject, PdfDict, PdfPage, PdfStream,
  Matrix, RGBA, Path, Subpath, PathSegment, GraphicsState, PdfFont,
} from './types.ts';
import { isPdfName, isPdfRef, isPdfStream, isPdfDict } from './types.ts';
import { PdfParser } from './parser.ts';
import { fillPath, strokePath, compositeImage, identity, multiplyMatrix, transformPoint } from './rasterizer.ts';
import { parseFont, getGlyphWidth, charToUnicode, getGlyphOutline, getFallbackWidth, parseToUnicodeCMap } from './font.ts';
import { decodeJpeg } from '../jpeg/decoder.ts';

function cloneState(s: GraphicsState): GraphicsState {
  return {
    ctm: [...s.ctm] as Matrix,
    fillColor: { ...s.fillColor },
    strokeColor: { ...s.strokeColor },
    lineWidth: s.lineWidth,
    font: s.font,
    fontSize: s.fontSize,
    charSpacing: s.charSpacing,
    wordSpacing: s.wordSpacing,
    textLeading: s.textLeading,
    textRise: s.textRise,
    textMatrix: [...s.textMatrix] as Matrix,
    textLineMatrix: [...s.textLineMatrix] as Matrix,
    clippingPath: s.clippingPath,
  };
}

function defaultState(): GraphicsState {
  return {
    ctm: identity(),
    fillColor: { r: 0, g: 0, b: 0, a: 255 },
    strokeColor: { r: 0, g: 0, b: 0, a: 255 },
    lineWidth: 1,
    font: null,
    fontSize: 12,
    charSpacing: 0,
    wordSpacing: 0,
    textLeading: 0,
    textRise: 0,
    textMatrix: identity(),
    textLineMatrix: identity(),
    clippingPath: null,
  };
}

// --- Content stream tokenizer ---

interface CsToken {
  type: 'number' | 'string' | 'hexstring' | 'name' | 'array' | 'bool' | 'null' | 'operator';
  value: unknown;
}

class ContentStreamTokenizer {
  pos: number;

  constructor(private data: Uint8Array) {
    this.pos = 0;
  }

  private eof(): boolean { return this.pos >= this.data.length; }
  private byte(): number { return this.data[this.pos]; }
  private advance(): number { return this.data[this.pos++]; }

  private isWs(b: number): boolean {
    return b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
  }

  private skipWsAndComments(): void {
    while (!this.eof()) {
      const b = this.byte();
      if (this.isWs(b)) { this.pos++; continue; }
      if (b === 0x25) { // %
        while (!this.eof() && this.byte() !== 0x0A && this.byte() !== 0x0D) this.pos++;
        continue;
      }
      break;
    }
  }

  nextToken(): CsToken | null {
    this.skipWsAndComments();
    if (this.eof()) return null;

    const b = this.byte();

    // String literal
    if (b === 0x28) return { type: 'string', value: this.readLiteralString() };
    // Hex string or dict (inline image could have <<)
    if (b === 0x3C) {
      if (this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3C) {
        return { type: 'array', value: this.readDict() };
      }
      return { type: 'hexstring', value: this.readHexString() };
    }
    // Array
    if (b === 0x5B) return { type: 'array', value: this.readArray() };
    // Name
    if (b === 0x2F) return { type: 'name', value: this.readName() };
    // Number
    if (b >= 0x30 && b <= 0x39 || b === 0x2D || b === 0x2E || b === 0x2B) {
      return { type: 'number', value: this.readNumber() };
    }

    // Skip stray closing delimiters (can appear when content is split across streams)
    if (b === 0x3E || b === 0x29 || b === 0x5D) { // > ) ]
      this.pos++;
      return this.nextToken();
    }

    // Keyword / operator
    const kw = this.readKeyword();
    if (kw === 'true') return { type: 'bool', value: true };
    if (kw === 'false') return { type: 'bool', value: false };
    if (kw === 'null') return { type: 'null', value: null };
    return { type: 'operator', value: kw };
  }

  private readKeyword(): string {
    const start = this.pos;
    while (!this.eof()) {
      const b = this.byte();
      if (this.isWs(b) || b === 0x2F || b === 0x28 || b === 0x29 || b === 0x3C || b === 0x3E || b === 0x5B || b === 0x5D) break;
      this.pos++;
    }
    return String.fromCharCode(...this.data.subarray(start, this.pos));
  }

  private readNumber(): number {
    const start = this.pos;
    if (this.byte() === 0x2D || this.byte() === 0x2B) this.pos++;
    let hasDot = false;
    while (!this.eof()) {
      const b = this.byte();
      if (b === 0x2E && !hasDot) { hasDot = true; this.pos++; }
      else if (b >= 0x30 && b <= 0x39) this.pos++;
      else break;
    }
    return parseFloat(String.fromCharCode(...this.data.subarray(start, this.pos)));
  }

  private readLiteralString(): Uint8Array {
    this.pos++; // skip (
    const result: number[] = [];
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const b = this.advance();
      if (b === 0x28) { depth++; result.push(b); }
      else if (b === 0x29) { depth--; if (depth > 0) result.push(b); }
      else if (b === 0x5C) {
        if (this.eof()) break;
        const next = this.advance();
        switch (next) {
          case 0x6E: result.push(0x0A); break;
          case 0x72: result.push(0x0D); break;
          case 0x74: result.push(0x09); break;
          case 0x62: result.push(0x08); break;
          case 0x66: result.push(0x0C); break;
          case 0x28: result.push(0x28); break;
          case 0x29: result.push(0x29); break;
          case 0x5C: result.push(0x5C); break;
          case 0x0D: if (!this.eof() && this.byte() === 0x0A) this.pos++; break;
          case 0x0A: break;
          default:
            if (next >= 0x30 && next <= 0x37) {
              let octal = next - 0x30;
              if (!this.eof() && this.byte() >= 0x30 && this.byte() <= 0x37) {
                octal = octal * 8 + (this.advance() - 0x30);
                if (!this.eof() && this.byte() >= 0x30 && this.byte() <= 0x37) {
                  octal = octal * 8 + (this.advance() - 0x30);
                }
              }
              result.push(octal);
            } else {
              result.push(next);
            }
        }
      } else {
        result.push(b);
      }
    }
    return new Uint8Array(result);
  }

  private readHexString(): Uint8Array {
    this.pos++; // skip <
    const bytes: number[] = [];
    let high = -1;
    while (!this.eof()) {
      const b = this.advance();
      if (b === 0x3E) break;
      if (this.isWs(b)) continue;
      const nibble = b <= 0x39 ? b - 0x30 : (b <= 0x46 ? b - 0x37 : b - 0x57);
      if (high === -1) { high = nibble; }
      else { bytes.push((high << 4) | nibble); high = -1; }
    }
    if (high !== -1) bytes.push(high << 4);
    return new Uint8Array(bytes);
  }

  private readName(): string {
    this.pos++; // skip /
    let name = '';
    while (!this.eof()) {
      const b = this.byte();
      if (this.isWs(b) || b === 0x2F || b === 0x28 || b === 0x29 || b === 0x3C || b === 0x3E || b === 0x5B || b === 0x5D) break;
      this.pos++;
      if (b === 0x23 && this.pos + 1 < this.data.length) {
        const h1 = this.advance();
        const h2 = this.advance();
        name += String.fromCharCode(parseInt(String.fromCharCode(h1, h2), 16));
      } else {
        name += String.fromCharCode(b);
      }
    }
    return name;
  }

  private readArray(): PdfObject[] {
    this.pos++; // skip [
    const arr: PdfObject[] = [];
    while (true) {
      this.skipWsAndComments();
      if (this.eof() || this.byte() === 0x5D) { this.pos++; return arr; }
      const tok = this.nextToken();
      if (!tok) break;
      arr.push(tokenToObject(tok));
    }
    return arr;
  }

  private readDict(): PdfDict {
    this.pos += 2; // skip <<
    const dict: PdfDict = new Map();
    while (true) {
      this.skipWsAndComments();
      if (this.eof()) break;
      if (this.byte() === 0x3E && this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3E) {
        this.pos += 2;
        return dict;
      }
      const key = this.readName();
      const valTok = this.nextToken();
      if (valTok) dict.set(key, tokenToObject(valTok));
    }
    return dict;
  }

  // For inline images: read bytes until EI operator
  readInlineImageData(dict: PdfDict): Uint8Array {
    // Skip the single whitespace after ID
    if (!this.eof()) this.pos++;

    const w = dict.get('W') ?? dict.get('Width');
    const h = dict.get('H') ?? dict.get('Height');
    const bpc = dict.get('BPC') ?? dict.get('BitsPerComponent') ?? 8;
    const cs = dict.get('CS') ?? dict.get('ColorSpace');

    let components = 3;
    if (isPdfName(cs ?? null)) {
      const n = (cs as any).name;
      if (n === 'G' || n === 'DeviceGray') components = 1;
      else if (n === 'CMYK' || n === 'DeviceCMYK') components = 4;
    } else if (typeof cs === 'string') {
      if (cs === 'G' || cs === 'DeviceGray') components = 1;
      else if (cs === 'CMYK' || cs === 'DeviceCMYK') components = 4;
    }

    // Search for EI preceded by whitespace
    // This is heuristic since image data can contain "EI"
    const expectedBytes = (typeof w === 'number' && typeof h === 'number' && typeof bpc === 'number')
      ? Math.ceil(w * h * components * bpc / 8)
      : 0;

    const start = this.pos;
    if (expectedBytes > 0 && start + expectedBytes + 4 <= this.data.length) {
      // Try exact length first
      this.pos = start + expectedBytes;
      this.skipWsAndComments();
      if (this.pos + 2 <= this.data.length && this.data[this.pos] === 0x45 && this.data[this.pos + 1] === 0x49) {
        this.pos += 2;
        return this.data.subarray(start, start + expectedBytes);
      }
    }

    // Fallback: scan for whitespace + EI + whitespace/EOF
    this.pos = start;
    while (this.pos + 2 < this.data.length) {
      if (this.isWs(this.data[this.pos]) &&
          this.data[this.pos + 1] === 0x45 && this.data[this.pos + 2] === 0x49 &&
          (this.pos + 3 >= this.data.length || this.isWs(this.data[this.pos + 3]))) {
        const end = this.pos;
        this.pos += 3; // skip ws + EI
        return this.data.subarray(start, end);
      }
      this.pos++;
    }

    this.pos = this.data.length;
    return this.data.subarray(start);
  }
}

function tokenToObject(tok: CsToken): PdfObject {
  if (tok.type === 'number') return tok.value as number;
  if (tok.type === 'bool') return tok.value as boolean;
  if (tok.type === 'null') return null;
  if (tok.type === 'name') return { __brand: 'PdfName' as const, name: tok.value as string };
  if (tok.type === 'string' || tok.type === 'hexstring') return tok.value as string;
  if (tok.type === 'array') return tok.value as PdfObject[];
  return null;
}

// --- Page Renderer ---

export function renderPage(page: PdfPage, width: number, height: number): PixelGrid {
  const renderer = new PageRenderer(page, width, height);
  return renderer.render();
}

class PageRenderer {
  private buffer: Uint8Array;
  private state: GraphicsState;
  private stateStack: GraphicsState[] = [];
  private currentPath: Path = { subpaths: [] };
  private currentSubpath: Subpath | null = null;
  private curX = 0;
  private curY = 0;
  private fontCache = new Map<string, PdfFont>();
  private parser: PdfParser | null = null;

  constructor(
    private page: PdfPage,
    private width: number,
    private height: number,
  ) {
    this.buffer = new Uint8Array(width * height * 4);
    this.state = defaultState();
  }

  setParser(parser: PdfParser): void {
    this.parser = parser;
  }

  render(): PixelGrid {
    // Fill background white
    for (let i = 0; i < this.buffer.length; i += 4) {
      this.buffer[i] = 255;
      this.buffer[i + 1] = 255;
      this.buffer[i + 2] = 255;
      this.buffer[i + 3] = 255;
    }

    // Set up CTM: MediaBox -> pixel buffer, flip Y
    const [x0, y0, x1, y1] = this.page.mediaBox;
    let pageW = x1 - x0;
    let pageH = y1 - y0;

    // Handle rotation
    const rotate = this.page.rotate % 360;
    if (rotate === 90 || rotate === 270) {
      [pageW, pageH] = [pageH, pageW];
    }

    const scaleX = this.width / pageW;
    const scaleY = this.height / pageH;
    const scale = Math.min(scaleX, scaleY);

    // Base transform: scale and flip Y
    let ctm: Matrix = [scale, 0, 0, -scale, -x0 * scale, y1 * scale];

    // Apply rotation
    if (rotate === 90) {
      ctm = multiplyMatrix([0, -1, 1, 0, 0, pageW], [scale, 0, 0, -scale, 0, this.height]);
      ctm = [ctm[0], ctm[1], ctm[2], ctm[3], ctm[4] - x0 * ctm[0] - y0 * ctm[2], ctm[5] - x0 * ctm[1] - y0 * ctm[3]];
    } else if (rotate === 180) {
      ctm = [-scale, 0, 0, scale, (x1) * scale, (y0) * -scale + this.height];
      // Simplified: flip both axes
    } else if (rotate === 270) {
      ctm = multiplyMatrix([0, 1, -1, 0, pageH, 0], [scale, 0, 0, -scale, 0, this.height]);
      ctm = [ctm[0], ctm[1], ctm[2], ctm[3], ctm[4] - x0 * ctm[0] - y0 * ctm[2], ctm[5] - x0 * ctm[1] - y0 * ctm[3]];
    }

    this.state.ctm = ctm;

    // Process content streams
    for (const stream of this.page.contentStreams) {
      this.executeContentStream(stream);
    }

    return { width: this.width, height: this.height, data: this.buffer };
  }

  private executeContentStream(data: Uint8Array): void {
    const tok = new ContentStreamTokenizer(data);
    const operands: CsToken[] = [];

    while (true) {
      const token = tok.nextToken();
      if (!token) break;

      if (token.type === 'operator') {
        const op = token.value as string;

        if (op === 'BI') {
          // Inline image
          this.handleInlineImage(tok);
          operands.length = 0;
          continue;
        }

        this.dispatch(op, operands);
        operands.length = 0;
      } else {
        operands.push(token);
      }
    }
  }

  private num(operands: CsToken[], i: number): number {
    return (operands[i]?.value as number) ?? 0;
  }

  private str(operands: CsToken[], i: number): Uint8Array {
    const v = operands[i]?.value;
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return new TextEncoder().encode(v);
    return new Uint8Array(0);
  }

  private nameVal(operands: CsToken[], i: number): string {
    const v = operands[i]?.value;
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && '__brand' in (v as any)) return (v as any).name;
    return '';
  }

  private dispatch(op: string, operands: CsToken[]): void {
    switch (op) {
      // --- Graphics state ---
      case 'q': this.stateStack.push(cloneState(this.state)); break;
      case 'Q': if (this.stateStack.length > 0) this.state = this.stateStack.pop()!; break;
      case 'cm': {
        const m: Matrix = [
          this.num(operands, 0), this.num(operands, 1),
          this.num(operands, 2), this.num(operands, 3),
          this.num(operands, 4), this.num(operands, 5),
        ];
        this.state.ctm = multiplyMatrix(m, this.state.ctm);
        break;
      }
      case 'w': this.state.lineWidth = this.num(operands, 0); break;
      case 'J': break; // line cap - skip
      case 'j': // line join - skip (also handles lowercase j)
        if (operands.length > 0 && operands[0].type === 'number') break;
        break;
      case 'M': break; // miter limit - skip
      case 'd': break; // dash pattern - skip
      case 'ri': break; // rendering intent - skip
      case 'i': break; // flatness - skip
      case 'gs': this.handleExtGState(operands); break;

      // --- Path construction ---
      case 'm': // moveto
        this.startSubpath(this.num(operands, 0), this.num(operands, 1));
        break;
      case 'l': // lineto
        this.addSegment({ type: 'line', x: this.num(operands, 0), y: this.num(operands, 1) });
        break;
      case 'c': // curveto
        this.addSegment({
          type: 'cubic',
          cx1: this.num(operands, 0), cy1: this.num(operands, 1),
          cx2: this.num(operands, 2), cy2: this.num(operands, 3),
          x: this.num(operands, 4), y: this.num(operands, 5),
        });
        break;
      case 'v': // curveto (first control = current point)
        this.addSegment({
          type: 'cubic',
          cx1: this.curX, cy1: this.curY,
          cx2: this.num(operands, 0), cy2: this.num(operands, 1),
          x: this.num(operands, 2), y: this.num(operands, 3),
        });
        break;
      case 'y': // curveto (second control = endpoint)
        this.addSegment({
          type: 'cubic',
          cx1: this.num(operands, 0), cy1: this.num(operands, 1),
          cx2: this.num(operands, 2), cy2: this.num(operands, 3),
          x: this.num(operands, 2), y: this.num(operands, 3),
        });
        break;
      case 're': { // rectangle
        const rx = this.num(operands, 0);
        const ry = this.num(operands, 1);
        const rw = this.num(operands, 2);
        const rh = this.num(operands, 3);
        this.startSubpath(rx, ry);
        this.addSegment({ type: 'line', x: rx + rw, y: ry });
        this.addSegment({ type: 'line', x: rx + rw, y: ry + rh });
        this.addSegment({ type: 'line', x: rx, y: ry + rh });
        this.closeSubpath();
        break;
      }
      case 'h': this.closeSubpath(); break;

      // --- Path painting ---
      case 'S': this.strokeCurrentPath(); break;
      case 's': this.closeSubpath(); this.strokeCurrentPath(); break;
      case 'f': case 'F': this.fillCurrentPath('nonzero'); break;
      case 'f*': this.fillCurrentPath('evenodd'); break;
      case 'B': this.fillCurrentPath('nonzero'); this.strokeCurrentPath(); break;
      case 'B*': this.fillCurrentPath('evenodd'); this.strokeCurrentPath(); break;
      case 'b': this.closeSubpath(); this.fillCurrentPath('nonzero'); this.strokeCurrentPath(); break;
      case 'b*': this.closeSubpath(); this.fillCurrentPath('evenodd'); this.strokeCurrentPath(); break;
      case 'n': this.currentPath = { subpaths: [] }; this.currentSubpath = null; break;
      case 'W': break; // clipping - skip for now
      case 'W*': break;

      // --- Color (preserve alpha set by gs/ExtGState) ---
      case 'g': { const a = this.state.fillColor.a; this.state.fillColor = this.grayToRGBA(this.num(operands, 0)); this.state.fillColor.a = a; break; }
      case 'G': { const a = this.state.strokeColor.a; this.state.strokeColor = this.grayToRGBA(this.num(operands, 0)); this.state.strokeColor.a = a; break; }
      case 'rg': {
        const a = this.state.fillColor.a;
        this.state.fillColor = { r: Math.round(this.num(operands, 0) * 255), g: Math.round(this.num(operands, 1) * 255), b: Math.round(this.num(operands, 2) * 255), a };
        break;
      }
      case 'RG': {
        const a = this.state.strokeColor.a;
        this.state.strokeColor = { r: Math.round(this.num(operands, 0) * 255), g: Math.round(this.num(operands, 1) * 255), b: Math.round(this.num(operands, 2) * 255), a };
        break;
      }
      case 'k': { const a = this.state.fillColor.a; this.state.fillColor = this.cmykToRGBA(this.num(operands, 0), this.num(operands, 1), this.num(operands, 2), this.num(operands, 3)); this.state.fillColor.a = a; break; }
      case 'K': { const a = this.state.strokeColor.a; this.state.strokeColor = this.cmykToRGBA(this.num(operands, 0), this.num(operands, 1), this.num(operands, 2), this.num(operands, 3)); this.state.strokeColor.a = a; break; }
      case 'cs': case 'CS': break; // Set color space — we handle color values directly
      case 'sc': case 'SC': case 'scn': case 'SCN': {
        // Generic color setting — interpret based on operand count, preserve alpha
        const isStroke = op === 'SC' || op === 'SCN';
        const c = isStroke ? 'strokeColor' : 'fillColor';
        const prevA = this.state[c].a;
        const nums = operands.filter(o => o.type === 'number').map(o => o.value as number);
        if (nums.length === 1) {
          this.state[c] = this.grayToRGBA(nums[0]);
        } else if (nums.length === 3) {
          this.state[c] = { r: Math.round(nums[0] * 255), g: Math.round(nums[1] * 255), b: Math.round(nums[2] * 255), a: 255 };
        } else if (nums.length === 4) {
          this.state[c] = this.cmykToRGBA(nums[0], nums[1], nums[2], nums[3]);
        }
        this.state[c].a = prevA;
        break;
      }

      // --- Text ---
      case 'BT':
        this.state.textMatrix = identity();
        this.state.textLineMatrix = identity();
        break;
      case 'ET': break;
      case 'Tc': this.state.charSpacing = this.num(operands, 0); break;
      case 'Tw': this.state.wordSpacing = this.num(operands, 0); break;
      case 'TL': this.state.textLeading = this.num(operands, 0); break;
      case 'Ts': this.state.textRise = this.num(operands, 0); break;
      case 'Tf': {
        const fontName = this.nameVal(operands, 0);
        const fontSize = this.num(operands, 1);
        this.state.fontSize = fontSize;
        this.state.font = this.resolveFont(fontName);
        break;
      }
      case 'Td': {
        const tx = this.num(operands, 0);
        const ty = this.num(operands, 1);
        const m: Matrix = [1, 0, 0, 1, tx, ty];
        this.state.textLineMatrix = multiplyMatrix(m, this.state.textLineMatrix);
        this.state.textMatrix = [...this.state.textLineMatrix] as Matrix;
        break;
      }
      case 'TD': {
        const tx = this.num(operands, 0);
        const ty = this.num(operands, 1);
        this.state.textLeading = -ty;
        const m: Matrix = [1, 0, 0, 1, tx, ty];
        this.state.textLineMatrix = multiplyMatrix(m, this.state.textLineMatrix);
        this.state.textMatrix = [...this.state.textLineMatrix] as Matrix;
        break;
      }
      case 'Tm': {
        this.state.textMatrix = [
          this.num(operands, 0), this.num(operands, 1),
          this.num(operands, 2), this.num(operands, 3),
          this.num(operands, 4), this.num(operands, 5),
        ];
        this.state.textLineMatrix = [...this.state.textMatrix] as Matrix;
        break;
      }
      case 'T*': {
        const m: Matrix = [1, 0, 0, 1, 0, -this.state.textLeading];
        this.state.textLineMatrix = multiplyMatrix(m, this.state.textLineMatrix);
        this.state.textMatrix = [...this.state.textLineMatrix] as Matrix;
        break;
      }
      case 'Tj': this.showText(this.str(operands, 0)); break;
      case 'TJ': this.showTextArray(operands); break;
      case "'": {
        // Move to next line, show text
        const m: Matrix = [1, 0, 0, 1, 0, -this.state.textLeading];
        this.state.textLineMatrix = multiplyMatrix(m, this.state.textLineMatrix);
        this.state.textMatrix = [...this.state.textLineMatrix] as Matrix;
        this.showText(this.str(operands, 0));
        break;
      }
      case '"': {
        this.state.wordSpacing = this.num(operands, 0);
        this.state.charSpacing = this.num(operands, 1);
        const m: Matrix = [1, 0, 0, 1, 0, -this.state.textLeading];
        this.state.textLineMatrix = multiplyMatrix(m, this.state.textLineMatrix);
        this.state.textMatrix = [...this.state.textLineMatrix] as Matrix;
        this.showText(this.str(operands, 2));
        break;
      }

      // --- XObject ---
      case 'Do': this.handleDo(this.nameVal(operands, 0)); break;

      // --- Marked content (skip) ---
      case 'BMC': case 'BDC': case 'EMC': case 'MP': case 'DP': break;

      // All other operators: silently skip
      default: break;
    }
  }

  // --- Path helpers ---

  private startSubpath(x: number, y: number): void {
    this.finishSubpath();
    this.currentSubpath = { segments: [{ type: 'move', x, y }], closed: false };
    this.curX = x;
    this.curY = y;
  }

  private addSegment(seg: PathSegment): void {
    if (!this.currentSubpath) this.startSubpath(this.curX, this.curY);
    this.currentSubpath!.segments.push(seg);
    this.curX = seg.x;
    this.curY = seg.y;
  }

  private closeSubpath(): void {
    if (this.currentSubpath) {
      this.currentSubpath.closed = true;
      this.finishSubpath();
    }
  }

  private finishSubpath(): void {
    if (this.currentSubpath && this.currentSubpath.segments.length > 0) {
      this.currentPath.subpaths.push(this.currentSubpath);
    }
    this.currentSubpath = null;
  }

  private fillCurrentPath(rule: 'nonzero' | 'evenodd'): void {
    this.finishSubpath();
    if (this.currentPath.subpaths.length > 0) {
      fillPath(this.buffer, this.width, this.height, this.currentPath, this.state.ctm, this.state.fillColor, rule);
    }
    this.currentPath = { subpaths: [] };
    this.currentSubpath = null;
  }

  private strokeCurrentPath(): void {
    this.finishSubpath();
    if (this.currentPath.subpaths.length > 0) {
      strokePath(this.buffer, this.width, this.height, this.currentPath, this.state.ctm, this.state.strokeColor, this.state.lineWidth);
    }
    this.currentPath = { subpaths: [] };
    this.currentSubpath = null;
  }

  // --- Color helpers ---

  private grayToRGBA(g: number): RGBA {
    const v = Math.round(g * 255);
    return { r: v, g: v, b: v, a: 255 };
  }

  private cmykToRGBA(c: number, m: number, y: number, k: number): RGBA {
    return {
      r: Math.round(255 * (1 - c) * (1 - k)),
      g: Math.round(255 * (1 - m) * (1 - k)),
      b: Math.round(255 * (1 - y) * (1 - k)),
      a: 255,
    };
  }

  // --- Font resolution ---

  private resolveFont(name: string): PdfFont | null {
    if (this.fontCache.has(name)) return this.fontCache.get(name)!;

    const resources = this.page.resources;
    const fonts = this.resolveObj(resources.get('Font'));
    if (!isPdfDict(fonts)) return null;

    const fontObj = this.resolveObj(fonts.get(name));
    if (!isPdfDict(fontObj)) return null;

    const font = parseFont(fontObj, (obj) => this.resolveObj(obj));

    // If font has a ToUnicode stream, decode it via the parser
    if (!font.toUnicode || font.toUnicode.size === 0) {
      const touniRef = fontObj.get('ToUnicode');
      if (touniRef) {
        const stream = this.resolveObj(touniRef);
        if (isPdfStream(stream) && this.parser) {
          const decoded = this.parser.decodeStreamData(stream);
          font.toUnicode = parseToUnicodeCMap(decoded);
        }
      }
    }

    this.fontCache.set(name, font);
    return font;
  }

  private resolveObj(obj: PdfObject | undefined): PdfObject {
    if (obj === undefined) return null;
    if (this.parser && isPdfRef(obj)) return this.parser.resolveRef(obj);
    return obj;
  }

  // --- Text rendering ---

  private showText(bytes: Uint8Array): void {
    const font = this.state.font;
    const fontSize = this.state.fontSize;

    if (font?.isComposite) {
      // Type0 fonts use 2-byte character codes
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const charCode = (bytes[i] << 8) | bytes[i + 1];
        this.renderChar(charCode, font, fontSize);
      }
    } else {
      for (let i = 0; i < bytes.length; i++) {
        this.renderChar(bytes[i], font, fontSize);
      }
    }
  }

  private showTextArray(operands: CsToken[]): void {
    // TJ array: mix of strings and numbers
    const arr = operands[0]?.value;
    if (!Array.isArray(arr)) {
      // Maybe it's a direct string
      if (operands[0]?.type === 'string' || operands[0]?.type === 'hexstring') {
        this.showText(operands[0].value as Uint8Array);
      }
      return;
    }

    const font = this.state.font;
    const fontSize = this.state.fontSize;

    const composite = font?.isComposite ?? false;

    for (const item of arr) {
      if (typeof item === 'number') {
        // Adjust text position: number is in thousandths of a unit of text space
        const adjust = -item / 1000 * fontSize;
        const m: Matrix = [1, 0, 0, 1, adjust, 0];
        this.state.textMatrix = multiplyMatrix(m, this.state.textMatrix);
      } else if (item instanceof Uint8Array) {
        if (composite) {
          for (let i = 0; i + 1 < item.length; i += 2) {
            this.renderChar((item[i] << 8) | item[i + 1], font, fontSize);
          }
        } else {
          for (let i = 0; i < item.length; i++) {
            this.renderChar(item[i], font, fontSize);
          }
        }
      } else if (typeof item === 'string') {
        for (let i = 0; i < item.length; i++) {
          this.renderChar(item.charCodeAt(i), font, fontSize);
        }
      }
    }
  }

  private renderChar(charCode: number, font: PdfFont | null, fontSize: number): void {
    // Get advance width
    let advanceWidth: number;
    if (font) {
      advanceWidth = getGlyphWidth(font, charCode);
    } else {
      advanceWidth = 600;
    }

    // Map to Unicode for glyph lookup
    const unicode = font ? charToUnicode(font, charCode) : charCode;

    // Get glyph outline
    const glyphPath = getGlyphOutline(unicode);

    if (glyphPath.subpaths.length > 0) {
      // Transform: glyph space (1000 units) -> text space -> user space -> device space
      // Scale glyph horizontally to match PDF font's advance width
      const interWidth = getFallbackWidth(unicode);
      const hScale = interWidth > 0 ? advanceWidth / interWidth : 1;
      const glyphScale = fontSize / 1000;
      const glyphMatrix: Matrix = [glyphScale * hScale, 0, 0, glyphScale, 0, this.state.textRise];
      const textToCTM = multiplyMatrix(this.state.textMatrix, this.state.ctm);
      const fullTransform = multiplyMatrix(glyphMatrix, textToCTM);

      fillPath(this.buffer, this.width, this.height, glyphPath, fullTransform, this.state.fillColor, 'nonzero');
    }

    // Advance text position
    const tx = advanceWidth / 1000 * fontSize + this.state.charSpacing + (charCode === 32 ? this.state.wordSpacing : 0);
    const m: Matrix = [1, 0, 0, 1, tx, 0];
    this.state.textMatrix = multiplyMatrix(m, this.state.textMatrix);
  }

  // --- XObject handling ---

  private handleDo(name: string): void {
    const resources = this.page.resources;
    const xobjects = this.resolveObj(resources.get('XObject'));
    if (!isPdfDict(xobjects)) return;

    const xobj = this.resolveObj(xobjects.get(name));
    if (!isPdfStream(xobj)) return;

    const subtype = xobj.dict.get('Subtype') ?? null;
    if (isPdfName(subtype)) {
      if (subtype.name === 'Image') {
        this.renderImageXObject(xobj);
      } else if (subtype.name === 'Form') {
        this.renderFormXObject(xobj);
      }
    }
  }

  private renderImageXObject(stream: PdfStream): void {
    const dict = stream.dict;
    const w = dict.get('Width') as number ?? 0;
    const h = dict.get('Height') as number ?? 0;
    if (w === 0 || h === 0) return;

    const filter = this.resolveObj(dict.get('Filter'));
    const filterName = isPdfName(filter) ? filter.name :
      (Array.isArray(filter) && filter.length > 0 && isPdfName(filter[filter.length - 1]) ? (filter[filter.length - 1] as any).name : '');

    let decoded: Uint8Array;
    try {
      if (this.parser) {
        decoded = this.parser.decodeStreamData(stream);
      } else {
        decoded = stream.rawData;
      }
    } catch {
      return; // Skip images we can't decode
    }

    let pixels: PixelGrid;

    if (filterName === 'DCTDecode') {
      // JPEG embedded image
      try {
        pixels = decodeJpeg(decoded);
      } catch {
        return;
      }
    } else {
      // Raw pixel data
      const bpc = (dict.get('BitsPerComponent') as number) ?? 8;
      const cs = this.resolveObj(dict.get('ColorSpace'));
      const csName = isPdfName(cs) ? cs.name :
        (Array.isArray(cs) && cs.length > 0 && isPdfName(cs[0]) ? (cs[0] as any).name : 'DeviceRGB');

      pixels = this.decodeRawImage(decoded, w, h, bpc, csName);
    }

    // Apply SMask (soft mask) as alpha channel
    const smaskRef = dict.get('SMask');
    if (smaskRef) {
      const smaskStream = this.resolveObj(smaskRef);
      if (isPdfStream(smaskStream)) {
        try {
          const smaskW = (smaskStream.dict.get('Width') as number) ?? pixels.width;
          const smaskH = (smaskStream.dict.get('Height') as number) ?? pixels.height;
          let smaskData: Uint8Array;
          if (this.parser) {
            smaskData = this.parser.decodeStreamData(smaskStream);
          } else {
            smaskData = smaskStream.rawData;
          }
          // SMask is typically DeviceGray 8bpc — apply as alpha
          for (let i = 0; i < pixels.width * pixels.height; i++) {
            const sx = Math.floor((i % pixels.width) * smaskW / pixels.width);
            const sy = Math.floor(Math.floor(i / pixels.width) * smaskH / pixels.height);
            const maskVal = smaskData[sy * smaskW + sx] ?? 255;
            pixels.data[i * 4 + 3] = maskVal;
          }
        } catch {
          // Ignore SMask decode errors
        }
      }
    }

    // Composite onto buffer using current CTM
    compositeImage(this.buffer, this.width, this.height, pixels, this.state.ctm);
  }

  private decodeRawImage(data: Uint8Array, w: number, h: number, bpc: number, colorSpace: string): PixelGrid {
    const rgba = new Uint8Array(w * h * 4);
    let components: number;

    switch (colorSpace) {
      case 'DeviceGray': case 'CalGray': components = 1; break;
      case 'DeviceCMYK': components = 4; break;
      default: components = 3; break; // DeviceRGB, CalRGB, etc.
    }

    if (bpc === 8) {
      for (let i = 0; i < w * h; i++) {
        const srcOff = i * components;
        const dstOff = i * 4;

        if (components === 1) {
          rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = data[srcOff] ?? 0;
        } else if (components === 3) {
          rgba[dstOff] = data[srcOff] ?? 0;
          rgba[dstOff + 1] = data[srcOff + 1] ?? 0;
          rgba[dstOff + 2] = data[srcOff + 2] ?? 0;
        } else if (components === 4) {
          const c = data[srcOff] / 255;
          const m = data[srcOff + 1] / 255;
          const y = data[srcOff + 2] / 255;
          const k = data[srcOff + 3] / 255;
          rgba[dstOff] = Math.round(255 * (1 - c) * (1 - k));
          rgba[dstOff + 1] = Math.round(255 * (1 - m) * (1 - k));
          rgba[dstOff + 2] = Math.round(255 * (1 - y) * (1 - k));
        }
        rgba[dstOff + 3] = 255;
      }
    } else if (bpc === 1) {
      // 1-bit image
      for (let i = 0; i < w * h; i++) {
        const byteIdx = Math.floor(i / 8);
        const bitIdx = 7 - (i % 8);
        const bit = (data[byteIdx] >> bitIdx) & 1;
        const val = bit === 0 ? 0 : 255;
        const dstOff = i * 4;
        rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = val;
        rgba[dstOff + 3] = 255;
      }
    } else {
      // Fallback: treat as gray
      for (let i = 0; i < w * h; i++) {
        const dstOff = i * 4;
        rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = data[i] ?? 128;
        rgba[dstOff + 3] = 255;
      }
    }

    return { width: w, height: h, data: rgba };
  }

  private renderFormXObject(stream: PdfStream): void {
    const dict = stream.dict;

    // Save state
    this.stateStack.push(cloneState(this.state));

    // Apply form matrix
    const matrix = dict.get('Matrix');
    if (Array.isArray(matrix) && matrix.length >= 6) {
      const m = matrix.map(v => typeof v === 'number' ? v : 0) as unknown as Matrix;
      this.state.ctm = multiplyMatrix(m as Matrix, this.state.ctm);
    }

    // Merge form resources with page resources
    const formResources = this.resolveObj(dict.get('Resources'));
    const savedResources = this.page.resources;
    if (isPdfDict(formResources)) {
      // Temporarily replace page resources with merged set
      const merged = new Map(savedResources);
      for (const [k, v] of formResources) {
        merged.set(k, v);
      }
      this.page.resources = merged;
    }

    // Decode and execute the form's content stream
    let contentData: Uint8Array;
    try {
      if (this.parser) {
        contentData = this.parser.decodeStreamData(stream);
      } else {
        contentData = stream.rawData;
      }
      this.executeContentStream(contentData);
    } catch {
      // Skip broken form xobjects
    }

    // Restore resources and state
    this.page.resources = savedResources;
    this.state = this.stateStack.pop()!;
  }

  // --- ExtGState ---

  private handleExtGState(operands: CsToken[]): void {
    const name = this.nameVal(operands, 0);
    const resources = this.page.resources;
    const extGStates = this.resolveObj(resources.get('ExtGState'));
    if (!isPdfDict(extGStates)) return;

    const gs = this.resolveObj(extGStates.get(name));
    if (!isPdfDict(gs)) return;

    // Apply relevant state parameters
    const lw = gs.get('LW');
    if (typeof lw === 'number') this.state.lineWidth = lw;

    // Fill/stroke alpha
    const ca = gs.get('ca'); // fill alpha
    if (typeof ca === 'number') this.state.fillColor.a = Math.round(ca * 255);
    const CA = gs.get('CA'); // stroke alpha
    if (typeof CA === 'number') this.state.strokeColor.a = Math.round(CA * 255);
  }

  // --- Inline images ---

  private handleInlineImage(tok: ContentStreamTokenizer): void {
    // Read dictionary until ID
    const dict: PdfDict = new Map();
    while (true) {
      const t = tok.nextToken();
      if (!t) return;
      if (t.type === 'operator' && t.value === 'ID') break;
      const key = t.type === 'name' ? t.value as string : String(t.value);
      const valTok = tok.nextToken();
      if (!valTok) return;
      dict.set(key, tokenToObject(valTok));
    }

    const data = tok.readInlineImageData(dict);

    // Expand abbreviations
    const expandedDict: PdfDict = new Map();
    const ABBREVS: Record<string, string> = {
      W: 'Width', H: 'Height', BPC: 'BitsPerComponent',
      CS: 'ColorSpace', F: 'Filter', DP: 'DecodeParms',
      IM: 'ImageMask', I: 'Interpolate',
    };
    const CS_ABBREVS: Record<string, string> = {
      G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK',
    };

    for (const [k, v] of dict) {
      const fullKey = ABBREVS[k] ?? k;
      let fullVal = v;
      if (isPdfName(v) && CS_ABBREVS[v.name]) {
        fullVal = { __brand: 'PdfName' as const, name: CS_ABBREVS[v.name] };
      }
      expandedDict.set(fullKey, fullVal);
    }

    const w = expandedDict.get('Width') as number ?? 0;
    const h = expandedDict.get('Height') as number ?? 0;
    if (w === 0 || h === 0) return;

    const bpc = (expandedDict.get('BitsPerComponent') as number) ?? 8;
    const cs = expandedDict.get('ColorSpace') ?? null;
    const csName = isPdfName(cs) ? cs.name : 'DeviceRGB';

    const pixels = this.decodeRawImage(data, w, h, bpc, csName);
    compositeImage(this.buffer, this.width, this.height, pixels, this.state.ctm);
  }
}

// Export the PageRenderer class for use by decoder
export { PageRenderer };

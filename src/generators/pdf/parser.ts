import { inflateSync } from 'node:zlib';
import type {
  PdfObject, PdfDict, PdfStream, PdfRef, PdfName, PdfPage, XrefEntry,
} from './types.ts';
import { pdfName, pdfRef, pdfStream, isPdfRef, isPdfName, isPdfStream, isPdfDict } from './types.ts';
import { MAX_RECURSION_DEPTH } from '../../safety.ts';

// --- Tokenizer ---

const WS = new Set([0, 9, 10, 12, 13, 32]); // null, tab, LF, FF, CR, space
const DELIM = new Set([
  0x28, 0x29, 0x3C, 0x3E, 0x5B, 0x5D, 0x7B, 0x7D, 0x2F, 0x25,
]); // ( ) < > [ ] { } / %

function isWs(b: number): boolean { return WS.has(b); }
function isDelim(b: number): boolean { return DELIM.has(b); }
function isDigit(b: number): boolean { return b >= 0x30 && b <= 0x39; }
function isEol(b: number): boolean { return b === 0x0A || b === 0x0D; }

class Tokenizer {
  pos: number;

  constructor(private data: Uint8Array, pos: number) {
    this.pos = pos;
  }

  private byte(): number { return this.data[this.pos]; }
  private advance(): number { return this.data[this.pos++]; }
  eof(): boolean { return this.pos >= this.data.length; }

  skipWhitespaceAndComments(): void {
    while (!this.eof()) {
      const b = this.byte();
      if (isWs(b)) {
        this.pos++;
      } else if (b === 0x25) { // %
        while (!this.eof() && !isEol(this.byte())) this.pos++;
      } else {
        break;
      }
    }
  }

  readToken(): string {
    this.skipWhitespaceAndComments();
    if (this.eof()) return '';

    const start = this.pos;
    while (!this.eof() && !isWs(this.byte()) && !isDelim(this.byte())) {
      this.pos++;
    }
    return String.fromCharCode(...this.data.subarray(start, this.pos));
  }

  peekByte(): number {
    this.skipWhitespaceAndComments();
    return this.eof() ? -1 : this.byte();
  }

  readObject(depth = 0): PdfObject {
    if (depth > MAX_RECURSION_DEPTH) throw new Error('PDF object nesting too deep');
    this.skipWhitespaceAndComments();
    if (this.eof()) throw new Error('Unexpected EOF reading PDF object');

    const b = this.byte();

    // String
    if (b === 0x28) return this.readLiteralString();
    // Hex string or dict
    if (b === 0x3C) {
      if (this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3C) {
        return this.readDict(depth + 1);
      }
      return this.readHexString();
    }
    // Array
    if (b === 0x5B) return this.readArray(depth + 1);
    // Name
    if (b === 0x2F) return this.readName();
    // Number or indirect ref
    if (isDigit(b) || b === 0x2D || b === 0x2E || b === 0x2B) {
      return this.readNumberOrRef();
    }

    // Keyword (true, false, null, etc.)
    const token = this.readToken();
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    // Could be a stream keyword or other — shouldn't normally reach here
    throw new Error(`Unexpected token: ${token} at pos ${this.pos}`);
  }

  readLiteralString(): string {
    this.pos++; // skip (
    let result = '';
    let depth = 1;

    while (!this.eof() && depth > 0) {
      const b = this.advance();
      if (b === 0x28) { // (
        depth++;
        result += '(';
      } else if (b === 0x29) { // )
        depth--;
        if (depth > 0) result += ')';
      } else if (b === 0x5C) { // backslash
        if (this.eof()) break;
        const next = this.advance();
        switch (next) {
          case 0x6E: result += '\n'; break;  // n
          case 0x72: result += '\r'; break;  // r
          case 0x74: result += '\t'; break;  // t
          case 0x62: result += '\b'; break;  // b
          case 0x66: result += '\f'; break;  // f
          case 0x28: result += '('; break;
          case 0x29: result += ')'; break;
          case 0x5C: result += '\\'; break;
          case 0x0D: // \r or \r\n line continuation
            if (!this.eof() && this.byte() === 0x0A) this.pos++;
            break;
          case 0x0A: break; // \n line continuation
          default:
            // Octal escape
            if (next >= 0x30 && next <= 0x37) {
              let octal = next - 0x30;
              if (!this.eof() && this.byte() >= 0x30 && this.byte() <= 0x37) {
                octal = octal * 8 + (this.advance() - 0x30);
                if (!this.eof() && this.byte() >= 0x30 && this.byte() <= 0x37) {
                  octal = octal * 8 + (this.advance() - 0x30);
                }
              }
              result += String.fromCharCode(octal);
            } else {
              result += String.fromCharCode(next);
            }
        }
      } else {
        result += String.fromCharCode(b);
      }
    }
    return result;
  }

  readHexString(): string {
    this.pos++; // skip <
    let hex = '';
    while (!this.eof()) {
      const b = this.advance();
      if (b === 0x3E) break; // >
      if (isWs(b)) continue;
      hex += String.fromCharCode(b);
    }
    // Pad odd-length hex strings
    if (hex.length % 2 !== 0) hex += '0';
    let result = '';
    for (let i = 0; i < hex.length; i += 2) {
      result += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
    }
    return result;
  }

  readName(): PdfName {
    this.pos++; // skip /
    let name = '';
    while (!this.eof()) {
      const b = this.byte();
      if (isWs(b) || isDelim(b)) break;
      this.pos++;
      if (b === 0x23 && this.pos + 1 < this.data.length) { // # hex escape
        const h1 = this.advance();
        const h2 = this.advance();
        const hex = String.fromCharCode(h1, h2);
        name += String.fromCharCode(parseInt(hex, 16));
      } else {
        name += String.fromCharCode(b);
      }
    }
    return pdfName(name);
  }

  readArray(depth = 0): PdfObject[] {
    this.pos++; // skip [
    const arr: PdfObject[] = [];
    while (true) {
      this.skipWhitespaceAndComments();
      if (this.eof()) throw new Error('Unexpected EOF in array');
      if (this.byte() === 0x5D) { // ]
        this.pos++;
        return arr;
      }
      arr.push(this.readObject(depth));
    }
  }

  readDict(depth = 0): PdfDict {
    this.pos += 2; // skip <<
    const dict: PdfDict = new Map();
    while (true) {
      this.skipWhitespaceAndComments();
      if (this.eof()) throw new Error('Unexpected EOF in dict');
      if (this.byte() === 0x3E && this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3E) {
        this.pos += 2; // skip >>
        return dict;
      }
      const key = this.readName();
      const value = this.readObject(depth);
      dict.set(key.name, value);
    }
  }

  readNumberOrRef(): PdfObject {
    const savedPos = this.pos;
    const num = this.readNumber();

    // Check if this is an indirect reference: N M R
    if (Number.isInteger(num) && num >= 0) {
      const savedPos2 = this.pos;
      this.skipWhitespaceAndComments();
      if (!this.eof() && isDigit(this.byte())) {
        const gen = this.readNumber();
        if (Number.isInteger(gen) && gen >= 0) {
          this.skipWhitespaceAndComments();
          if (!this.eof() && this.byte() === 0x52) { // 'R'
            // Check next char is whitespace or delimiter
            if (this.pos + 1 >= this.data.length || isWs(this.data[this.pos + 1]) || isDelim(this.data[this.pos + 1])) {
              this.pos++; // skip R
              return pdfRef(num, gen);
            }
          }
        }
      }
      this.pos = savedPos2;
    }

    return num;
  }

  readNumber(): number {
    this.skipWhitespaceAndComments();
    const start = this.pos;
    if (!this.eof() && (this.byte() === 0x2D || this.byte() === 0x2B)) this.pos++; // sign
    let hasDot = false;
    while (!this.eof()) {
      const b = this.byte();
      if (b === 0x2E && !hasDot) {
        hasDot = true;
        this.pos++;
      } else if (isDigit(b)) {
        this.pos++;
      } else {
        break;
      }
    }
    return parseFloat(String.fromCharCode(...this.data.subarray(start, this.pos)));
  }
}

// --- PDF Parser ---

export class PdfParser {
  private xref: Map<number, XrefEntry> = new Map();
  private trailer: PdfDict = new Map();
  private objectCache: Map<number, PdfObject> = new Map();

  constructor(private data: Uint8Array) {}

  parse(): PdfPage {
    this.buildXref();
    const root = this.resolveRef(this.trailer.get('Root')!);
    if (!isPdfDict(root)) throw new Error('Invalid PDF: /Root is not a dictionary');

    if (this.trailer.has('Encrypt')) {
      throw new Error('Encrypted PDFs are not supported');
    }

    return this.getPage(root, 0);
  }

  private buildXref(): void {
    const startXref = this.findStartXref();
    this.parseXrefAt(startXref);
  }

  private findStartXref(): number {
    // Scan backward from EOF for "startxref"
    const search = new TextEncoder().encode('startxref');
    const start = Math.max(0, this.data.length - 1024);

    for (let i = this.data.length - search.length; i >= start; i--) {
      let found = true;
      for (let j = 0; j < search.length; j++) {
        if (this.data[i + j] !== search[j]) { found = false; break; }
      }
      if (found) {
        const tok = new Tokenizer(this.data, i + search.length);
        return tok.readNumber();
      }
    }
    throw new Error('Invalid PDF: startxref not found');
  }

  private parseXrefAt(offset: number): void {
    const tok = new Tokenizer(this.data, offset);
    tok.skipWhitespaceAndComments();

    // Check if this is a classic xref table or xref stream
    const peek = String.fromCharCode(this.data[tok.pos], this.data[tok.pos + 1], this.data[tok.pos + 2], this.data[tok.pos + 3]);
    if (peek === 'xref') {
      this.parseClassicXref(tok);
    } else {
      this.parseXrefStream(offset);
    }
  }

  private parseClassicXref(tok: Tokenizer): void {
    tok.pos += 4; // skip 'xref'
    tok.skipWhitespaceAndComments();

    // Read subsections
    while (!tok.eof()) {
      tok.skipWhitespaceAndComments();
      // Check for 'trailer'
      if (this.data[tok.pos] === 0x74) { // 't'
        const saved = tok.pos;
        const word = tok.readToken();
        if (word === 'trailer') break;
        tok.pos = saved;
      }

      const firstObj = tok.readNumber();
      const count = tok.readNumber();

      for (let i = 0; i < count; i++) {
        tok.skipWhitespaceAndComments();
        const offsetStr = String.fromCharCode(...this.data.subarray(tok.pos, tok.pos + 10));
        tok.pos += 10;
        tok.skipWhitespaceAndComments();
        const genStr = String.fromCharCode(...this.data.subarray(tok.pos, tok.pos + 5));
        tok.pos += 5;
        tok.skipWhitespaceAndComments();
        const type = String.fromCharCode(this.data[tok.pos]);
        tok.pos++;

        const objNum = firstObj + i;
        // Don't overwrite newer entries (incremental updates: first encountered wins)
        if (!this.xref.has(objNum)) {
          this.xref.set(objNum, {
            offset: parseInt(offsetStr.trim(), 10),
            gen: parseInt(genStr.trim(), 10),
            free: type === 'f',
          });
        }
      }
    }

    // Parse trailer dict
    tok.skipWhitespaceAndComments();
    const trailerDict = tok.readDict();
    // Merge trailer (first encountered wins for incremental updates)
    if (this.trailer.size === 0) {
      this.trailer = trailerDict;
    }

    // Follow /Prev chain
    const prev = trailerDict.get('Prev');
    if (typeof prev === 'number') {
      this.parseXrefAt(prev);
    }

    // Handle hybrid xref with /XRefStm
    const xrefStm = trailerDict.get('XRefStm');
    if (typeof xrefStm === 'number') {
      this.parseXrefStream(xrefStm);
    }
  }

  private parseXrefStream(offset: number): void {
    const tok = new Tokenizer(this.data, offset);
    tok.skipWhitespaceAndComments();

    // Read the object header: objNum genNum obj
    tok.readNumber(); // objNum
    tok.readNumber(); // genNum
    tok.readToken(); // 'obj'

    const dict = tok.readObject() as PdfDict;

    // Read stream data
    tok.skipWhitespaceAndComments();
    const streamToken = tok.readToken();
    if (streamToken !== 'stream') throw new Error('Expected stream keyword in xref stream');

    // Skip single EOL after 'stream'
    if (this.data[tok.pos] === 0x0D && this.data[tok.pos + 1] === 0x0A) tok.pos += 2;
    else if (this.data[tok.pos] === 0x0A || this.data[tok.pos] === 0x0D) tok.pos += 1;

    const length = dict.get('Length');
    if (typeof length !== 'number') throw new Error('Xref stream missing /Length');
    const rawData = this.data.subarray(tok.pos, tok.pos + length);

    const stream = pdfStream(dict, rawData);
    const decoded = this.decodeStreamData(stream);

    // Parse W array
    const wArr = dict.get('W') as number[];
    if (!Array.isArray(wArr) || wArr.length !== 3) throw new Error('Invalid /W in xref stream');
    const [w1, w2, w3] = wArr;
    const entrySize = w1 + w2 + w3;

    // Parse Index array (or default [0 Size])
    const size = dict.get('Size') as number;
    let index = dict.get('Index') as number[] | undefined;
    if (!index) index = [0, size];

    let dataPos = 0;
    for (let k = 0; k < index.length; k += 2) {
      const firstObj = index[k];
      const count = index[k + 1];
      for (let i = 0; i < count; i++) {
        const objNum = firstObj + i;
        if (dataPos + entrySize > decoded.length) break;

        let type = w1 > 0 ? this.readIntBE(decoded, dataPos, w1) : 1;
        let field2 = this.readIntBE(decoded, dataPos + w1, w2);
        let field3 = w3 > 0 ? this.readIntBE(decoded, dataPos + w1 + w2, w3) : 0;
        dataPos += entrySize;

        if (!this.xref.has(objNum)) {
          if (type === 0) {
            this.xref.set(objNum, { offset: 0, gen: field3, free: true });
          } else if (type === 1) {
            this.xref.set(objNum, { offset: field2, gen: field3, free: false });
          } else if (type === 2) {
            this.xref.set(objNum, { offset: 0, gen: 0, free: false, inStream: field2, indexInStream: field3 });
          }
        }
      }
    }

    // Use this stream's dict as trailer if we don't have one yet
    if (this.trailer.size === 0) {
      this.trailer = dict;
    }

    // Follow /Prev chain
    const prev = dict.get('Prev');
    if (typeof prev === 'number') {
      this.parseXrefAt(prev);
    }
  }

  private readIntBE(data: Uint8Array, offset: number, length: number): number {
    let value = 0;
    for (let i = 0; i < length; i++) {
      value = (value << 8) | data[offset + i];
    }
    return value;
  }

  resolveRef(obj: PdfObject): PdfObject {
    if (isPdfRef(obj)) return this.getObject(obj.objNum);
    return obj;
  }

  private getObject(objNum: number): PdfObject {
    if (this.objectCache.has(objNum)) return this.objectCache.get(objNum)!;

    const entry = this.xref.get(objNum);
    if (!entry || entry.free) return null;

    let result: PdfObject;

    if (entry.inStream !== undefined) {
      result = this.getObjectFromStream(entry.inStream!, entry.indexInStream!);
    } else {
      result = this.parseObjectAt(entry.offset);
    }

    this.objectCache.set(objNum, result);
    return result;
  }

  private parseObjectAt(offset: number): PdfObject {
    const tok = new Tokenizer(this.data, offset);
    tok.skipWhitespaceAndComments();

    // Read: objNum genNum obj
    tok.readNumber();
    tok.readNumber();
    const objKeyword = tok.readToken();
    if (objKeyword !== 'obj') throw new Error(`Expected 'obj' at offset ${offset}, got '${objKeyword}'`);

    tok.skipWhitespaceAndComments();
    const value = tok.readObject();

    // Check for stream
    tok.skipWhitespaceAndComments();
    if (!tok.eof() && tok.pos + 6 <= this.data.length) {
      const next = String.fromCharCode(...this.data.subarray(tok.pos, tok.pos + 6));
      if (next === 'stream' && isPdfDict(value)) {
        tok.pos += 6;
        // Skip single EOL
        if (this.data[tok.pos] === 0x0D && this.data[tok.pos + 1] === 0x0A) tok.pos += 2;
        else if (this.data[tok.pos] === 0x0A || this.data[tok.pos] === 0x0D) tok.pos += 1;

        const length = this.resolveRef(value.get('Length') ?? null);
        if (typeof length !== 'number') throw new Error('Stream missing /Length');

        const rawData = this.data.subarray(tok.pos, tok.pos + length);
        return pdfStream(value, rawData);
      }
    }

    return value;
  }

  private getObjectFromStream(streamObjNum: number, index: number): PdfObject {
    const streamObj = this.getObject(streamObjNum);
    if (!isPdfStream(streamObj)) throw new Error('Object stream is not a stream');

    const decoded = this.decodeStreamData(streamObj);
    const n = this.resolveRef(streamObj.dict.get('N') ?? null);
    if (typeof n !== 'number') throw new Error('Object stream missing /N');

    // Parse the header: pairs of (objNum offset) repeated N times
    const headerTok = new Tokenizer(decoded, 0);
    const entries: { objNum: number; offset: number }[] = [];
    for (let i = 0; i < n; i++) {
      const num = headerTok.readNumber();
      const off = headerTok.readNumber();
      entries.push({ objNum: num, offset: off });
    }

    const first = this.resolveRef(streamObj.dict.get('First') ?? null);
    if (typeof first !== 'number') throw new Error('Object stream missing /First');

    const entry = entries[index];
    const objTok = new Tokenizer(decoded, first + entry.offset);
    return objTok.readObject();
  }

  decodeStreamData(stream: PdfStream): Uint8Array {
    let data = new Uint8Array(stream.rawData);
    const filter = this.resolveRef(stream.dict.get('Filter') ?? null);
    const parms = this.resolveRef(stream.dict.get('DecodeParms') ?? null);

    const filters: string[] = [];
    const parmsList: (PdfDict | null)[] = [];

    if (isPdfName(filter)) {
      filters.push(filter.name);
      parmsList.push(isPdfDict(parms) ? parms : null);
    } else if (Array.isArray(filter)) {
      for (let i = 0; i < filter.length; i++) {
        const f = filter[i];
        if (isPdfName(f)) filters.push(f.name);
        parmsList.push(Array.isArray(parms) && isPdfDict(parms[i]) ? parms[i] as PdfDict : null);
      }
    }

    for (let i = 0; i < filters.length; i++) {
      const filtered = this.applyFilter(data, filters[i], parmsList[i] ?? null);
      data = new Uint8Array(filtered);
    }

    return data;
  }

  private applyFilter(data: Uint8Array, filter: string, parms: PdfDict | null): Uint8Array {
    switch (filter) {
      case 'FlateDecode':
      case 'Fl': {
        const decoded = inflateSync(data);
        const decodedArr = new Uint8Array(decoded.length);
        decodedArr.set(decoded);
        if (parms) {
          const predictor = this.numVal(parms.get('Predictor'), 1);
          if (predictor >= 10) {
            return this.undoPngPredictor(decodedArr, parms);
          }
          if (predictor === 2) {
            return this.undoTiffPredictor(decodedArr, parms);
          }
        }
        return decodedArr;
      }
      case 'ASCIIHexDecode':
      case 'AHx':
        return this.decodeAsciiHex(data);
      case 'ASCII85Decode':
      case 'A85':
        return this.decodeAscii85(data);
      case 'LZWDecode':
      case 'LZW':
        return this.decodeLzw(data, parms);
      default:
        // Return raw data for unsupported filters
        return data;
    }
  }

  private undoPngPredictor(data: Uint8Array, parms: PdfDict): Uint8Array {
    const columns = this.numVal(parms.get('Columns'), 1);
    const colors = this.numVal(parms.get('Colors'), 1);
    const bpc = this.numVal(parms.get('BitsPerComponent'), 8);
    const bytesPerPixel = Math.ceil(colors * bpc / 8);
    const rowBytes = Math.ceil(columns * colors * bpc / 8);
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);

    for (let y = 0; y < rows; y++) {
      const srcOff = y * (rowBytes + 1);
      const filterByte = data[srcOff];
      const dstOff = y * rowBytes;
      const prevRow = y > 0 ? dstOff - rowBytes : -1;

      for (let x = 0; x < rowBytes; x++) {
        const raw = data[srcOff + 1 + x];
        const a = x >= bytesPerPixel ? out[dstOff + x - bytesPerPixel] : 0;
        const b = prevRow >= 0 ? out[prevRow + x] : 0;
        const c = (prevRow >= 0 && x >= bytesPerPixel) ? out[prevRow + x - bytesPerPixel] : 0;

        switch (filterByte) {
          case 0: out[dstOff + x] = raw; break;
          case 1: out[dstOff + x] = (raw + a) & 0xFF; break;
          case 2: out[dstOff + x] = (raw + b) & 0xFF; break;
          case 3: out[dstOff + x] = (raw + ((a + b) >> 1)) & 0xFF; break;
          case 4: out[dstOff + x] = (raw + this.paeth(a, b, c)) & 0xFF; break;
          default: out[dstOff + x] = raw;
        }
      }
    }
    return out;
  }

  private paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  private undoTiffPredictor(data: Uint8Array, parms: PdfDict): Uint8Array {
    const columns = this.numVal(parms.get('Columns'), 1);
    const colors = this.numVal(parms.get('Colors'), 1);
    const rowBytes = columns * colors;
    const rows = Math.floor(data.length / rowBytes);
    const out = new Uint8Array(data);

    for (let y = 0; y < rows; y++) {
      const off = y * rowBytes;
      for (let x = colors; x < rowBytes; x++) {
        out[off + x] = (out[off + x] + out[off + x - colors]) & 0xFF;
      }
    }
    return out;
  }

  private decodeAsciiHex(data: Uint8Array): Uint8Array {
    const bytes: number[] = [];
    let high = -1;
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b === 0x3E) break; // >
      if (isWs(b)) continue;
      const nibble = b <= 0x39 ? b - 0x30 : (b <= 0x46 ? b - 0x37 : b - 0x57);
      if (high === -1) {
        high = nibble;
      } else {
        bytes.push((high << 4) | nibble);
        high = -1;
      }
    }
    if (high !== -1) bytes.push(high << 4);
    return new Uint8Array(bytes);
  }

  private decodeAscii85(data: Uint8Array): Uint8Array {
    const bytes: number[] = [];
    let i = 0;
    while (i < data.length) {
      if (data[i] === 0x7E && i + 1 < data.length && data[i + 1] === 0x3E) break; // ~>
      if (isWs(data[i])) { i++; continue; }
      if (data[i] === 0x7A) { // z
        bytes.push(0, 0, 0, 0);
        i++;
        continue;
      }

      const group: number[] = [];
      while (group.length < 5 && i < data.length) {
        if (data[i] === 0x7E) break;
        if (!isWs(data[i])) group.push(data[i] - 33);
        i++;
      }

      if (group.length < 2) break;
      // Pad with 'u' (84) values
      while (group.length < 5) group.push(84);

      let value = 0;
      for (let j = 0; j < 5; j++) value = value * 85 + group[j];

      const numBytes = group.length < 5 ? group.length - 1 : 4;
      for (let j = 3; j >= 4 - numBytes; j--) {
        bytes.push((value >> (j * 8)) & 0xFF);
      }
    }
    return new Uint8Array(bytes);
  }

  private decodeLzw(data: Uint8Array, parms: PdfDict | null): Uint8Array {
    const earlyChange = parms ? this.numVal(parms.get('EarlyChange'), 1) : 1;

    let bitPos = 0;
    function readBits(n: number): number {
      let val = 0;
      for (let i = 0; i < n; i++) {
        const byteIdx = (bitPos + i) >> 3;
        const bitIdx = 7 - ((bitPos + i) & 7);
        if (byteIdx < data.length) {
          val = (val << 1) | ((data[byteIdx] >> bitIdx) & 1);
        }
      }
      bitPos += n;
      return val;
    }

    const CLEAR = 256;
    const EOD = 257;
    const output: number[] = [];

    let codeSize = 9;
    let table: Uint8Array[] = [];

    function resetTable() {
      table = [];
      for (let i = 0; i < 258; i++) {
        table.push(i < 256 ? new Uint8Array([i]) : new Uint8Array(0));
      }
      codeSize = 9;
    }

    resetTable();
    let prevEntry: Uint8Array | null = null;

    while (bitPos < data.length * 8) {
      const code = readBits(codeSize);

      if (code === EOD) break;
      if (code === CLEAR) {
        resetTable();
        prevEntry = null;
        continue;
      }

      let entry: Uint8Array;
      if (code < table.length) {
        entry = table[code];
      } else if (code === table.length && prevEntry) {
        entry = new Uint8Array(prevEntry.length + 1);
        entry.set(prevEntry);
        entry[prevEntry.length] = prevEntry[0];
      } else {
        break; // invalid
      }

      for (let i = 0; i < entry.length; i++) output.push(entry[i]);

      if (prevEntry) {
        const newEntry = new Uint8Array(prevEntry.length + 1);
        newEntry.set(prevEntry);
        newEntry[prevEntry.length] = entry[0];
        table.push(newEntry);
      }

      const maxCode = (1 << codeSize) - (earlyChange ? 1 : 0);
      if (table.length >= maxCode && codeSize < 12) {
        codeSize++;
      }

      prevEntry = entry;
    }

    let result: Uint8Array = new Uint8Array(output);

    // Handle predictor
    if (parms) {
      const predictor = this.numVal(parms.get('Predictor') ?? null, 1);
      if (predictor >= 10) {
        result = this.undoPngPredictor(result, parms);
      } else if (predictor === 2) {
        result = this.undoTiffPredictor(result, parms);
      }
    }

    return result;
  }

  private numVal(obj: PdfObject | undefined | null, fallback: number): number {
    if (typeof obj === 'number') return obj;
    return fallback;
  }

  private getPage(root: PdfDict, pageIndex: number): PdfPage {
    const pagesRef = root.get('Pages');
    const pages = this.resolveRef(pagesRef!) as PdfDict;

    const result = this.findPage(pages, pageIndex, new Map());
    if (!result) throw new Error('Page not found');
    return result;
  }

  private findPage(
    node: PdfDict,
    targetIndex: number,
    inherited: Map<string, PdfObject>,
  ): PdfPage | null {
    // Merge inheritable properties
    const merged = new Map(inherited);
    for (const key of ['MediaBox', 'Resources', 'Rotate']) {
      if (node.has(key)) merged.set(key, node.get(key)!);
    }

    const type = node.get('Type');
    const typeName = isPdfName(type ?? null) ? (type as PdfName).name : '';

    if (typeName === 'Page') {
      if (targetIndex === 0) {
        return this.buildPage(node, merged);
      }
      return null;
    }

    // Pages node
    const kids = this.resolveRef(node.get('Kids') ?? null) as PdfObject[];
    let remaining = targetIndex;

    for (const kidRef of kids) {
      const kid = this.resolveRef(kidRef) as PdfDict;
      const kidType = kid.get('Type') ?? null;
      const kidTypeName = isPdfName(kidType) ? kidType.name : '';

      if (kidTypeName === 'Page') {
        if (remaining === 0) {
          return this.buildPage(kid, merged);
        }
        remaining--;
      } else {
        // Pages node
        const count = kid.get('Count') as number;
        if (remaining < count) {
          return this.findPage(kid, remaining, merged);
        }
        remaining -= count;
      }
    }
    return null;
  }

  private buildPage(pageDict: PdfDict, inherited: Map<string, PdfObject>): PdfPage {
    // MediaBox
    let mediaBox = pageDict.get('MediaBox') ?? inherited.get('MediaBox');
    mediaBox = this.resolveRef(mediaBox!);
    if (!Array.isArray(mediaBox) || mediaBox.length < 4) {
      throw new Error('Page missing /MediaBox');
    }
    const mb = mediaBox.map(v => typeof v === 'number' ? v : 0) as [number, number, number, number];

    // Resources
    let resources = pageDict.get('Resources') ?? inherited.get('Resources');
    resources = this.resolveRef(resources ?? null);
    if (!isPdfDict(resources)) resources = new Map();

    // Content streams
    let contents = pageDict.get('Contents');
    const contentStreams: Uint8Array[] = [];

    if (contents) {
      contents = this.resolveRef(contents);
      if (isPdfStream(contents)) {
        contentStreams.push(this.decodeStreamData(contents));
      } else if (Array.isArray(contents)) {
        for (const ref of contents) {
          const stream = this.resolveRef(ref);
          if (isPdfStream(stream)) {
            contentStreams.push(this.decodeStreamData(stream));
          }
        }
      }
    }

    // Rotate
    let rotate = pageDict.get('Rotate') ?? inherited.get('Rotate');
    if (typeof rotate !== 'number') rotate = 0;

    return { mediaBox: mb, contentStreams, resources: resources as PdfDict, rotate: rotate as number };
  }
}

export function parsePdf(data: Uint8Array): PdfPage {
  const parser = new PdfParser(data);
  return parser.parse();
}

// PDF object model
export type PdfObject =
  | null
  | boolean
  | number
  | string
  | PdfName
  | PdfObject[]
  | PdfDict
  | PdfStream
  | PdfRef;

export interface PdfName {
  readonly __brand: 'PdfName';
  readonly name: string;
}

export interface PdfRef {
  readonly __brand: 'PdfRef';
  readonly objNum: number;
  readonly genNum: number;
}

export type PdfDict = Map<string, PdfObject>;

export interface PdfStream {
  readonly __brand: 'PdfStream';
  readonly dict: PdfDict;
  readonly rawData: Uint8Array;
}

export interface XrefEntry {
  offset: number;
  gen: number;
  free: boolean;
  // For object streams (type 2 xref entries)
  inStream?: number; // object stream number
  indexInStream?: number;
}

export interface PdfPage {
  mediaBox: readonly [number, number, number, number];
  contentStreams: Uint8Array[];
  resources: PdfDict;
  rotate: number;
}

// Graphics types
export type Matrix = [number, number, number, number, number, number]; // [a,b,c,d,e,f]

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PathSegment {
  type: 'move' | 'line' | 'cubic';
  x: number;
  y: number;
  cx1?: number;
  cy1?: number;
  cx2?: number;
  cy2?: number;
}

export interface Subpath {
  segments: PathSegment[];
  closed: boolean;
}

export interface Path {
  subpaths: Subpath[];
}

export interface PdfFont {
  widths: Map<number, number>;
  firstChar: number;
  lastChar: number;
  toUnicode: Map<number, number> | null;
  encoding: Map<number, string> | null;
  baseFont: string;
  defaultWidth: number;
}

export interface GraphicsState {
  ctm: Matrix;
  fillColor: RGBA;
  strokeColor: RGBA;
  lineWidth: number;
  font: PdfFont | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  textLeading: number;
  textRise: number;
  textMatrix: Matrix;
  textLineMatrix: Matrix;
  clippingPath: Path | null;
}

export interface PdfImage {
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: string;
  data: Uint8Array;
  decode?: number[];
}

// Helper constructors
export function pdfName(name: string): PdfName {
  return { __brand: 'PdfName', name } as PdfName;
}

export function pdfRef(objNum: number, genNum: number): PdfRef {
  return { __brand: 'PdfRef', objNum, genNum } as PdfRef;
}

export function pdfStream(dict: PdfDict, rawData: Uint8Array): PdfStream {
  return { __brand: 'PdfStream', dict, rawData } as PdfStream;
}

export function isPdfName(obj: PdfObject): obj is PdfName {
  return obj !== null && typeof obj === 'object' && '__brand' in obj && obj.__brand === 'PdfName';
}

export function isPdfRef(obj: PdfObject): obj is PdfRef {
  return obj !== null && typeof obj === 'object' && '__brand' in obj && obj.__brand === 'PdfRef';
}

export function isPdfStream(obj: PdfObject): obj is PdfStream {
  return obj !== null && typeof obj === 'object' && '__brand' in obj && obj.__brand === 'PdfStream';
}

export function isPdfDict(obj: PdfObject): obj is PdfDict {
  return obj instanceof Map;
}

export function nameStr(obj: PdfObject): string {
  if (isPdfName(obj)) return obj.name;
  throw new Error(`Expected PDF name, got ${typeof obj}`);
}

export function dictGet(dict: PdfDict, key: string): PdfObject | undefined {
  return dict.get(key);
}

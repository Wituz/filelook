export interface PptxTheme {
  colors: Map<string, string>; // scheme name → hex (e.g. 'dk1' → '000000')
}

export interface PptxSlide {
  width: number;  // points
  height: number; // points
  background: string | null; // hex color
  shapes: PptxShape[];
}

export type PptxShape = PptxTextShape | PptxPictureShape;

export interface PptxTextShape {
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null; // hex color
  anchor: 't' | 'ctr' | 'b'; // vertical text alignment within shape
  paragraphs: PptxParagraph[];
}

export interface PptxPictureShape {
  type: 'picture';
  x: number;
  y: number;
  width: number;
  height: number;
  rId: string;
}

export interface PptxParagraph {
  alignment: 'left' | 'center' | 'right';
  runs: PptxRun[];
  spaceBefore: number; // points
  spaceAfter: number;  // points
  bullet: string | null;
}

export interface PptxRun {
  text: string;
  fontSize: number; // points
  bold: boolean;
  color: string | null; // hex color
  shadow: boolean;
}

export interface PlaceholderDef {
  type: string | null;
  idx: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: 't' | 'ctr' | 'b';
}

// XML node (shared by all DOCX parsers)
export interface XmlNode {
  tag: string;
  prefix: string;
  attrs: Map<string, string>;
  children: XmlNode[];
  text: string;
}

// Document model
export interface DocxDocument {
  body: DocxBlock[];
  styles: Map<string, DocxStyle>;
  defaults: DocxParagraphProps;
  defaultRunProps: DocxRunProps;
  relationships: Map<string, string>;
  images: Map<string, Uint8Array>;
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export type DocxBlock = DocxParagraph | DocxTable;

export interface DocxParagraph {
  type: 'paragraph';
  props: DocxParagraphProps;
  runs: DocxRun[];
}

export interface DocxTable {
  type: 'table';
  rows: DocxTableRow[];
  columnWidths: number[];
  borders: DocxBorderSet;
}

export interface DocxTableRow {
  cells: DocxTableCell[];
  height: number;
}

export interface DocxTableCell {
  blocks: DocxBlock[];
  columnSpan: number;
  shading: string | null;
}

export interface DocxRun {
  type: 'text' | 'break' | 'tab' | 'image';
  text: string;
  props: DocxRunProps;
  image?: DocxInlineImage;
}

export interface DocxInlineImage {
  rId: string;
  widthPt: number;
  heightPt: number;
}

export interface DocxFloatingImage {
  rId: string;
  widthPt: number;
  heightPt: number;
  x: number;
  y: number;
  wrapMode: 'square' | 'tight' | 'topAndBottom' | 'none';
}

export interface DocxStyle {
  id: string;
  basedOn: string | null;
  paragraphProps: DocxParagraphProps;
  runProps: DocxRunProps;
}

export interface DocxParagraphProps {
  alignment: 'left' | 'center' | 'right' | 'justify';
  spaceBefore: number;
  spaceAfter: number;
  lineSpacing: number;
  indentLeft: number;
  indentRight: number;
  indentFirstLine: number;
  bullet: string | null;
  borderBottom: DocxBorder | null;
  shading: string | null;
  styleId: string | null;
  pageBreakBefore: boolean;
}

export interface DocxRunProps {
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  styleId: string | null;
}

export interface DocxBorder {
  width: number;
  color: string;
}

export interface DocxBorderSet {
  top: DocxBorder | null;
  bottom: DocxBorder | null;
  left: DocxBorder | null;
  right: DocxBorder | null;
  insideH: DocxBorder | null;
  insideV: DocxBorder | null;
}

// Layout output
export interface LayoutLine {
  x: number;
  y: number;
  items: LayoutItem[];
  width: number;
  alignment: 'left' | 'center' | 'right' | 'justify';
}

export type LayoutItem = LayoutTextItem | LayoutImageItem;

export interface LayoutTextItem {
  type: 'text';
  x: number;
  char: number;
  fontSize: number;
  bold: boolean;
  color: string | null;
  underline: boolean;
}

export interface LayoutImageItem {
  type: 'image';
  x: number;
  width: number;
  height: number;
  rId: string;
}

export interface LayoutResult {
  lines: LayoutLine[];
  floatingImages: LayoutFloatingImage[];
  backgrounds: LayoutBackground[];
  borders: LayoutBorderLine[];
  tableBorders: LayoutBorderLine[];
}

export interface LayoutFloatingImage {
  x: number;
  y: number;
  width: number;
  height: number;
  rId: string;
}

export interface LayoutBackground {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface LayoutBorderLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  color: string;
}

export const DEFAULT_PARA_PROPS: DocxParagraphProps = {
  alignment: 'left',
  spaceBefore: 0,
  spaceAfter: 8,
  lineSpacing: 1.15,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  bullet: null,
  borderBottom: null,
  shading: null,
  styleId: null,
  pageBreakBefore: false,
};

export const DEFAULT_RUN_PROPS: DocxRunProps = {
  fontSize: 11,
  bold: false,
  italic: false,
  underline: false,
  color: null,
  styleId: null,
};

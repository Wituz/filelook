export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  sharedStrings: string[];
  styles: XlsxStyles;
  theme: XlsxTheme;
  images: Map<string, Uint8Array>;
  charts: XlsxChartRef[];
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxRow[];
  mergeCells: XlsxMergeCell[];
  defaultRowHeight: number;
  defaultColWidth: number;
  drawings: XlsxDrawing[];
  showGridLines: boolean;
}

export interface XlsxColumn {
  min: number;
  max: number;
  widthChars: number;
  hidden: boolean;
}

export interface XlsxRow {
  index: number;
  height: number;
  cells: XlsxCell[];
  hidden: boolean;
}

export interface XlsxCell {
  ref: string;
  col: number;
  row: number;
  value: string;
  styleIndex: number;
  type: string; // s, n, str, b, inlineStr, or ''
}

export interface XlsxMergeCell {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export interface XlsxStyles {
  fonts: XlsxFont[];
  fills: XlsxFill[];
  borders: XlsxBorder[];
  cellXfs: XlsxCellXf[];
  numFmts: Map<number, string>;
}

export interface XlsxFont {
  size: number;
  bold: boolean;
  italic: boolean;
  color: string | null;
}

export interface XlsxFill {
  fgColor: string | null;
  patternType: string;
}

export interface XlsxBorder {
  left: XlsxBorderEdge | null;
  right: XlsxBorderEdge | null;
  top: XlsxBorderEdge | null;
  bottom: XlsxBorderEdge | null;
}

export interface XlsxBorderEdge {
  style: string;
  color: string | null;
}

export interface XlsxCellXf {
  fontId: number;
  fillId: number;
  borderId: number;
  numFmtId: number;
  alignment: XlsxAlignment;
}

export interface XlsxAlignment {
  horizontal: string; // general, left, center, right
  vertical: string;   // bottom, center, top
  wrapText: boolean;
}

export interface XlsxTheme {
  colors: Map<string, string>;
}

export interface XlsxDrawing {
  type: 'chart' | 'image';
  fromCol: number;
  fromRow: number;
  fromColOff: number;
  fromRowOff: number;
  toCol: number;
  toRow: number;
  toColOff: number;
  toRowOff: number;
  rId: string;
}

export interface XlsxChartRef {
  drawingIndex: number;
  chartPath: string;
  drawing: XlsxDrawing;
}

export interface XlsxChart {
  chartType: string;
  series: XlsxChartSeries[];
  categories: string[];
  title: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XlsxChartSeries {
  name: string;
  values: number[];
  color: string;
}

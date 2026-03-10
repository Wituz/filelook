// PPT record types
export const RT_DOCUMENT = 0x03E8;
export const RT_DOCUMENT_ATOM = 0x03E9;
export const RT_SLIDE = 0x03EE;
export const RT_DRAWING = 0x040C;
export const RT_SLIDE_LIST_WITH_TEXT = 0x0FF0;
export const RT_SLIDE_PERSIST_ATOM = 0x03F3;
export const RT_TEXT_HEADER_ATOM = 0x0F9F;
export const RT_TEXT_CHARS_ATOM = 0x0FA0;
export const RT_TEXT_BYTES_ATOM = 0x0FA8;
export const RT_STYLE_TEXT_PROP_ATOM = 0x0FA1;

// Escher record types
export const ESCHER_DG_CONTAINER = 0xF002;
export const ESCHER_SPGR_CONTAINER = 0xF003;
export const ESCHER_SP_CONTAINER = 0xF004;
export const ESCHER_FSP = 0xF00A;
export const ESCHER_FOPT = 0xF00B;
export const ESCHER_CLIENT_ANCHOR = 0xF010;
export const ESCHER_CLIENT_TEXTBOX = 0xF00D;

// FOPT property IDs
export const FOPT_PIC_ID = 0x0104;
export const FOPT_FILL_COLOR = 0x0181;

export interface PptRecord {
  recVer: number;
  recInstance: number;
  recType: number;
  recLen: number;
  offset: number; // data start offset (after 8-byte header)
  children?: PptRecord[];
}

export interface PptShapeInfo {
  anchor: { x: number; y: number; width: number; height: number } | null;
  shapeType: number;
  foptProps: Map<number, number>;
  textboxRecords: PptRecord[];
}

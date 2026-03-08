export interface FibFields {
  fWhichTblStm: boolean;
  ccpText: number;
  fcClx: number;
  lcbClx: number;
  fcPlcfBteChpx: number;
  lcbPlcfBteChpx: number;
  fcPlcfBtePapx: number;
  lcbPlcfBtePapx: number;
  fcDggInfo: number;
  lcbDggInfo: number;
  fcPlcSpaMom: number;
  lcbPlcSpaMom: number;
}

export interface PieceDescriptor {
  cpStart: number;
  cpEnd: number;
  fc: number;
  isAnsi: boolean;
}

export interface CharProps {
  cpStart: number;
  cpEnd: number;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  colorIndex: number;
  underline: boolean;
  isSpecial: boolean;
  picLocation: number;
}

export interface ParaProps {
  cpStart: number;
  cpEnd: number;
  alignment: number;
  spaceBefore: number;
  spaceAfter: number;
  indentLeft: number;
  indentRight: number;
  indentFirstLine: number;
}

// Sprm opcodes (only what we need)
export const SPRM_C_FBOLD = 0x0835;
export const SPRM_C_FITALIC = 0x0836;
export const SPRM_C_HPS = 0x4A43;
export const SPRM_C_ICO = 0x2A42;
export const SPRM_C_FSPEC = 0x0855;
export const SPRM_C_PIC_LOCATION = 0x6A03;
export const SPRM_C_KUL = 0x2A3E;
export const SPRM_P_JC80 = 0x2403;
export const SPRM_P_DYA_BEFORE = 0xA413;
export const SPRM_P_DYA_AFTER = 0xA414;
export const SPRM_P_DXA_LEFT = 0x840F;
export const SPRM_P_DXA_RIGHT = 0x840E;
export const SPRM_P_DXA_LEFT1 = 0x8411;

// DOC color index → hex
export const DOC_COLORS: readonly string[] = [
  '000000', // 0: auto (black)
  '000000', // 1: black
  '0000FF', // 2: blue
  '00FFFF', // 3: cyan
  '00FF00', // 4: green
  'FF00FF', // 5: magenta
  'FF0000', // 6: red
  'FFFF00', // 7: yellow
  'FFFFFF', // 8: white
  '000080', // 9: dark blue
  '008080', // 10: dark cyan
  '008000', // 11: dark green
  '800080', // 12: dark magenta
  '800000', // 13: dark red
  '808000', // 14: dark yellow
  '808080', // 15: dark gray
  'C0C0C0', // 16: light gray
];

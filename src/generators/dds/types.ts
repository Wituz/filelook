export interface DdsHeader {
  width: number;
  height: number;
  pfFlags: number;
  fourCC: string;
  rgbBitCount: number;
  rMask: number;
  gMask: number;
  bMask: number;
  aMask: number;
}

export const DDPF_ALPHAPIXELS = 0x1;
export const DDPF_FOURCC = 0x4;
export const DDPF_RGB = 0x40;

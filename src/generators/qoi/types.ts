export interface QoiHeader {
  width: number;
  height: number;
  channels: number; // 3=RGB, 4=RGBA
  colorspace: number; // 0=sRGB, 1=linear (informational only)
}

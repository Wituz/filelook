import type { RGBA, Matrix } from '../pdf/types.ts';
import type { XmlNode } from '../docx/xml.ts';

export type SvgPaint =
  | { type: 'none' }
  | { type: 'color'; color: RGBA }
  | { type: 'gradient'; id: string };

export interface SvgStyle {
  fill: SvgPaint;
  stroke: SvgPaint;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  fillRule: 'nonzero' | 'evenodd';
  display: boolean;
}

export interface SvgGradientStop {
  offset: number;
  color: RGBA;
}

export interface SvgLinearGradient {
  type: 'linear';
  x1: number; y1: number;
  x2: number; y2: number;
  stops: SvgGradientStop[];
  transform: Matrix;
}

export interface SvgRadialGradient {
  type: 'radial';
  cx: number; cy: number; r: number;
  fx: number; fy: number;
  stops: SvgGradientStop[];
  transform: Matrix;
}

export type SvgGradient = SvgLinearGradient | SvgRadialGradient;

export interface SvgDefs {
  gradients: Map<string, SvgGradient>;
  elements: Map<string, XmlNode>;
}

export const DEFAULT_STYLE: SvgStyle = {
  fill: { type: 'color', color: { r: 0, g: 0, b: 0, a: 255 } },
  stroke: { type: 'none' },
  strokeWidth: 1,
  opacity: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  fillRule: 'nonzero',
  display: true,
};

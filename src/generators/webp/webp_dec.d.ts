export interface WebPModule {
  decode(data: ArrayBuffer): { width: number; height: number; data: Uint8ClampedArray } | null;
}

declare const moduleFactory: (opts?: Record<string, unknown>) => Promise<WebPModule>;
export default moduleFactory;

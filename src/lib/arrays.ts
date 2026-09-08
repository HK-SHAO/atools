/* Typed arrays carry their backing buffer in the type since TS 5.7; the DOM APIs
   (ImageData, copyToChannel, BlobPart) only take ArrayBuffer-backed ones. */

export type Samples = Float32Array<ArrayBuffer>;
export type Pixels = Uint8ClampedArray<ArrayBuffer>;
export type Bytes = Uint8Array<ArrayBuffer>;

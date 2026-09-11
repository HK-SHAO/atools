declare module "@audio/*/meta" {
  export function parseMeta(bytes: Uint8Array): { sampleRate?: number } | null;
}

declare module "@audio/decode-mp3/meta" {
  export function parseId3v2(bytes: Uint8Array): { size: number } | null;
}

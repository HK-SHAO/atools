/**
 * `@audio/decode-*` 的 `meta` 子路径只随包发了 .js（decoder 主入口才有 .d.ts）。
 * 这里声明我们用到的那一面：认容器只需要一个采样率。多出来的字段不声明，免得凭想象写类型。
 */
declare module "@audio/*/meta" {
  export function parseMeta(bytes: Uint8Array): { sampleRate?: number } | null;
}

declare module "@audio/decode-mp3/meta" {
  /** `size` 是 ID3v2 标签的结束偏移（也就是第一帧的起点）。 */
  export function parseId3v2(bytes: Uint8Array): { size: number } | null;
}

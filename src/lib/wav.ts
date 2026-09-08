import type { Bytes, Samples } from "./arrays";

export function wavFile(pcm: Samples, sr: number): Bytes {
  const count = pcm.length;
  const body = count * 2;
  const buf = new ArrayBuffer(44 + body);
  const view = new DataView(buf);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, 36 + body, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, body, true);

  for (let i = 0; i < count; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }

  return new Uint8Array(buf);
}

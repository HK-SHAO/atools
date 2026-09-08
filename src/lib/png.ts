import type { Bytes } from "./arrays";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const KEYWORD = "spectrum";

let crcCache: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (crcCache) return crcCache;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcCache = t;
  return t;
}

function crc32(bytes: Uint8Array, from: number, to: number): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const latin1 = (s: string): Bytes => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
const ascii = (b: Uint8Array): string => String.fromCharCode(...b);

export const isPng = (b: Uint8Array): boolean => SIGNATURE.every((v, i) => b[i] === v);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Inserts a tEXt chunk right after IHDR so the parameters travel with the file. */
export function withMeta(png: Uint8Array, meta: string): Bytes {
  const key = latin1(KEYWORD);
  const body = latin1(meta);
  const payload = new Uint8Array(key.length + 1 + body.length);
  payload.set(key, 0);
  payload.set(body, key.length + 1);

  const at = 8 + 12 + new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(8);
  const out = new Uint8Array(png.length + payload.length + 12);
  out.set(png.subarray(0, at), 0);
  out.set(chunk("tEXt", payload), at);
  out.set(png.subarray(at), at + payload.length + 12);
  return out;
}

export function readMeta(png: Uint8Array): string | null {
  if (!isPng(png)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    if (at + 12 + len > png.length) return null;
    const type = ascii(png.subarray(at + 4, at + 8));
    if (type === "tEXt") {
      const start = at + 8;
      let split = start;
      while (split < start + len && png[split] !== 0) split++;
      if (ascii(png.subarray(start, split)) === KEYWORD)
        return ascii(png.subarray(Math.min(split + 1, start + len), start + len));
    }
    if (type === "IEND") return null;
    at += 12 + len;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 索引色 PNG —— 紧凑频谱图走这条：调色板就是暖色 ramp，
 * 位深几 bit 图里就只有 2^bits 种颜色，PNG 因此压得非常小。
 * ------------------------------------------------------------------ */

function adler32(b: Uint8Array): number {
  let a = 1;
  let c = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]!) % 65521;
    c = (c + a) % 65521;
  }
  return (((c << 16) | a) >>> 0) as number;
}

/** 没有 CompressionStream 时的退路：只写 stored 块，图还是合规的，只是大些。 */
function stored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  for (let at = 0; at < data.length; at += 65535) {
    const len = Math.min(65535, data.length - at);
    const head = new Uint8Array(5);
    head[0] = at + len >= data.length ? 1 : 0;
    head[1] = len & 0xff;
    head[2] = (len >>> 8) & 0xff;
    head[3] = ~len & 0xff;
    head[4] = (~len >>> 8) & 0xff;
    parts.push(head, data.subarray(at, at + len));
  }
  const sum = adler32(data);
  parts.push(
    Uint8Array.from([(sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff]),
  );

  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Ctor) return stored(data);
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new Ctor("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 索引色 PNG。depth ∈ {1,2,4,8}，palette 长度 = 2^depth × 3。
 * 每行前面加一个 filter 字节（0 = None），其余按位打包。
 */
export async function indexedPng(
  indices: Uint8Array,
  width: number,
  height: number,
  depth: number,
  palette: Uint8Array,
  meta: string,
): Promise<Bytes> {
  const rowBytes = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  const raw = new Uint8Array((rowBytes + 1) * height);

  for (let y = 0; y < height; y++) {
    let at = y * (rowBytes + 1) + 1;
    // 位深不一定整除 8（比如 6 bit），所以按"攒够一个字节就吐一个"来打包。
    let acc = 0;
    let bits = 0;
    for (let x = 0; x < width; x++) {
      acc = (acc << depth) | (indices[y * width + x]! & mask);
      bits += depth;
      while (bits >= 8) {
        bits -= 8;
        raw[at++] = (acc >>> bits) & 0xff;
      }
    }
    if (bits > 0) raw[at++] = (acc << (8 - bits)) & 0xff;
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = 3;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const key = latin1(KEYWORD);
  const body = latin1(meta);
  const text = new Uint8Array(key.length + 1 + body.length);
  text.set(key, 0);
  text.set(body, key.length + 1);

  const deflated = await zlib(raw);
  const pieces = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("PLTE", palette),
    chunk("tEXt", text),
    chunk("IDAT", deflated),
    chunk("IEND", new Uint8Array(0)),
  ];

  let size = 0;
  for (const p of pieces) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

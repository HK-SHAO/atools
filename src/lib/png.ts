import type { Bytes } from "./arrays";
import { RAMP } from "./palette";

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

const textPayload = (meta: string): Uint8Array => {
  const key = latin1(KEYWORD);
  const body = latin1(meta);
  const out = new Uint8Array(key.length + 1 + body.length);
  out.set(key, 0);
  out.set(body, key.length + 1);
  return out;
};

function ihdr(width: number, height: number, depth: number, colorType: number): Uint8Array {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  out[8] = depth;
  out[9] = colorType;
  return out;
}

function assemble(pieces: Uint8Array[]): Bytes {
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

export const isPng = (b: Uint8Array): boolean => SIGNATURE.every((v, i) => b[i] === v);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

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

function adler32(b: Uint8Array): number {
  let a = 1;
  let c = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]!) % 65521;
    c = (c + a) % 65521;
  }
  return (((c << 16) | a) >>> 0) as number;
}

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

  const deflated = await zlib(raw);
  return assemble([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr(width, height, depth, 3)),
    chunk("PLTE", palette),
    chunk("tEXt", textPayload(meta)),
    chunk("IDAT", deflated),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export async function gray16Png(
  data: Uint16Array,
  width: number,
  height: number,
  meta: string,
): Promise<Bytes> {
  const raw = new Uint8Array((width * 2 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 2 + 1);
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x]!;
      raw[row + 1 + x * 2] = (v >>> 8) & 0xff;
      raw[row + 2 + x * 2] = v & 0xff;
    }
  }

  const deflated = await zlib(raw);
  return assemble([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr(width, height, 16, 0)),
    chunk("tEXt", textPayload(meta)),
    chunk("IDAT", deflated),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export interface Gray16 {
  width: number;
  height: number;
  data: Uint16Array;
}

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  plte: Uint8Array | null;
  idat: Uint8Array[];
}

function parsePng(bytes: Uint8Array): PngInfo | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let info: PngInfo | null = null;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) return null;
    const type = ascii(bytes.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      info = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        bitDepth: bytes[at + 16]!,
        colorType: bytes[at + 17]!,
        interlace: bytes[at + 20]!,
        plte: null,
        idat: [],
      };
    } else if (type === "PLTE" && info) {
      info.plte = bytes.subarray(at + 8, at + 8 + len);
    } else if (type === "IDAT" && info) {
      info.idat.push(bytes.subarray(at + 8, at + 8 + len));
    } else if (type === "IEND") {
      break;
    }
    at += 12 + len;
  }
  return info;
}

async function inflate(idat: Uint8Array[]): Promise<Uint8Array | null> {
  let total = 0;
  for (const c of idat) total += c.length;
  if (total === 0) return null;
  const concat = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    concat.set(c, o);
    o += c.length;
  }
  const stream = new Blob([concat as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = y > 0 ? out[dst + i - stride]! : 0;
      const c = y > 0 && i >= bpp ? out[dst + i - bpp - stride]! : 0;
      let v: number;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else {
        const p = (a + b - c) | 0;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

export async function readGray16(bytes: Uint8Array): Promise<Gray16 | null> {
  const info = parsePng(bytes);
  if (!info || info.colorType !== 0 || info.bitDepth !== 16 || info.interlace !== 0) return null;
  const raw = await inflate(info.idat);
  if (!raw) return null;
  const flat = unfilter(raw, info.width, info.height, 2);
  if (!flat) return null;
  const { width, height } = info;
  const data = new Uint16Array(width * height);
  for (let i = 0; i < width * height; i++)
    data[i] = ((flat[i * 2]! << 8) | flat[i * 2 + 1]!) >>> 0;
  return { width, height, data };
}

export interface IndexedRamp {
  width: number;
  height: number;
  levels: Uint8Array;
}

export async function readIndexedRamp(bytes: Uint8Array): Promise<IndexedRamp | null> {
  const info = parsePng(bytes);
  if (!info || info.colorType !== 3 || info.interlace !== 0) return null;
  if (![1, 2, 4, 8].includes(info.bitDepth)) return null;
  const plte = info.plte;
  if (!plte || plte.length % 3 !== 0) return null;
  const count = plte.length / 3;
  if (count > 1 << info.bitDepth) return null;
  const steps = count - 1;
  if (steps < 1) return null;
  for (let q = 0; q < count; q++) {
    const level = Math.round((Math.min(q, steps) * 255) / steps);
    if (plte[q * 3] !== RAMP[level * 3]) return null;
    if (plte[q * 3 + 1] !== level) return null;
    if (plte[q * 3 + 2] !== RAMP[level * 3 + 2]) return null;
  }
  const raw = await inflate(info.idat);
  if (!raw) return null;
  const flat = unfilter(raw, info.width, info.height, 1);
  if (!flat) return null;

  const { width, height } = info;
  const depth = info.bitDepth;
  const levels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowAt = y * Math.ceil((width * depth) / 8);
    let acc = 0;
    let bits = 0;
    let k = 0;
    for (let x = 0; x < width; x++) {
      while (bits < depth) {
        acc = (acc << 8) | flat[rowAt + k++]!;
        bits += 8;
      }
      const idx = (acc >>> (bits - depth)) & ((1 << depth) - 1);
      bits -= depth;
      acc &= (1 << bits) - 1;
      levels[y * width + x] = Math.min(255, Math.round((Math.min(idx, steps) * 255) / steps));
    }
  }
  return { width, height, levels };
}

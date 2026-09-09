// src/lib/audio.ts
function sniffAudio(b) {
  const ascii = (at, len) => String.fromCharCode(...b.subarray(at, at + len));
  if (b.length > 12) {
    const brand = ascii(8, 4);
    if (brand.startsWith("3gp"))
      return "3GP（手机通话录音常用）";
    if (ascii(4, 4) === "ftyp")
      return "M4A/MP4";
  }
  if (ascii(0, 5) === "#!AMR")
    return "AMR（微信等语音常用）";
  if (ascii(1, 9) === "#!SILK_V3" || ascii(0, 9) === "#!SILK_V3")
    return "SILK（微信语音专有）";
  if (ascii(0, 4) === "OggS")
    return "OGG";
  if (ascii(0, 4) === "fLaC")
    return "FLAC";
  if (ascii(0, 4) === "RIFF")
    return "WAV";
  if (ascii(0, 3) === "ID3" || b[0] === 255 && (b[1] & 224) === 224)
    return "MP3";
  return "";
}
var DECODE_HELP = "支持 m4a、mp3、wav、ogg、flac。若来自微信或通话录音，请先用录音 App 另存为这些格式";
function decodeRaw(ctx, data) {
  return new Promise((ok, no) => {
    ctx.decodeAudioData(data, ok, (err) => no(err instanceof Error ? err : new Error(String(err ?? "解码失败"))));
  });
}
async function decodeAudioFile(data) {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor)
    throw new Error("这个浏览器不支持 Web Audio");
  const head = sniffAudio(new Uint8Array(data));
  const ctx = new Ctor;
  let buffer;
  try {
    buffer = await decodeRaw(ctx, data.slice(0));
  } catch {
    if (head.startsWith("AMR") || head.startsWith("SILK") || head.startsWith("3GP"))
      throw new Error(`解不出：这是${head}，浏览器不带这个解码器。${DECODE_HELP}`);
    throw new Error(`解不出这段音频${head ? `（识别为 ${head}）` : ""}。${DECODE_HELP}`);
  } finally {
    ctx.close();
  }
  const tracks = buffer.numberOfChannels;
  const n = buffer.length;
  if (n === 0)
    throw new Error("这段音频是空的");
  const pcm = new Float32Array(n);
  if (tracks === 1) {
    pcm.set(buffer.getChannelData(0));
  } else {
    for (let c = 0;c < tracks; c++) {
      const src = buffer.getChannelData(c);
      for (let i = 0;i < n; i++)
        pcm[i] = pcm[i] + src[i];
    }
    for (let i = 0;i < n; i++)
      pcm[i] = pcm[i] / tracks;
  }
  return { pcm, sr: buffer.sampleRate };
}

// src/lib/fft.ts
class FFT {
  size;
  rev;
  cosTable;
  sinTable;
  constructor(size) {
    if (size < 2 || (size & size - 1) !== 0)
      throw new Error("FFT size must be a power of two");
    this.size = size;
    const levels = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0;i < size; i++) {
      let r = 0;
      for (let b = 0;b < levels; b++)
        if (i & 1 << b)
          r |= 1 << levels - 1 - b;
      this.rev[i] = r;
    }
    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0;i < half; i++) {
      this.cosTable[i] = Math.cos(2 * Math.PI * i / size);
      this.sinTable[i] = Math.sin(2 * Math.PI * i / size);
    }
  }
  transform(re, im, inverse = false) {
    const { size: n, rev, cosTable: cos, sinTable: sin } = this;
    for (let i = 0;i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = re[i];
        re[i] = re[j];
        re[j] = a;
        const b = im[i];
        im[i] = im[j];
        im[j] = b;
      }
    }
    for (let width = 2;width <= n; width *= 2) {
      const half = width / 2;
      const step = n / width;
      for (let base = 0;base < n; base += width) {
        for (let j = base, k = 0;j < base + half; j++, k += step) {
          const p = j + half;
          const c = cos[k];
          const s = inverse ? -sin[k] : sin[k];
          const tre = re[p] * c + im[p] * s;
          const tim = -re[p] * s + im[p] * c;
          re[p] = re[j] - tre;
          im[p] = im[j] - tim;
          re[j] = re[j] + tre;
          im[j] = im[j] + tim;
        }
      }
    }
    if (inverse)
      for (let i = 0;i < n; i++) {
        re[i] = re[i] / n;
        im[i] = im[i] / n;
      }
  }
}
function hannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0;i < size; i++)
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  return w;
}
function mirrorSpectrum(re, im, bins, size) {
  im[0] = 0;
  im[bins - 1] = 0;
  for (let b = 1;b < bins - 1; b++) {
    re[size - b] = re[b];
    im[size - b] = -im[b];
  }
}

// src/lib/palette.ts
var STOPS = [
  [0, 0, 0],
  [24, 34, 6],
  [64, 110, 22],
  [112, 190, 52],
  [168, 232, 120],
  [216, 250, 190],
  [255, 255, 255]
];
var RAMP = new Uint8Array(256 * 3);
var FROM_LUMA = new Uint8Array(256);
function build() {
  for (let level = 0;level < 256; level++) {
    let k = 0;
    while (k < STOPS.length - 2 && level > STOPS[k + 1][0])
      k++;
    const a = STOPS[k];
    const b = STOPS[k + 1];
    const f = (level - a[0]) / (b[0] - a[0]);
    RAMP[level * 3] = Math.round(a[1] + (b[1] - a[1]) * f);
    RAMP[level * 3 + 1] = level;
    RAMP[level * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
  }
  let level = 0;
  for (let y = 0;y < 256; y++) {
    while (level < 255 && luma(RAMP[(level + 1) * 3], RAMP[(level + 1) * 3 + 1], RAMP[(level + 1) * 3 + 2]) <= y)
      level++;
    FROM_LUMA[y] = level;
  }
}
function luma(r, g, b) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}
build();

// src/lib/png.ts
var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var KEYWORD = "spectrum";
var crcCache = null;
function crcTable() {
  if (crcCache)
    return crcCache;
  const t = new Uint32Array(256);
  for (let n = 0;n < 256; n++) {
    let c = n;
    for (let k = 0;k < 8; k++)
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  crcCache = t;
  return t;
}
function crc32(bytes, from, to) {
  const t = crcTable();
  let c = 4294967295;
  for (let i = from;i < to; i++)
    c = t[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
var latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
var ascii = (b) => String.fromCharCode(...b);
var textPayload = (meta) => {
  const key = latin1(KEYWORD);
  const body = latin1(meta);
  const out = new Uint8Array(key.length + 1 + body.length);
  out.set(key, 0);
  out.set(body, key.length + 1);
  return out;
};
function ihdr(width, height, depth, colorType) {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  out[8] = depth;
  out[9] = colorType;
  return out;
}
function assemble(pieces) {
  let size = 0;
  for (const p of pieces)
    size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
var isPng = (b) => SIGNATURE.every((v, i) => b[i] === v);
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function withMeta(png, meta) {
  const payload = textPayload(meta);
  const at = 8 + 12 + new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(8);
  const out = new Uint8Array(png.length + payload.length + 12);
  out.set(png.subarray(0, at), 0);
  out.set(chunk("tEXt", payload), at);
  out.set(png.subarray(at), at + payload.length + 12);
  return out;
}
function readMeta(png) {
  if (!isPng(png))
    return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    if (at + 12 + len > png.length)
      return null;
    const type = ascii(png.subarray(at + 4, at + 8));
    if (type === "tEXt") {
      const start = at + 8;
      let split = start;
      while (split < start + len && png[split] !== 0)
        split++;
      if (ascii(png.subarray(start, split)) === KEYWORD)
        return ascii(png.subarray(Math.min(split + 1, start + len), start + len));
    }
    if (type === "IEND")
      return null;
    at += 12 + len;
  }
  return null;
}
function adler32(b) {
  let a = 1;
  let c = 0;
  for (let i = 0;i < b.length; i++) {
    a = (a + b[i]) % 65521;
    c = (c + a) % 65521;
  }
  return (c << 16 | a) >>> 0;
}
function stored(data) {
  const parts = [Uint8Array.from([120, 1])];
  for (let at = 0;at < data.length; at += 65535) {
    const len = Math.min(65535, data.length - at);
    const head = new Uint8Array(5);
    head[0] = at + len >= data.length ? 1 : 0;
    head[1] = len & 255;
    head[2] = len >>> 8 & 255;
    head[3] = ~len & 255;
    head[4] = ~len >>> 8 & 255;
    parts.push(head, data.subarray(at, at + len));
  }
  const sum = adler32(data);
  parts.push(Uint8Array.from([sum >>> 24 & 255, sum >>> 16 & 255, sum >>> 8 & 255, sum & 255]));
  let size = 0;
  for (const p of parts)
    size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
async function zlib(data) {
  const Ctor = globalThis.CompressionStream;
  if (!Ctor)
    return stored(data);
  const stream = new Blob([data]).stream().pipeThrough(new Ctor("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function indexedPng(indices, width, height, depth, palette, meta) {
  const rowBytes = Math.ceil(width * depth / 8);
  const mask = (1 << depth) - 1;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0;y < height; y++) {
    let at = y * (rowBytes + 1) + 1;
    let acc = 0;
    let bits = 0;
    for (let x = 0;x < width; x++) {
      acc = acc << depth | indices[y * width + x] & mask;
      bits += depth;
      while (bits >= 8) {
        bits -= 8;
        raw[at++] = acc >>> bits & 255;
      }
    }
    if (bits > 0)
      raw[at++] = acc << 8 - bits & 255;
  }
  const deflated = await zlib(raw);
  return assemble([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr(width, height, depth, 3)),
    chunk("PLTE", palette),
    chunk("tEXt", textPayload(meta)),
    chunk("IDAT", deflated),
    chunk("IEND", new Uint8Array(0))
  ]);
}
function parsePng(bytes) {
  if (!isPng(bytes))
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let info = null;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length)
      return null;
    const type = ascii(bytes.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      info = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        bitDepth: bytes[at + 16],
        colorType: bytes[at + 17],
        interlace: bytes[at + 20],
        plte: null,
        idat: []
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
async function inflate(idat) {
  let total = 0;
  for (const c of idat)
    total += c.length;
  if (total === 0)
    return null;
  const concat = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    concat.set(c, o);
    o += c.length;
  }
  const stream = new Blob([concat]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length < height * (stride + 1))
    return null;
  const out = new Uint8Array(height * stride);
  for (let y = 0;y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0;i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[dst + i - stride] : 0;
      const c = y > 0 && i >= bpp ? out[dst + i - bpp - stride] : 0;
      let v;
      if (ft === 0)
        v = x;
      else if (ft === 1)
        v = x + a;
      else if (ft === 2)
        v = x + b;
      else if (ft === 3)
        v = x + (a + b >> 1);
      else {
        const p = a + b - c | 0;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}
async function readIndexedRamp(bytes) {
  const info = parsePng(bytes);
  if (!info || info.colorType !== 3 || info.interlace !== 0)
    return null;
  if (![1, 2, 4, 8].includes(info.bitDepth))
    return null;
  const plte = info.plte;
  if (!plte || plte.length % 3 !== 0)
    return null;
  const count = plte.length / 3;
  if (count > 1 << info.bitDepth)
    return null;
  const steps = count - 1;
  if (steps < 1)
    return null;
  for (let q = 0;q < count; q++) {
    const level = Math.round(Math.min(q, steps) * 255 / steps);
    if (plte[q * 3] !== RAMP[level * 3])
      return null;
    if (plte[q * 3 + 1] !== level)
      return null;
    if (plte[q * 3 + 2] !== RAMP[level * 3 + 2])
      return null;
  }
  const raw = await inflate(info.idat);
  if (!raw)
    return null;
  const flat = unfilter(raw, info.width, info.height, 1);
  if (!flat)
    return null;
  const { width, height } = info;
  const depth = info.bitDepth;
  const levels = new Uint8Array(width * height);
  for (let y = 0;y < height; y++) {
    const rowAt = y * Math.ceil(width * depth / 8);
    let acc = 0;
    let bits = 0;
    let k = 0;
    for (let x = 0;x < width; x++) {
      while (bits < depth) {
        acc = acc << 8 | flat[rowAt + k++];
        bits += 8;
      }
      const idx = acc >>> bits - depth & (1 << depth) - 1;
      bits -= depth;
      acc &= (1 << bits) - 1;
      levels[y * width + x] = Math.min(255, Math.round(Math.min(idx, steps) * 255 / steps));
    }
  }
  return { width, height, levels };
}

// src/lib/params.ts
var FINENESS = [
  { label: "省", win: 256, div: 2 },
  { label: "中", win: 512, div: 2 },
  { label: "细", win: 1024, div: 4 }
];
var VOICE = {
  mode: "compact",
  sr: 8000,
  bits: 8,
  fineness: 1,
  fmax: 0,
  start: 0,
  end: 0
};
var winOf = (e) => FINENESS[e.fineness].win;
var hopOf = (e) => {
  const f = FINENESS[e.fineness];
  return f.win / f.div;
};
var dbSpanOf = (bits) => 12 * Math.max(1, bits);
var stepsOf = (bits) => (1 << Math.max(1, bits)) - 1;

// src/lib/phase.ts
var TUNE = {
  pghi: true,
  iters: 32,
  momentum: 0.5,
  gamma: 0.25645,
  tol: [0.1, 0.0000000001],
  rtisi: true,
  rtisiIters: 8,
  rtisiGl: 0,
  fine: {
    rtisiIters: 16,
    rtisiBudget: 200000000,
    glIters: 8,
    glBudgetMs: 12000
  }
};
var TWO_PI = Math.PI * 2;
var wrap = (a) => {
  let v = (a + Math.PI) % TWO_PI;
  if (v < 0)
    v += TWO_PI;
  return v - Math.PI;
};
function orderByLevel(mag, top, n) {
  const B = 256;
  const counts = new Uint32Array(B);
  const keys = new Uint8Array(n);
  for (let i = 0;i < n; i++) {
    const k = Math.min(B - 1, mag[i] / top * B) | 0;
    keys[i] = k;
    counts[k] = counts[k] + 1;
  }
  const start = new Uint32Array(B + 1);
  for (let b = B - 1;b >= 0; b--)
    start[b] = start[b + 1] + counts[b];
  const order = new Uint32Array(n);
  const at = new Uint32Array(B);
  for (let b = 0;b < B; b++)
    at[b] = start[b + 1];
  for (let i = 0;i < n; i++)
    order[at[keys[i]]++] = i;
  return order;
}

class Heap {
  idx;
  key;
  size = 0;
  constructor(cap = 1024) {
    this.idx = new Uint32Array(cap);
    this.key = new Float64Array(cap);
  }
  grow() {
    const idx = new Uint32Array(this.idx.length * 2);
    idx.set(this.idx);
    const key = new Float64Array(this.key.length * 2);
    key.set(this.key);
    this.idx = idx;
    this.key = key;
  }
  push(value, key) {
    if (this.size === this.idx.length)
      this.grow();
    let c = this.size++;
    while (c > 0) {
      const p = c - 1 >> 1;
      if (this.key[p] >= key)
        break;
      this.idx[c] = this.idx[p];
      this.key[c] = this.key[p];
      c = p;
    }
    this.idx[c] = value;
    this.key[c] = key;
  }
  pop() {
    const top = this.idx[0];
    const last = --this.size;
    if (last > 0) {
      const value = this.idx[last];
      const key = this.key[last];
      let c = 0;
      for (;; ) {
        let ch = 2 * c + 1;
        if (ch >= last)
          break;
        if (ch + 1 < last && this.key[ch + 1] > this.key[ch])
          ch++;
        if (this.key[ch] <= key)
          break;
        this.idx[c] = this.idx[ch];
        this.key[c] = this.key[ch];
        c = ch;
      }
      this.idx[c] = value;
      this.key[c] = key;
    }
    return top;
  }
}
function phaseFromMagnitude(mag, frames, bins, win, hop) {
  const n = frames * bins;
  const phase = new Float64Array(n);
  let top = 0;
  for (let i = 0;i < n; i++)
    if (mag[i] > top)
      top = mag[i];
  if (top <= 0 || frames < 2 || bins < 2)
    return phase;
  const floor = top * 0.000000000001;
  const slog = new Float64Array(n);
  for (let i = 0;i < n; i++)
    slog[i] = Math.log(Math.max(mag[i], floor));
  const gamma = TUNE.gamma * win * win;
  const cF = gamma / (hop * win);
  const cT = hop * win / gamma;
  const fgrad = new Float32Array(n);
  const tgrad = new Float32Array(n);
  for (let f = 0;f < frames; f++) {
    const base = f * bins;
    const up = (f > 0 ? f - 1 : 0) * bins;
    const dn = (f < frames - 1 ? f + 1 : frames - 1) * bins;
    const dt = f > 0 && f < frames - 1 ? 2 : 1;
    for (let b = 0;b < bins; b++) {
      fgrad[base + b] = -cF * (slog[dn + b] - slog[up + b]) / dt - Math.PI;
    }
  }
  for (let f = 0;f < frames; f++) {
    const base = f * bins;
    for (let b = 0;b < bins; b++) {
      const lo = b > 0 ? b - 1 : 0;
      const hi = b < bins - 1 ? b + 1 : bins - 1;
      const db = b > 0 && b < bins - 1 ? 2 : 1;
      tgrad[base + b] = cT * (slog[base + hi] - slog[base + lo]) / db + TWO_PI * hop * b / win;
    }
  }
  slog.fill(0);
  const done = new Uint8Array(n);
  const queued = new Uint8Array(n);
  const order = orderByLevel(mag, top, n);
  const heap = new Heap;
  const drain = (limit) => {
    while (heap.size > 0) {
      const i = heap.pop();
      if (done[i])
        continue;
      const f = i / bins | 0;
      const b = i - f * bins;
      let best = -1;
      let bestMag = -1;
      if (b > 0 && done[i - 1] && mag[i - 1] > bestMag) {
        best = i - 1;
        bestMag = mag[i - 1];
      }
      if (b < bins - 1 && done[i + 1] && mag[i + 1] > bestMag) {
        best = i + 1;
        bestMag = mag[i + 1];
      }
      if (f > 0 && done[i - bins] && mag[i - bins] > bestMag) {
        best = i - bins;
        bestMag = mag[i - bins];
      }
      if (f < frames - 1 && done[i + bins] && mag[i + bins] > bestMag) {
        best = i + bins;
        bestMag = mag[i + bins];
      }
      if (best < 0) {
        phase[i] = 0;
      } else if (best === i - 1) {
        phase[i] = wrap(phase[best] + 0.5 * (fgrad[best] + fgrad[i]));
      } else if (best === i + 1) {
        phase[i] = wrap(phase[best] - 0.5 * (fgrad[best] + fgrad[i]));
      } else if (best === i - bins) {
        phase[i] = wrap(phase[best] + 0.5 * (tgrad[best] + tgrad[i]));
      } else {
        phase[i] = wrap(phase[best] - 0.5 * (tgrad[best] + tgrad[i]));
      }
      done[i] = 1;
      if (b > 0)
        offer(i - 1, limit);
      if (b < bins - 1)
        offer(i + 1, limit);
      if (f > 0)
        offer(i - bins, limit);
      if (f < frames - 1)
        offer(i + bins, limit);
    }
  };
  function offer(j, limit) {
    if (done[j] || queued[j] || mag[j] <= limit)
      return;
    queued[j] = 1;
    heap.push(j, mag[j]);
  }
  for (const limit of [top * TUNE.tol[0], top * TUNE.tol[1]]) {
    for (let k = 0;k < n; k++) {
      const i = order[k];
      if (done[i] || mag[i] <= limit)
        continue;
      queued[i] = 1;
      heap.push(i, mag[i]);
      drain(limit);
    }
  }
  let seed = 2654435769;
  for (let i = 0;i < n; i++) {
    if (done[i])
      continue;
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    phase[i] = (seed >>> 0) / 4294967295 * TWO_PI - Math.PI;
  }
  return phase;
}

// src/lib/rtisi.ts
var DEFAULT_BUDGET = 50000000;
async function rtisiLa(mag, frames, bins, win, hop, samples, opts = {}) {
  const L = win;
  const a = Math.max(1, Math.round(hop));
  const R = Math.max(1, Math.round(L / a));
  let K = Math.max(0, Math.min(frames - 1, opts.lookahead ?? R - 1));
  let iters = Math.max(1, opts.iters ?? 8);
  const warm = opts.warm ?? null;
  const fromPast = opts.fromPast !== false;
  const tick = opts.tick;
  const unit = frames * L * Math.max(1, Math.log2(L));
  const budget = opts.budget ?? DEFAULT_BUDGET;
  while (K > 1 && unit * (K + 1) * iters > budget)
    K--;
  while (iters > 1 && unit * (K + 1) * iters > budget)
    iters--;
  const fft = new FFT(L);
  const w = hannWindow(L);
  const full = L / 2 + 1;
  const padded = samples + L;
  const span = K * a + L;
  const out = new Float64Array(padded);
  const local = new Float64Array(span);
  const re = new Float64Array(L);
  const im = new Float64Array(L);
  const ph = new Float64Array((K + 1) * bins);
  const prev = new Float64Array((K + 1) * bins);
  const load = (at) => {
    local.fill(0);
    const avail = Math.min(span, padded - at);
    if (avail > 0)
      local.set(out.subarray(at, at + avail));
  };
  const lay = (f, k) => {
    const base = f * bins;
    for (let b = 0;b < full; b++) {
      if (b < bins) {
        const g = mag[base + b];
        const p = ph[k * bins + b];
        re[b] = g * Math.cos(p);
        im[b] = g * Math.sin(p);
      } else {
        re[b] = 0;
        im[b] = 0;
      }
    }
    mirrorSpectrum(re, im, full, L);
    fft.transform(re, im, true);
    const at = k * a;
    for (let n = 0;n < L; n++)
      local[at + n] = local[at + n] + re[n] * w[n];
  };
  const read = (k) => {
    const at = k * a;
    for (let n = 0;n < L; n++) {
      re[n] = local[at + n] * w[n];
      im[n] = 0;
    }
    fft.transform(re, im);
    for (let b = 0;b < bins; b++)
      ph[k * bins + b] = Math.atan2(im[b], re[b]);
  };
  for (let m = 0;m < frames; m++) {
    const act = Math.min(K + 1, frames - m);
    const at = m * a;
    load(at);
    if (m === 0) {
      for (let k = 0;k < act; k++) {
        if (warm)
          ph.set(warm.subarray(k * bins, (k + 1) * bins), k * bins);
        else
          read(k);
      }
    } else {
      for (let k = 0;k < act; k++) {
        if (k <= K - 1)
          ph.set(prev.subarray((k + 1) * bins, (k + 2) * bins), k * bins);
        else if (warm)
          ph.set(warm.subarray((m + k) * bins, (m + k + 1) * bins), k * bins);
        else
          ph.fill(0, k * bins, (k + 1) * bins);
      }
      if (fromPast)
        read(0);
    }
    for (let it = 0;it < iters; it++) {
      load(at);
      for (let k = 0;k < act; k++)
        lay(m + k, k);
      for (let k = 0;k < act; k++)
        read(k);
    }
    const base = m * bins;
    for (let b = 0;b < full; b++) {
      if (b < bins) {
        const g = mag[base + b];
        const p = ph[b];
        re[b] = g * Math.cos(p);
        im[b] = g * Math.sin(p);
      } else {
        re[b] = 0;
        im[b] = 0;
      }
    }
    mirrorSpectrum(re, im, full, L);
    fft.transform(re, im, true);
    const room = Math.min(L, padded - at);
    for (let n = 0;n < room; n++)
      out[at + n] = out[at + n] + re[n] * w[n];
    prev.set(ph);
    if (tick)
      await tick(m + 1, frames);
  }
  const cover = new Float64Array(padded);
  for (let f = 0;f < frames; f++)
    for (let n = 0;n < L; n++)
      cover[f * a + n] = cover[f * a + n] + w[n] * w[n];
  let top = 0;
  for (let i = 0;i < padded; i++)
    if (cover[i] > top)
      top = cover[i];
  const floor = top * 0.05;
  const y = new Float64Array(samples);
  for (let i = 0;i < samples; i++) {
    const c = cover[L / 2 + i];
    y[i] = c > floor ? out[L / 2 + i] / c : 0;
  }
  return y;
}

// src/lib/spectrum.ts
var BANDS = 2;
var MIN_WIN = 256;
var MAX_WIN = 4096;
var MAX_FRAMES = 20000;
var MAX_PIXELS = 8000000;
var DEFAULT_SR = 44100;
var DB_MIN = -120;
var DB_MAX = 0;
var DB_SPAN = DB_MAX - DB_MIN;
var SYNTH_TUNE = { phaseDeadZone: 0.1 };
var SLICE_MS = 12;
var GL_BUDGET_MS = 2600;
var GL_MIN_ITERS = 8;

class Aborted extends Error {
  constructor() {
    super("aborted");
    this.name = "Aborted";
  }
}
var yieldToUi = () => new Promise((done) => setTimeout(done, 0));
var pow2 = (n) => {
  let v = MIN_WIN;
  while (v < n && v < MAX_WIN)
    v *= 2;
  return v;
};
function rowsFor(win, sr, fmax) {
  const full = win / 2 + 1;
  if (fmax <= 0)
    return full;
  const perBin = sr / win;
  return Math.max(8, Math.min(full, Math.floor(fmax / perBin) + 1));
}
function shapeFor(enc, sr, samples) {
  const win = winOf(enc);
  const hop = hopOf(enc);
  const bins = rowsFor(win, sr, enc.mode === "compact" ? enc.fmax : 0);
  const frames = Math.floor(Math.max(1, samples) / hop) + 1;
  const bands = enc.mode === "exact" ? BANDS : 1;
  if (frames > MAX_FRAMES)
    throw new Error("音频太长，图放不下：剪短一点，或调低采样率");
  if (frames * bins * bands > MAX_PIXELS)
    throw new Error("图太大了：把「窗长」或「采样率」调低一些");
  return { win, hop, frames, bins, samples };
}
class Frames {
  size;
  bins;
  re;
  im;
  fft;
  win;
  constructor(size) {
    this.size = size;
    this.fft = new FFT(size);
    this.win = hannWindow(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.bins = size / 2 + 1;
  }
  analyse(x, start) {
    const { re, im, win, size } = this;
    for (let m = 0;m < size; m++) {
      re[m] = x[start + m] * win[m];
      im[m] = 0;
    }
    this.fft.transform(re, im);
  }
  add(acc, start) {
    const { re, im, win, size } = this;
    mirrorSpectrum(re, im, this.bins, size);
    this.fft.transform(re, im, true);
    for (let m = 0;m < size; m++)
      acc[start + m] = acc[start + m] + re[m] * win[m];
  }
}
var clampByte = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
var magToLevel = (db) => clampByte(Math.round((db - DB_MIN) / DB_SPAN * 255));
var levelToMagDb = (level) => DB_MIN + level / 255 * DB_SPAN;
function levelToDb(level, meta) {
  if (meta.exact)
    return levelToMagDb(level);
  const bits = Math.max(1, meta.bits);
  const steps = stepsOf(bits);
  const q = Math.round(level * steps / 255);
  return meta.ref - dbSpanOf(bits) + q / steps * dbSpanOf(bits);
}
function quantize(mag, scale, floorDb, span, steps) {
  if (mag <= 0)
    return 0;
  const db = 20 * Math.log10(mag / scale);
  const q = Math.round((db - floorDb) / span * steps);
  if (q <= 0)
    return 0;
  if (q >= steps)
    return 255;
  return Math.round(q * 255 / steps);
}
async function encode(pcm, sr, enc, alive, onProgress) {
  const { win, hop, frames, bins, samples } = shapeFor(enc, sr, pcm.length);
  const core = new Frames(win);
  const full = core.bins;
  const padded = samples + win;
  const x = new Float64Array(padded);
  for (let i = 0;i < samples; i++)
    x[win / 2 + i] = pcm[i];
  const meta = { sr, win, hop, frames, bins, samples, bits: 0, ref: 0, exact: false };
  const scale = win / 4;
  let next = 0;
  if (enc.mode === "exact") {
    meta.exact = true;
    const levels = new Uint8Array(frames * bins);
    const phaseCos = new Uint8Array(frames * bins);
    const phaseSin = new Uint8Array(frames * bins);
    for (let f = 0;f < frames; f++) {
      core.analyse(x, f * hop);
      const base = f * bins;
      for (let b = 0;b < bins; b++) {
        const re = core.re[b];
        const im = core.im[b];
        const db = 20 * Math.log10(Math.sqrt(re * re + im * im) / scale);
        levels[base + b] = magToLevel(db);
        const a = Math.atan2(im, re);
        phaseCos[base + b] = clampByte(Math.round((Math.cos(a) * 0.5 + 0.5) * 255));
        phaseSin[base + b] = clampByte(Math.round((Math.sin(a) * 0.5 + 0.5) * 255));
      }
      if (Date.now() >= next) {
        if (alive && !alive())
          throw new Aborted;
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      }
    }
    return { meta, levels, phaseCos, phaseSin };
  }
  const bits = Math.max(1, enc.bits);
  const span = dbSpanOf(bits);
  const steps = stepsOf(bits);
  meta.bits = bits;
  let peak = 0;
  const stride = Math.max(1, Math.floor(frames / 240));
  for (let f = 0;f < frames; f += stride) {
    core.analyse(x, f * hop);
    for (let b = 0;b < bins; b++) {
      const re = core.re[b];
      const im = core.im[b];
      const m = Math.sqrt(re * re + im * im);
      if (m > peak)
        peak = m;
    }
  }
  meta.ref = peak > 0 ? 20 * Math.log10(peak / scale) + 1 : 0;
  const floorDb = meta.ref - span;
  if (bits >= 16) {
    const levels = new Uint16Array(frames * bins);
    for (let f = 0;f < frames; f++) {
      core.analyse(x, f * hop);
      const base = f * bins;
      for (let b = 0;b < bins; b++) {
        const m = Math.sqrt(core.re[b] * core.re[b] + core.im[b] * core.im[b]);
        const db = 20 * Math.log10(m / scale);
        const v = (db - floorDb) / span * 65535;
        levels[base + b] = v <= 0 ? 0 : v >= 65535 ? 65535 : Math.round(v);
      }
      if (Date.now() >= next) {
        if (alive && !alive())
          throw new Aborted;
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      }
    }
    return { meta, levels, phaseCos: null, phaseSin: null };
  }
  const levels = new Uint8Array(frames * bins);
  for (let f = 0;f < frames; f++) {
    core.analyse(x, f * hop);
    const base = f * bins;
    for (let b = 0;b < bins; b++) {
      const re = core.re[b];
      const im = core.im[b];
      levels[base + b] = quantize(Math.sqrt(re * re + im * im), scale, floorDb, span, steps);
    }
    if (Date.now() >= next) {
      if (alive && !alive())
        throw new Aborted;
      onProgress?.((f + 1) / frames);
      await yieldToUi();
      next = Date.now() + SLICE_MS;
    }
  }
  return { meta, levels, phaseCos: null, phaseSin: null };
}
var coverage = (win, hop, frames, padded) => {
  const w = hannWindow(win);
  const cover = new Float64Array(padded);
  for (let f = 0;f < frames; f++) {
    const s = f * hop;
    for (let m = 0;m < win; m++)
      cover[s + m] = cover[s + m] + w[m] * w[m];
  }
  return cover;
};
async function synthesiseExact(spec, alive, onProgress) {
  const { meta, levels, phaseCos, phaseSin } = spec;
  if (!phaseCos || !phaseSin)
    return invert(spec, alive, onProgress);
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  const padded = samples + win;
  const acc = new Float64Array(padded);
  const scale = win / 4;
  let next = 0;
  const holdC = new Float64Array(bins).fill(1);
  const holdS = new Float64Array(bins);
  for (let f = 0;f < frames; f++) {
    const base = f * bins;
    for (let b = 0;b < bins; b++) {
      const m = Math.pow(10, levelToMagDb(levels[base + b]) / 20) * scale;
      const cr = (phaseCos[base + b] - 127.5) / 127.5;
      const cs = (phaseSin[base + b] - 127.5) / 127.5;
      const h = Math.sqrt(cr * cr + cs * cs);
      let c;
      let s;
      if (h > SYNTH_TUNE.phaseDeadZone) {
        c = cr / h;
        s = cs / h;
        holdC[b] = c;
        holdS[b] = s;
      } else {
        c = holdC[b];
        s = holdS[b];
      }
      core.re[b] = m * c;
      core.im[b] = m * s;
    }
    core.add(acc, f * hop);
    if (Date.now() >= next) {
      if (alive && !alive())
        throw new Aborted;
      onProgress?.((f + 1) / frames);
      await yieldToUi();
      next = Date.now() + SLICE_MS;
    }
  }
  const cover = coverage(win, hop, frames, padded);
  let peak = 0;
  for (let i = 0;i < padded; i++)
    if (cover[i] > peak)
      peak = cover[i];
  const floor = peak * 0.05;
  const out = new Float32Array(samples);
  const pad = win / 2;
  for (let i = 0;i < samples; i++) {
    const c = cover[pad + i];
    out[i] = c > floor ? acc[pad + i] / c : 0;
  }
  return out;
}
function targetOf(spec, scale) {
  const { meta, levels } = spec;
  const out = new Float64Array(meta.frames * meta.bins);
  for (let i = 0;i < out.length; i++)
    out[i] = Math.pow(10, levelToDb(levels[i], meta) / 20) * scale;
  return out;
}
function finish(x, win, samples) {
  let peak = 0;
  for (let i = 0;i < samples; i++) {
    const v = Math.abs(x[win / 2 + i]);
    if (v > peak)
      peak = v;
  }
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  const fade = Math.min(samples, Math.max(64, Math.floor(win / 4)));
  const out = new Float32Array(samples);
  for (let i = 0;i < samples; i++) {
    let g = 1;
    if (i < fade)
      g *= Math.sin(Math.PI / 2 * (i / fade));
    else if (i > samples - fade)
      g *= Math.sin(Math.PI / 2 * ((samples - i) / fade));
    out[i] = x[win / 2 + i] * gain * g;
  }
  return out;
}
async function glRefine(x, target, spec, iters, alive, onProgress, budgetMs = GL_BUDGET_MS) {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  const full = core.bins;
  const padded = samples + win;
  const acc = new Float64Array(padded);
  const prevRe = new Float32Array(frames * full);
  const prevIm = new Float32Array(frames * full);
  const cover = coverage(win, hop, frames, padded);
  let top = 0;
  for (let i = 0;i < padded; i++)
    if (cover[i] > top)
      top = cover[i];
  const floor = top * 0.05;
  const deadline = Date.now() + budgetMs;
  let next = 0;
  for (let it = 0;it < iters; it++) {
    acc.fill(0);
    for (let f = 0;f < frames; f++) {
      const base = f * bins;
      const at = f * full;
      core.analyse(x, f * hop);
      for (let b = 0;b < full; b++) {
        const m = b < bins ? target[base + b] : 0;
        const cr = core.re[b];
        const ci = core.im[b];
        const d = Math.sqrt(cr * cr + ci * ci) || 0.000000000000000000000000000001;
        const pr = cr / d * m;
        const pi = ci / d * m;
        let nr = pr;
        let ni = pi;
        if (it > 0) {
          nr += TUNE.momentum * (pr - prevRe[at + b]);
          ni += TUNE.momentum * (pi - prevIm[at + b]);
        }
        prevRe[at + b] = pr;
        prevIm[at + b] = pi;
        core.re[b] = nr;
        core.im[b] = ni;
      }
      core.add(acc, f * hop);
    }
    for (let i = 0;i < padded; i++)
      x[i] = cover[i] > floor ? acc[i] / cover[i] : 0;
    onProgress?.((it + 1) / iters);
    if (Date.now() >= next) {
      if (alive && !alive())
        throw new Aborted;
      await yieldToUi();
      next = Date.now() + SLICE_MS;
    }
    if (it + 1 >= GL_MIN_ITERS && Date.now() > deadline)
      break;
  }
}
async function invert(spec, alive, onProgress, fine = false) {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const scale = win / 4;
  const target = targetOf(spec, scale);
  const padded = samples + win;
  const warm = TUNE.pghi ? phaseFromMagnitude(target, frames, bins, win, hop) : null;
  let next = 0;
  const y = await rtisiLa(target, frames, bins, win, hop, samples, {
    iters: fine ? TUNE.fine.rtisiIters : TUNE.rtisiIters,
    budget: fine ? TUNE.fine.rtisiBudget : DEFAULT_BUDGET,
    warm,
    tick: (m, total) => {
      if (Date.now() < next)
        return;
      if (alive && !alive())
        throw new Aborted;
      onProgress?.(m / total);
      return (async () => {
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      })();
    }
  });
  const x = new Float64Array(padded);
  for (let i = 0;i < samples; i++)
    x[win / 2 + i] = y[i];
  if (fine || TUNE.rtisiGl > 0)
    await glRefine(x, target, spec, fine ? TUNE.fine.glIters : TUNE.rtisiGl, alive, onProgress, fine ? TUNE.fine.glBudgetMs : undefined);
  return finish(x, win, samples);
}
async function synthesise(spec, alive, onProgress, quality = "fast") {
  const { meta, phaseCos, phaseSin } = spec;
  if (meta.exact && phaseCos && phaseSin)
    return synthesiseExact(spec, alive, onProgress);
  return invert(spec, alive, onProgress, quality === "fine");
}
function paramsForImage(frames, rows, sr, bits, ref, exact) {
  const clamped = Math.max(2, Math.min(rows, MAX_WIN / 2 + 1));
  const win = pow2(2 * (clamped - 1));
  const bins = Math.min(clamped, win / 2 + 1);
  const hop = Math.max(1, Math.round(win / 4));
  const count = Math.max(1, Math.min(frames, MAX_FRAMES));
  return { sr, win, hop, frames: count, bins, samples: count * hop, bits, ref, exact };
}

// src/lib/stub.ts
var STUB_ROWS = 8;
var bitPx = (w) => w >= 160 ? 4 : w >= 70 ? 2 : 1;
var MAGIC = 11;
var DARK = 20;
var LIGHT = 230;
var CRC_POLY = 7;
var STUB_SR = [
  8000,
  11025,
  12000,
  16000,
  22050,
  24000,
  32000,
  44100,
  48000,
  64000,
  88200,
  96000,
  176400,
  192000
];
var WIN_TABLE = [256, 512, 1024, 2048];
var srIndex = (sr) => STUB_SR.indexOf(sr);
function crc8(bits) {
  let crc = 255;
  for (const b of bits) {
    crc ^= b << 7;
    for (let i = 0;i < 8; i++)
      crc = crc & 128 ? (crc << 1 ^ CRC_POLY) & 255 : crc << 1 & 255;
  }
  return crc;
}
function stubBits(width, sr, win, exact) {
  const si = srIndex(sr);
  const wi = WIN_TABLE.indexOf(win);
  if (si < 0 || wi < 0 || width < 2 || width > 65535)
    return null;
  const [pre, wbits] = width <= 255 ? [0, 8] : width <= 4095 ? [1, 12] : [2, 16];
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1;i >= 0; i--)
      bits.push(v >> i & 1);
  };
  put(10, 4);
  put(MAGIC, 4);
  put(pre, 2);
  put(width, wbits);
  put(si, 4);
  put(wi, 2);
  put(exact ? 1 : 0, 1);
  put(crc8(bits.slice(4)), 8);
  return bits;
}
var stubSpan = (w) => {
  const bits = 25 + (w <= 255 ? 8 : w <= 4095 ? 12 : 16);
  return 2 + bits * bitPx(w);
};
function stubLuma(w, sr, win, exact) {
  const bits = stubBits(w, sr, win, exact);
  if (!bits || w < stubSpan(w) + 2)
    return null;
  const row = new Uint8Array(w).fill(DARK);
  const span = stubSpan(w);
  const step = bitPx(w);
  const starts = w >= 2 * span + 6 ? [2, w - span] : [2];
  for (const x0 of starts) {
    for (let x = x0;x < Math.min(w, x0 + span); x++) {
      const at = x - x0;
      const bit = at < 2 ? 0 : bits[Math.floor((at - 2) / step)];
      row[x] = bit ? LIGHT : DARK;
    }
  }
  return row;
}
function drawStub(px, w, h, sr, win, exact, toIndex) {
  const row = stubLuma(w, sr, win, exact);
  if (!row)
    return;
  for (let y = h - STUB_ROWS;y < h; y++) {
    for (let x = 0;x < w; x++) {
      const p = (y * w + x) * 4;
      const lum = row[x];
      if (toIndex)
        px[p] = toIndex(lum);
      else {
        px[p] = lum;
        px[p + 1] = lum;
        px[p + 2] = lum;
      }
      px[p + 3] = 255;
    }
  }
}
function decodeStub(profile) {
  const n = profile.length;
  if (n < 46)
    return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0;i < n; i++) {
    const v = profile[i];
    if (v < lo)
      lo = v;
    if (v > hi)
      hi = v;
  }
  const th = (lo + hi) / 2;
  if (hi - lo < 120)
    return null;
  const runs = [];
  let cur = profile[0] >= th ? 1 : 0;
  let len = 0;
  for (let i = 0;i < n; i++) {
    const v = profile[i] >= th ? 1 : 0;
    if (v === cur)
      len++;
    else {
      runs.push([cur, len]);
      cur = v;
      len = 1;
    }
  }
  runs.push([cur, len]);
  for (let r = 0;r + 4 < runs.length; r++) {
    if (runs[r][0] !== 1 || runs[r + 1][0] !== 0 || runs[r + 2][0] !== 1 || runs[r + 3][0] !== 0)
      continue;
    const total = runs[r][1] + runs[r + 1][1] + runs[r + 2][1] + runs[r + 3][1];
    const unit = total / 4;
    if (unit < 0.3)
      continue;
    if (Math.round(runs[r][1] / unit) !== 1 || Math.round(runs[r + 1][1] / unit) !== 1 || Math.round(runs[r + 2][1] / unit) !== 1 || Math.round(runs[r + 3][1] / unit) !== 1)
      continue;
    const bits = [];
    let totalBits = -1;
    let wN = 0;
    let bad = false;
    for (let j = r + 4;j < runs.length; j++) {
      const [v, l] = runs[j];
      const count = Math.max(1, Math.round(l / unit));
      for (let k = 0;k < count; k++) {
        bits.push(v);
        if (totalBits < 0 && bits.length >= 6) {
          const magic = bits[0] << 3 | bits[1] << 2 | bits[2] << 1 | bits[3];
          wN = [8, 12, 16, 0][bits[4] * 2 + bits[5]] ?? 0;
          if (magic !== MAGIC || !wN) {
            bad = true;
            break;
          }
          totalBits = 6 + wN + 15;
        }
        if (totalBits > 0 && bits.length >= totalBits)
          break;
      }
      if (bad || totalBits > 0 && bits.length >= totalBits)
        break;
    }
    if (bad || totalBits < 0 || bits.length !== totalBits)
      continue;
    const get = (at, w2) => {
      let v = 0;
      for (let i = 0;i < w2; i++)
        v = v << 1 | bits[at + i];
      return v;
    };
    if (crc8(bits.slice(0, 13 + wN)) !== get(13 + wN, 8))
      continue;
    const width = get(6, wN);
    const si = get(6 + wN, 4);
    const wi = get(10 + wN, 2);
    if (si >= STUB_SR.length || width < 2)
      continue;
    return { width, sr: STUB_SR[si], win: WIN_TABLE[wi], exact: get(12 + wN, 1) === 1 };
  }
  return null;
}
var stubFits = (w) => w >= stubSpan(w) + 4;

// src/lib/image.ts
var FORMAT_VERSION = 4;
function metaToText(meta) {
  return JSON.stringify([
    FORMAT_VERSION,
    meta.sr,
    meta.win,
    meta.hop,
    meta.frames,
    meta.bins,
    meta.samples,
    meta.bits,
    Math.round(meta.ref * 10) / 10,
    meta.exact ? 1 : 0
  ]);
}
function textToMeta(text) {
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v))
      return null;
    const ver = v[0];
    if (ver !== FORMAT_VERSION)
      return null;
    if (v.length < 10)
      return null;
    const n = v.slice(1, 10).map(Number);
    if (n.some((x, i) => i === 7 ? !Number.isFinite(x) : !Number.isInteger(x)))
      return null;
    const [sr, win, hop, frames, bins, samples, bits, ref, exact] = n;
    if (sr <= 0 || win <= 0 || hop <= 0 || frames <= 0 || bins <= 0 || samples < 0)
      return null;
    if ((win & win - 1) !== 0 || win < 256 || win > 4096)
      return null;
    if (hop < 1 || hop > win)
      return null;
    if (bins > win / 2 + 1)
      return null;
    return {
      sr,
      win,
      hop,
      frames,
      bins,
      samples,
      bits,
      ref,
      exact: exact === 1
    };
  } catch {
    return null;
  }
}
function metaFromName(name) {
  const m = /_SR(\d+)_N(\d+)_H(\d+)_F(\d+)_L(\d+)_B(\d+)\.(?:png|jpe?g|jpe|webp|avif|bmp|gif)$/i.exec(name);
  if (!m)
    return null;
  const [sr, win, hop, frames, samples, bits] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  if (![sr, win, hop, frames, samples, bits].every((x) => Number.isFinite(x) && x >= 0))
    return null;
  if ((win & win - 1) !== 0)
    return null;
  return {
    sr,
    win,
    hop: Math.min(win, hop),
    frames,
    bins: win / 2 + 1,
    samples,
    bits,
    ref: 0,
    exact: bits === 0
  };
}
function downloadName(base, meta) {
  const stem = base.replace(/\.[^.]+$/, "") || "spectrum";
  return `${stem}_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}.png`;
}
function sniff(bytes) {
  const tag = (at, s) => s.split("").every((c, i) => bytes[at + i] === c.charCodeAt(0));
  if (bytes[0] === 137 && tag(1, "PNG"))
    return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "jpeg";
  if (tag(0, "BM"))
    return "bmp";
  if (tag(0, "GIF8"))
    return "gif";
  if (tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8L"))
      return "webp-lossless";
    return "webp";
  }
  if (tag(4, "ftyp")) {
    const major = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (major === "avif" || major === "avis" || major === "mif1")
      return "avif";
    return "?";
  }
  return "?";
}
var MAX_SOURCE_PIXELS = 24000000;
var FOREIGN_FRAMES = 6000;
function winFromBins(bins) {
  const raw = Math.max(2, (bins - 1) * 2);
  let win = 256;
  while (win * 2 <= Math.min(raw, 4096))
    win *= 2;
  return win;
}
function metaFromGeometry(frames, bins, exact, bits) {
  const win = winFromBins(bins);
  return {
    sr: 8000,
    win,
    hop: win / 2,
    frames: Math.max(2, Math.min(frames, MAX_FRAMES)),
    bins: Math.min(bins, win / 2 + 1),
    samples: Math.max(2, Math.min(frames, MAX_FRAMES)) * (win / 2),
    bits,
    ref: 0,
    exact
  };
}
function recognizeExact(pixels, w, h) {
  if (w < 4 || h < 8)
    return false;
  const rows = Math.floor(h / 2);
  const stepX = Math.max(1, Math.floor(w / 48));
  const stepY = Math.max(1, Math.floor(rows / 24));
  let ok = 0;
  let total = 0;
  for (let y = 0;y < rows; y += stepY) {
    for (let x = 0;x < w; x += stepX) {
      const p = ((rows + y) * w + x) * 4;
      total++;
      if (pixels[p + 2] > 48)
        continue;
      const cr = pixels[p] - 127.5;
      const cs = pixels[p + 1] - 127.5;
      const rad2 = cr * cr + cs * cs;
      if (rad2 < 400 || rad2 > 40000)
        continue;
      ok++;
    }
  }
  return ok >= 12 && ok / Math.max(1, total) >= 0.55;
}
function surface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx)
    throw new Error("这个浏览器不支持 canvas");
  return { canvas, ctx };
}
function sampleLevels(data, width, rowTop, rowCount, frames, bins) {
  const out = new Uint8Array(frames * bins);
  const sx = width / frames;
  const sy = rowCount / bins;
  for (let f = 0;f < frames; f++) {
    const x0 = Math.min(width - 1, Math.floor(f * sx));
    const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((f + 1) * sx)));
    for (let b = 0;b < bins; b++) {
      const y0 = Math.min(rowCount - 1, Math.floor(b * sy));
      const y1 = Math.min(rowCount, Math.max(y0 + 1, Math.ceil((b + 1) * sy)));
      let sum = 0;
      let n = 0;
      for (let y = y0;y < y1; y++) {
        const imgRow = rowTop + rowCount - 1 - y;
        for (let x = x0;x < x1; x++) {
          const p = (imgRow * width + x) * 4;
          sum += luma(data[p], data[p + 1], data[p + 2]);
          n++;
        }
      }
      out[f * bins + b] = FROM_LUMA[Math.round(sum / Math.max(1, n)) & 255];
    }
  }
  return out;
}
function samplePhase(data, width, rowTop, rowCount, frames, bins) {
  const cos = new Uint8Array(frames * bins);
  const sin = new Uint8Array(frames * bins);
  const sx = width / frames;
  const sy = rowCount / bins;
  let sumLen = 0;
  let cells = 0;
  for (let f = 0;f < frames; f++) {
    const x0 = Math.min(width - 1, Math.floor(f * sx));
    const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((f + 1) * sx)));
    for (let b = 0;b < bins; b++) {
      const y0 = Math.min(rowCount - 1, Math.floor(b * sy));
      const y1 = Math.min(rowCount, Math.max(y0 + 1, Math.ceil((b + 1) * sy)));
      let sc = 0;
      let ss = 0;
      let n = 0;
      for (let y = y0;y < y1; y++) {
        const imgRow = rowTop + rowCount - 1 - y;
        for (let x = x0;x < x1; x++) {
          const p = (imgRow * width + x) * 4;
          sc += data[p] - 127.5;
          ss += data[p + 1] - 127.5;
          n++;
        }
      }
      const cr = sc / n;
      const cs = ss / n;
      const h = Math.sqrt(cr * cr + cs * cs);
      sumLen += h;
      cells++;
      const k = h > 0.000001 ? 127.5 / h : 0;
      cos[f * bins + b] = Math.max(0, Math.min(255, Math.round(cr * k + 127.5)));
      sin[f * bins + b] = Math.max(0, Math.min(255, Math.round(cs * k + 127.5)));
    }
  }
  return { cos, sin, reliability: cells > 0 ? sumLen / cells / 127.5 : 0 };
}
function rescaled(meta, width, maxHop) {
  const hop = Math.max(1, Math.min(Math.round(maxHop), Math.round(meta.samples / Math.max(2, width))));
  const frames = Math.max(2, Math.min(MAX_FRAMES, Math.round(meta.samples / hop)));
  return { ...meta, frames, bins: meta.bins, hop, samples: frames * hop, exact: false };
}
var READ_TUNE = { phaseReliable: 0.5, phaseReliableJpeg: 0.3 };
function stubFromPixels(pixels, w, h) {
  for (let rows = STUB_ROWS;rows >= 2; rows--) {
    if (h <= rows)
      break;
    const prof = [];
    for (let x = 0;x < w; x++) {
      let s = 0;
      for (let y = h - rows;y < h; y++) {
        const p = (y * w + x) * 4;
        s += 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
      }
      prof.push(s / rows);
    }
    const info = decodeStub(prof);
    if (info)
      return info;
  }
  return null;
}
async function imageToSpectrum(file, fileName) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = sniff(bytes);
  let meta = textToMeta(readMeta(bytes) ?? "") ?? metaFromName(fileName);
  if (meta === null) {
    const idx = await readIndexedRamp(bytes);
    if (idx && idx.width * idx.height <= MAX_SOURCE_PIXELS) {
      let stub = null;
      for (let rows = STUB_ROWS;rows >= 2 && !stub; rows--) {
        if (idx.height <= rows)
          break;
        const prof = [];
        for (let x = 0;x < idx.width; x++) {
          let s = 0;
          for (let y = idx.height - rows;y < idx.height; y++)
            s += idx.levels[y * idx.width + x];
          prof.push(s / rows);
        }
        stub = decodeStub(prof);
      }
      if (stub) {
        const hEff = idx.height - STUB_ROWS;
        const bins0 = stub.win / 2 + 1;
        const gmeta = {
          sr: stub.sr,
          win: stub.win,
          hop: stub.win / 2,
          frames: stub.width,
          bins: bins0,
          samples: stub.width * (stub.win / 2),
          bits: 8,
          ref: 0,
          exact: false
        };
        const levels = new Uint8Array(gmeta.frames * gmeta.bins);
        const sx = idx.width / gmeta.frames;
        const sy = hEff / gmeta.bins;
        for (let f = 0;f < gmeta.frames; f++) {
          const x0 = Math.min(idx.width - 1, Math.floor(f * sx));
          const x1 = Math.min(idx.width, Math.max(x0 + 1, Math.ceil((f + 1) * sx)));
          for (let b = 0;b < gmeta.bins; b++) {
            const y0 = Math.min(hEff - 1, Math.floor(b * sy));
            const y1 = Math.min(hEff, Math.max(y0 + 1, Math.ceil((b + 1) * sy)));
            let sum = 0;
            let n = 0;
            for (let x = x0;x < x1; x++)
              for (let y = y0;y < y1; y++) {
                sum += idx.levels[y * idx.width + x];
                n++;
              }
            levels[f * gmeta.bins + b] = n > 0 ? Math.round(sum / n) : 0;
          }
        }
        return {
          spec: { meta: gmeta, levels, phaseCos: null, phaseSin: null },
          mode: "degraded",
          container,
          width: idx.width,
          height: idx.height,
          phaseReliability: null,
          guessed: false
        };
      }
      const gmeta = metaFromGeometry(idx.width, idx.height, false, 8);
      const levels = new Uint8Array(gmeta.frames * gmeta.bins);
      const sx = idx.width / gmeta.frames;
      const sy = idx.height / gmeta.bins;
      for (let f = 0;f < gmeta.frames; f++) {
        const col = Math.min(idx.width - 1, Math.floor((f + 0.5) * sx));
        for (let b = 0;b < gmeta.bins; b++) {
          const row = Math.min(idx.height - 1, Math.floor((b + 0.5) * sy));
          levels[f * gmeta.bins + b] = idx.levels[row * idx.width + col];
        }
      }
      return {
        spec: { meta: gmeta, levels, phaseCos: null, phaseSin: null },
        mode: "compact",
        container,
        width: idx.width,
        height: idx.height,
        phaseReliability: null,
        guessed: true
      };
    }
  }
  let bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    if (width * height > MAX_SOURCE_PIXELS) {
      const k = Math.sqrt(MAX_SOURCE_PIXELS / (width * height));
      const scaled = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(width * k)),
        resizeHeight: Math.max(1, Math.round(height * k))
      });
      bitmap.close();
      bitmap = scaled;
    }
    const { canvas, ctx } = surface(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const w = bitmap.width;
    let h = bitmap.height;
    const pixels = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
    const stub = stubFromPixels(pixels, w, h);
    if (stub)
      h = Math.max(2, h - Math.max(1, Math.round(STUB_ROWS * w / stub.width)));
    if (stub && (meta === null || w < stub.width * 0.95)) {
      const bins0 = stub.win / 2 + 1;
      const frames0 = stub.width;
      const meta0 = {
        sr: stub.sr,
        win: stub.win,
        hop: stub.win / 2,
        frames: frames0,
        bins: bins0,
        samples: frames0 * (stub.win / 2),
        bits: stub.exact ? 0 : 8,
        ref: meta?.ref ?? 0,
        exact: stub.exact
      };
      if (stub.exact) {
        const bandRows = Math.max(1, Math.floor(h / BANDS));
        const levels = sampleLevels(pixels, w, 0, bandRows, frames0, bins0);
        const ph = samplePhase(pixels, w, bandRows, bandRows, frames0, bins0);
        const scaled = w < stub.width * 0.95;
        const th = scaled ? READ_TUNE.phaseReliable : READ_TUNE.phaseReliableJpeg;
        const keep = ph.reliability >= th;
        return {
          spec: {
            meta: meta0,
            levels,
            phaseCos: keep ? ph.cos : null,
            phaseSin: keep ? ph.sin : null
          },
          mode: "degraded",
          container,
          width: w,
          height: h,
          phaseReliability: ph.reliability,
          guessed: false
        };
      }
      return {
        spec: {
          meta: meta0,
          levels: sampleLevels(pixels, w, 0, h, frames0, bins0),
          phaseCos: null,
          phaseSin: null
        },
        mode: "degraded",
        container,
        width: w,
        height: h,
        phaseReliability: null,
        guessed: false
      };
    }
    let m0 = meta;
    if (m0 === null && recognizeExact(pixels, w, h)) {
      m0 = metaFromGeometry(w, Math.floor(h / 2), true, 0);
    }
    const known = m0 !== null;
    const exact = m0 !== null && m0.exact;
    const bandRows = exact ? Math.max(1, Math.floor(h / BANDS)) : h;
    const intact = m0 !== null && w === m0.frames && bandRows === m0.bins;
    if (exact && m0) {
      const binsFit0 = Math.min(m0.bins, bandRows);
      const winFit = winFromBins(binsFit0);
      const binsFit = Math.min(binsFit0, winFit / 2 + 1);
      const rs = rescaled(m0, w, winFit / 2);
      const next = intact && binsFit === m0.bins ? { ...m0 } : { ...rs, bins: binsFit, win: winFit, exact: true };
      const levels = sampleLevels(pixels, w, 0, bandRows, next.frames, next.bins);
      const ph = samplePhase(pixels, w, bandRows, bandRows, next.frames, next.bins);
      const keep = ph.reliability >= READ_TUNE.phaseReliable;
      const mode = intact ? "exact" : "degraded";
      return {
        spec: {
          meta: { ...next, exact: true },
          levels,
          phaseCos: keep ? ph.cos : null,
          phaseSin: keep ? ph.sin : null
        },
        mode,
        container,
        width: w,
        height: h,
        phaseReliability: ph.reliability,
        guessed: !known
      };
    }
    const frames = m0 !== null ? Math.min(w, m0.frames) : Math.min(w, FOREIGN_FRAMES);
    const rows = Math.max(2, Math.min(intact && m0 ? m0.bins : bandRows, 1025));
    let next;
    if (m0 !== null && intact) {
      next = { ...m0, bins: m0.bins };
    } else if (m0 !== null) {
      const binsFit0 = Math.min(m0.bins, bandRows);
      const winFit = winFromBins(binsFit0);
      const rs = rescaled(m0, w, winFit / 2);
      next = { ...rs, bins: Math.min(binsFit0, winFit / 2 + 1), win: winFit };
    } else {
      next = paramsForImage(frames, rows, DEFAULT_SR, 8, 0, false);
    }
    const levels = sampleLevels(pixels, w, 0, bandRows, next.frames, next.bins);
    const mode = !known ? "foreign" : intact ? "compact" : "degraded";
    return {
      spec: { meta: next, levels, phaseCos: null, phaseSin: null },
      mode,
      container,
      width: w,
      height: h,
      phaseReliability: null,
      guessed: false
    };
  } finally {
    bitmap.close();
  }
}
function exactPixels(spec) {
  const { meta, levels, phaseCos, phaseSin } = spec;
  const { frames, bins } = meta;
  const width = frames;
  const stubRows = stubFits(frames) ? STUB_ROWS : 0;
  const height = BANDS * bins + stubRows;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  for (let row = 0;row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0;f < frames; f++) {
      const c = levels[f * bins + b] * 3;
      pixels[p] = RAMP[c];
      pixels[p + 1] = levels[f * bins + b];
      pixels[p + 2] = RAMP[c + 2];
      pixels[p + 3] = 255;
      p += 4;
    }
  }
  for (let row = 0;row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0;f < frames; f++) {
      const i = f * bins + b;
      pixels[p] = phaseCos?.[i] ?? 0;
      pixels[p + 1] = phaseSin?.[i] ?? 0;
      pixels[p + 2] = 0;
      pixels[p + 3] = 255;
      p += 4;
    }
  }
  if (stubRows)
    drawStub(pixels, width, height, meta.sr, meta.win, true);
  return { pixels, width, height };
}
async function exactPng(spec) {
  const { pixels, width, height } = exactPixels(spec);
  const { canvas, ctx } = surface(width, height);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  const raw = await new Promise((done) => canvas.toBlob(done, "image/png"));
  if (!raw)
    throw new Error("频谱图生成失败");
  canvas.width = 0;
  canvas.height = 0;
  const bytes = new Uint8Array(await raw.arrayBuffer());
  return new Blob([withMeta(bytes, metaToText(spec.meta))], { type: "image/png" });
}
async function compactPng(spec) {
  const { meta, levels } = spec;
  const steps = stepsOf(meta.bits);
  const depth = steps <= 1 ? 1 : steps <= 3 ? 2 : steps <= 15 ? 4 : 8;
  const count = 1 << depth;
  const indices = new Uint8Array(levels.length);
  for (let i = 0;i < levels.length; i++)
    indices[i] = Math.round(levels[i] * steps / 255) & count - 1;
  const palette = new Uint8Array(count * 3);
  for (let q = 0;q < count; q++) {
    const c = Math.min(255, Math.round(Math.min(q, steps) * 255 / steps)) * 3;
    palette[q * 3] = RAMP[c];
    palette[q * 3 + 1] = RAMP[c + 1];
    palette[q * 3 + 2] = RAMP[c + 2];
  }
  const { frames, bins } = meta;
  const stub = stubFits(frames) ? stubLuma(frames, meta.sr, meta.win, false) : null;
  const stubRows = stub ? STUB_ROWS : 0;
  const packed = new Uint8Array(frames * (bins + stubRows));
  for (let row = 0;row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0;f < frames; f++)
      packed[row * frames + f] = indices[f * bins + b];
  }
  if (stub) {
    const dark = 0;
    const light = steps;
    for (let i = 0;i < STUB_ROWS * frames; i++)
      packed[bins * frames + i] = stub[i % frames] > 125 ? light : dark;
  }
  const bytes = await indexedPng(packed, frames, bins + stubRows, depth, palette, metaToText(meta));
  return new Blob([bytes], { type: "image/png" });
}
function spectrumToPng(spec) {
  return spec.meta.exact ? exactPng(spec) : compactPng(spec);
}

// src/lib/resample.ts
var clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
function kernel(d, fc) {
  if (d === 0)
    return 2 * fc;
  return Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
}
function resample(x, from, to, cutoffHz = 0) {
  if (x.length === 0 || from === to && cutoffHz <= 0)
    return x.slice();
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(x.length / ratio)));
  const nyq = 0.5 * Math.min(1, to / from);
  const limit = cutoffHz > 0 ? Math.min(nyq, cutoffHz / from) : nyq;
  const fc = limit * 0.92;
  const half = clamp(Math.round(2 / Math.max(fc, 0.00001)), 3, 64);
  for (let j = 0;j < out.length; j++) {
    const center = j * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;
    let acc = 0;
    let wsum = 0;
    for (let m = 1 - half;m <= half; m++) {
      const d = m - frac;
      const t = d / (half + 0.5);
      const w = kernel(d, fc) * (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
      const i = i0 + m;
      if (i >= 0 && i < x.length) {
        acc += x[i] * w;
        wsum += w;
      }
    }
    out[j] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}
function slice(pcm, sr, start, end) {
  const a = Math.max(0, Math.min(pcm.length - 1, Math.floor(start * sr)));
  const b = end > 0 ? Math.min(pcm.length, Math.ceil(end * sr)) : pcm.length;
  if (a === 0 && b === pcm.length)
    return pcm;
  return pcm.slice(a, Math.max(a, b));
}

// bench/entry.ts
var log10 = Math.log10;
function align(a, b, span) {
  const n = Math.min(a.length, b.length);
  let best = 0;
  let bv = -2;
  for (let lag = -span;lag <= span; lag++) {
    let sa = 0;
    let sb = 0;
    let sab = 0;
    for (let i = 0;i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n)
        continue;
      sa += a[i] * a[i];
      sb += b[j] * b[j];
      sab += a[i] * b[j];
    }
    const v = sab / Math.sqrt(Math.max(sa * sb, 0.000000000000000000000000000001));
    if (v > bv) {
      bv = v;
      best = lag;
    }
  }
  let sa = 0;
  let se = 0;
  for (let i = 0;i < n; i++) {
    const j = i + best;
    if (j < 0 || j >= n)
      continue;
    const d = a[i] - b[j];
    sa += a[i] * a[i];
    se += d * d;
  }
  return { corr: bv, snr: 10 * log10(Math.max(sa, 0.000000000000000000000000000001) / Math.max(se, 0.000000000000000000000000000001)) };
}
function chunkCorr(a, b, chunk, span) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let cnt = 0;
  for (let s = 0;s + chunk <= n; s += chunk) {
    let best = -2;
    for (let lag = -span;lag <= span; lag++) {
      let sa = 0;
      let sb = 0;
      let sab = 0;
      for (let i = s;i < s + chunk; i++) {
        const j = i + lag;
        if (j < 0 || j >= n)
          continue;
        sa += a[i] * a[i];
        sb += b[j] * b[j];
        sab += a[i] * b[j];
      }
      const v = sab / Math.sqrt(Math.max(sa * sb, 0.000000000000000000000000000001));
      if (v > best)
        best = v;
    }
    sum += best;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}
function magnitudes(x, win, hop) {
  const fft = new FFT(win);
  const w = hannWindow(win);
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const pad = new Float64Array(x.length + win);
  for (let i = 0;i < x.length; i++)
    pad[win / 2 + i] = x[i];
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const out = new Float64Array(frames * bins);
  for (let f = 0;f < frames; f++) {
    for (let m = 0;m < win; m++) {
      re[m] = pad[f * hop + m] * w[m];
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0;b < bins; b++)
      out[f * bins + b] = Math.sqrt(re[b] ** 2 + im[b] ** 2);
  }
  return out;
}
function spectral(ref, got) {
  const n = Math.min(ref.length, got.length);
  let num = 0;
  let den = 0;
  for (let i = 0;i < n; i++) {
    const d = ref[i] - got[i];
    num += d * d;
    den += ref[i] * ref[i];
  }
  const conv = 10 * log10(Math.max(num, 0.000000000000000000000000000001) / Math.max(den, 0.000000000000000000000000000001));
  let topA = 0;
  let topB = 0;
  for (let i = 0;i < n; i++) {
    if (ref[i] > topA)
      topA = ref[i];
    if (got[i] > topB)
      topB = got[i];
  }
  const floorA = Math.log(Math.max(topA, 0.000000000000000000000000000001)) - 80 / 8.686;
  const floorB = Math.log(Math.max(topB, 0.000000000000000000000000000001)) - 80 / 8.686;
  let acc = 0;
  for (let i = 0;i < n; i++) {
    const la = Math.max(Math.log(Math.max(ref[i], 0.000000000000000000000000000001)), floorA);
    const lb = Math.max(Math.log(Math.max(got[i], 0.000000000000000000000000000001)), floorB);
    const d = la - floorA - (lb - floorB);
    acc += d * d;
  }
  return { conv, lsd: 8.686 * Math.sqrt(acc / Math.max(n, 1)) };
}
function magSnr(ref, spec) {
  const { meta, levels } = spec;
  const { win, hop, bins, frames } = meta;
  const scale = win / 4;
  const truth = magnitudes(ref, win, hop);
  let se = 0;
  let sa = 0;
  const n = Math.min(frames * bins, truth.length);
  for (let i = 0;i < n; i++) {
    const f = Math.floor(i / bins);
    const b = i % bins;
    const t = truth[f * (win / 2 + 1) + b];
    const db = targetDb(levels[i], meta);
    const got = Math.pow(10, db / 20) * scale;
    const d = got - t;
    se += d * d;
    sa += t * t;
  }
  return 10 * log10(Math.max(sa, 0.000000000000000000000000000001) / Math.max(se, 0.000000000000000000000000000001));
}
function targetDb(level, meta) {
  const bits = Math.max(1, meta.bits || 8);
  const steps = (1 << bits) - 1;
  const span = 12 * bits;
  const q = Math.round(level * steps / 255);
  return (meta.exact ? -120 : meta.ref - span) + q / steps * (meta.exact ? 120 : span);
}
var VIA_SPEC = {
  png: { scale: 1, type: "image/png" },
  jpeg: { scale: 1, type: "image/jpeg" },
  half: { scale: 0.5, type: "image/png" },
  s75: { scale: 0.75, type: "image/png" },
  s90: { scale: 0.9, type: "image/png" },
  jpeg75: { scale: 0.75, type: "image/jpeg" }
};
async function degrade(blob, via, name) {
  if (via === "png")
    return blob;
  const spec = VIA_SPEC[via];
  const scale = spec?.scale ?? (via === "half" ? 0.5 : 1);
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = spec?.type ?? (via === "jpeg" || via === "jpeg-anon" ? "image/jpeg" : "image/png");
  const out = await new Promise((done) => canvas.toBlob(done, type, 0.72));
  canvas.width = 0;
  canvas.height = 0;
  return out ?? blob;
}
async function loadAudio(url) {
  const bytes = await (await fetch(url)).arrayBuffer();
  return decodeAudioFile(bytes);
}
function setTune(t) {
  if (t.pghi !== undefined)
    TUNE.pghi = t.pghi;
  if (t.iters !== undefined)
    TUNE.iters = t.iters;
  if (t.momentum !== undefined)
    TUNE.momentum = t.momentum;
  if (t.gamma !== undefined)
    TUNE.gamma = t.gamma;
  if (t.rtisi !== undefined)
    TUNE.rtisi = t.rtisi;
  if (t.rtisiIters !== undefined)
    TUNE.rtisiIters = t.rtisiIters;
  if (t.rtisiGl !== undefined)
    TUNE.rtisiGl = t.rtisiGl;
  if (t.phaseReliable !== undefined)
    READ_TUNE.phaseReliable = t.phaseReliable;
  if (t.phaseDeadZone !== undefined)
    SYNTH_TUNE.phaseDeadZone = t.phaseDeadZone;
  return JSON.stringify(TUNE);
}
async function synthProbe(pcm, sr, win, hop, bits, seconds = 4) {
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * seconds)));
  const samples = x.length;
  const bins = win / 2 + 1;
  const frames = Math.floor(samples / hop) + 1;
  const scale = win / 4;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const padded = samples + win;
  const pad = new Float64Array(padded);
  for (let i = 0;i < samples; i++)
    pad[win / 2 + i] = x[i];
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0;f < frames; f++) {
    for (let m = 0;m < win; m++) {
      re[m] = pad[f * hop + m] * w[m];
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0;b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b] ** 2 + im[b] ** 2);
      truth[f * bins + b] = Math.atan2(im[b], re[b]);
    }
  }
  let peak = 0;
  for (let i = 0;i < mag.length; i++)
    if (mag[i] > peak)
      peak = mag[i];
  const span = bits * 12;
  const steps = (1 << bits) - 1;
  const ref = 20 * Math.log10(Math.max(peak, 0.000000000000000000000000000001) / scale) + 1;
  const floorDb = ref - span;
  const levels = new Uint8Array(frames * bins);
  const target = new Float64Array(frames * bins);
  for (let i = 0;i < levels.length; i++) {
    const db = 20 * Math.log10(Math.max(mag[i], 0.000000000000000000000000000001) / scale);
    const q = Math.round((db - floorDb) / span * steps);
    const c = q <= 0 ? 0 : q >= steps ? steps : q;
    levels[i] = Math.round(c * 255 / steps);
    target[i] = Math.pow(10, (floorDb + c / steps * span) / 20) * scale;
  }
  const spec = {
    meta: { sr, win, hop, frames, bins, samples, bits, ref, exact: false },
    levels,
    phaseCos: null,
    phaseSin: null
  };
  const wola = (ph) => {
    const acc = new Float64Array(padded);
    const cover = new Float64Array(padded);
    for (let f = 0;f < frames; f++) {
      for (let b = 0;b < bins; b++) {
        re[b] = target[f * bins + b] * Math.cos(ph[f * bins + b]);
        im[b] = target[f * bins + b] * Math.sin(ph[f * bins + b]);
      }
      im[0] = 0;
      im[bins - 1] = 0;
      for (let b = 1;b < bins - 1; b++) {
        re[win - b] = re[b];
        im[win - b] = -im[b];
      }
      fft.transform(re, im, true);
      for (let m = 0;m < win; m++) {
        acc[f * hop + m] = acc[f * hop + m] + re[m] * w[m];
        cover[f * hop + m] = cover[f * hop + m] + w[m] * w[m];
      }
    }
    let top = 0;
    for (let i = 0;i < padded; i++)
      if (cover[i] > top)
        top = cover[i];
    const out = new Float32Array(samples);
    for (let i = 0;i < samples; i++)
      out[i] = cover[win / 2 + i] > top * 0.05 ? acc[win / 2 + i] / cover[win / 2 + i] : 0;
    return out;
  };
  const ref0 = x;
  const show = (label, y, ms) => {
    const a = align(ref0, y, Math.min(2048, Math.floor(samples / 4)));
    const s = spectral(magnitudes(ref0, 1024, 256), magnitudes(y, 1024, 256));
    const cc = chunkCorr(ref0, y, Math.round(sr * 0.05), Math.round(sr * 0.012));
    return `${label} ${a.snr.toFixed(1)}dB/${a.corr.toFixed(3)}/窗内${cc.toFixed(3)}/LSD${s.lsd.toFixed(1)}/${Math.round(ms)}ms`;
  };
  const out = [];
  let t = performance.now();
  out.push(show("上限", wola(truth), performance.now() - t));
  const gl0 = TUNE.rtisiGl;
  const runs = [
    ["PGHI+GL", () => (TUNE.rtisi = false, synthesise(spec))],
    ["RTISI", () => {
      TUNE.rtisi = true;
      TUNE.rtisiGl = 0;
      return synthesise(spec);
    }],
    ["RTISI+GL", () => {
      TUNE.rtisi = true;
      TUNE.rtisiGl = gl0;
      return synthesise(spec);
    }]
  ];
  for (const [label, go] of runs) {
    t = performance.now();
    const y = await go();
    out.push(show(label, y, performance.now() - t));
  }
  return `win=${win} hop=${hop} ${bits}bit  ${out.join("  ")}`;
}
function atRate(pcm, sr, to) {
  return { pcm: resample(pcm, sr, to, 0), sr: to };
}
async function runCase(srcPcm, srcSr, name, c) {
  const t0 = performance.now();
  const enc = {
    mode: c.mode,
    sr: c.sr,
    bits: c.bits,
    fineness: c.fineness,
    fmax: c.fmax,
    start: 0,
    end: 0
  };
  const sr = c.sr > 0 ? c.sr : srcSr;
  const tuned = resample(slice(srcPcm, srcSr, 0, 0), srcSr, sr, c.mode === "compact" ? c.fmax : 0);
  const spec = await encode(tuned, sr, enc);
  let back = spec;
  let bytes = 0;
  let rel = null;
  let dims = "?";
  let readMode = "";
  if (c.via !== "none") {
    const png = await spectrumToPng(spec);
    const anon = c.via.endsWith("-anon");
    const viaKey = anon ? c.via.slice(0, -5) : c.via;
    const isJpeg = viaKey.startsWith("jpeg");
    const fileName = anon ? isJpeg ? "untitled.jpg" : "untitled.png" : downloadName(name, spec.meta);
    const degraded = await degrade(png, viaKey, fileName);
    bytes = degraded.size;
    const read = await imageToSpectrum(degraded, fileName);
    console.error(`[diag] ${fileName} ${read.width}x${read.height} mode=${read.mode} guessed=${read.guessed} frames=${read.spec.meta.frames} bins=${read.spec.meta.bins} sr=${read.spec.meta.sr} dur=${(read.spec.meta.samples / read.spec.meta.sr).toFixed(2)}s`);
    back = read.spec;
    rel = read.phaseReliability;
    readMode = read.mode;
    dims = `${read.width}x${read.height}`;
  }
  const y = await synthesise(back);
  const ref = tuned.subarray(0, Math.min(tuned.length, y.length));
  const a = align(ref, y, Math.min(2048, Math.floor(ref.length / 4)));
  const win = 1024;
  const hop = 256;
  const s = spectral(magnitudes(ref, win, hop), magnitudes(y, win, hop));
  return {
    file: name,
    case: `${c.mode}/${c.sr || "原"}/${c.bits}b/${FINENESS[c.fineness].label}/${c.via}/${(back.meta.samples / back.meta.sr).toFixed(2)}s/${dims}`,
    ms: Math.round(performance.now() - t0),
    bytes,
    frames: spec.meta.frames,
    bins: spec.meta.bins,
    seconds: Math.round(spec.meta.samples / sr * 10) / 10,
    rel,
    readMode,
    m: {
      snr: Math.round(a.snr * 10) / 10,
      corr: Math.round(a.corr * 1000) / 1000,
      conv: Math.round(s.conv * 10) / 10,
      lsd: Math.round(s.lsd * 10) / 10,
      magSnr: Math.round(magSnr(ref, back) * 10) / 10,
      levelErr: levelErr(spec, back)
    }
  };
}
function levelErr(a, b) {
  const n = Math.min(a.levels.length, b.levels.length);
  if (n === 0 || a.meta.bins !== b.meta.bins)
    return 255;
  let worst = 0;
  for (let i = 0;i < n; i++) {
    const d = Math.abs(a.levels[i] - b.levels[i]);
    if (d > worst)
      worst = d;
  }
  return worst;
}
async function sigProbeBlob(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none" });
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;
  const rows = Math.floor(h / 2);
  const stepX = Math.max(1, Math.floor(w / 48));
  const stepY = Math.max(1, Math.floor(rows / 24));
  let total = 0;
  let okB = 0;
  let okR = 0;
  let ok = 0;
  let bMax = 0;
  let rMin = 1e9;
  let rMax = 0;
  for (let y = 0;y < rows; y += stepY)
    for (let x = 0;x < w; x += stepX) {
      const p = ((rows + y) * w + x) * 4;
      total++;
      const b = px[p + 2];
      if (b > bMax)
        bMax = b;
      if (b <= 48)
        okB++;
      const cr = px[p] - 127.5;
      const cs = px[p + 1] - 127.5;
      const r = Math.sqrt(cr * cr + cs * cs);
      if (r < rMin)
        rMin = r;
      if (r > rMax)
        rMax = r;
      if (r >= 20 && r <= 200)
        okR++;
      if (b <= 48 && r >= 20 && r <= 200)
        ok++;
    }
  const hit = await imageToSpectrum(new Blob([bytes.slice()]), "untitled.bin");
  return `${w}×${h} rows=${rows} 采样 ${total}  B≤48: ${(okB / total * 100).toFixed(0)}% (max ${bMax})  ` + `半径20-200: ${(okR / total * 100).toFixed(0)}% (${rMin.toFixed(0)}..${rMax.toFixed(0)})  ` + `全过: ${(ok / total * 100).toFixed(0)}%  → 认图 ${hit.mode}${hit.guessed ? "/guessed" : ""} rel=${hit.phaseReliability?.toFixed(2) ?? "-"}`;
}
async function sigProbe(srcPcm, srcSr, via) {
  const enc = { mode: "exact", sr: 0, bits: 8, fineness: 1, fmax: 0, start: 0, end: 0 };
  const sr = srcSr;
  const tuned = resample(slice(srcPcm, srcSr, 0, 0), srcSr, sr, 0);
  const spec = await encode(tuned, sr, enc);
  const png = await spectrumToPng(spec);
  const anon = via.endsWith("-anon");
  const viaKey = anon ? via.slice(0, -5) : via;
  const isJpeg = viaKey.startsWith("jpeg");
  const degraded = await degrade(png, viaKey, isJpeg ? "untitled.jpg" : "untitled.png");
  return sigProbeBlob(new Uint8Array(await degraded.arrayBuffer()));
}
async function pngCheck(bits) {
  const out = [];
  for (const b of bits) {
    const frames = 37;
    const bins = 129;
    const levels = new Uint8Array(frames * bins);
    for (let i = 0;i < levels.length; i++)
      levels[i] = i * 7 % 256;
    const spec = {
      meta: { sr: 8000, win: 256, hop: 64, frames, bins, samples: frames * 64, bits: b, ref: 0, exact: false },
      levels,
      phaseCos: null,
      phaseSin: null
    };
    try {
      const blob = await spectrumToPng(spec);
      const { spec: back } = await imageToSpectrum(blob, downloadName("probe", spec.meta));
      out.push(`${b} bit: ${blob.size}B  层级最大偏差 ${levelErr(spec, back)}`);
    } catch (e) {
      out.push(`${b} bit: 失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
function phaseProbe(pcm, sr, win, hop, gamma, seconds = 3) {
  if (gamma !== null)
    TUNE.gamma = gamma;
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * seconds)));
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const pad = new Float64Array(x.length + win);
  for (let i = 0;i < x.length; i++)
    pad[win / 2 + i] = x[i];
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0;f < frames; f++) {
    for (let m = 0;m < win; m++) {
      re[m] = pad[f * hop + m] * w[m];
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0;b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b] ** 2 + im[b] ** 2);
      truth[f * bins + b] = Math.atan2(im[b], re[b]);
    }
  }
  const est = phaseFromMagnitude(mag, frames, bins, win, hop);
  let cr = 0;
  let ci = 0;
  let den0 = 0;
  for (let i = 0;i < mag.length; i++) {
    const wt = mag[i] ** 2;
    const d = est[i] - truth[i];
    cr += wt * Math.cos(d);
    ci += wt * Math.sin(d);
    den0 += wt;
  }
  const k = Math.atan2(ci, cr);
  let num = 0;
  for (let i = 0;i < mag.length; i++) {
    const wt = mag[i] ** 2;
    let d = est[i] - truth[i] - k;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    num += wt * d * d;
  }
  const raw = Math.sqrt((1 - Math.hypot(cr, ci) / den0) * 2);
  const rms = Math.sqrt(num / Math.max(den0, 0.000000000000000000000000000001)) * 180 / Math.PI;
  return `win=${win} hop=${hop} a/M=${(hop / win).toFixed(3)} γ=${TUNE.gamma}  ` + `总误差 ${(raw * 180 / Math.PI).toFixed(0)}°  常数 ${(k * 180 / Math.PI).toFixed(0)}°  ` + `去常数后 ${rms.toFixed(0)}°`;
}
function reconProbe(pcm, sr, win, hop, quant, seconds = 3) {
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * seconds)));
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const padded = x.length + win;
  const pad = new Float64Array(padded);
  for (let i = 0;i < x.length; i++)
    pad[win / 2 + i] = x[i];
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  let mag = new Float64Array(frames * bins);
  const truth = new Float64Array(frames * bins);
  for (let f = 0;f < frames; f++) {
    for (let m = 0;m < win; m++) {
      re[m] = pad[f * hop + m] * w[m];
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0;b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b] ** 2 + im[b] ** 2);
      truth[f * bins + b] = Math.atan2(im[b], re[b]);
    }
  }
  if (quant > 0) {
    let peak = 0;
    for (let i = 0;i < mag.length; i++)
      if (mag[i] > peak)
        peak = mag[i];
    const span = quant * 12;
    const steps = (1 << quant) - 1;
    const lo = Math.log10(Math.max(peak, 0.000000000000000000000000000001)) - span / 20;
    const q = new Float64Array(mag.length);
    for (let i = 0;i < mag.length; i++) {
      const db = 20 * Math.log10(Math.max(mag[i], 0.000000000000000000000000000001));
      const t = Math.round((db - 20 * lo) / span * steps);
      q[i] = Math.pow(10, (20 * lo + Math.max(0, Math.min(steps, t)) / steps * span) / 20);
    }
    mag = q;
  }
  const synth = (ph) => {
    const acc = new Float64Array(padded);
    const cover = new Float64Array(padded);
    for (let f = 0;f < frames; f++) {
      const base = f * bins;
      for (let b = 0;b < bins; b++) {
        re[b] = mag[base + b] * Math.cos(ph[base + b]);
        im[b] = mag[base + b] * Math.sin(ph[base + b]);
      }
      im[0] = 0;
      im[bins - 1] = 0;
      for (let b = 1;b < bins - 1; b++) {
        re[win - b] = re[b];
        im[win - b] = -im[b];
      }
      fft.transform(re, im, true);
      for (let m = 0;m < win; m++) {
        acc[f * hop + m] = acc[f * hop + m] + re[m] * w[m];
        cover[f * hop + m] = cover[f * hop + m] + w[m] * w[m];
      }
    }
    let top = 0;
    for (let i = 0;i < padded; i++)
      if (cover[i] > top)
        top = cover[i];
    const out = new Float64Array(x.length);
    for (let i = 0;i < out.length; i++)
      out[i] = cover[win / 2 + i] > top * 0.05 ? acc[win / 2 + i] / cover[win / 2 + i] : 0;
    return out;
  };
  const gl = (ph, iters) => {
    const cover = new Float64Array(padded);
    for (let f = 0;f < frames; f++)
      for (let m = 0;m < win; m++)
        cover[f * hop + m] = cover[f * hop + m] + w[m] * w[m];
    let top = 0;
    for (let i = 0;i < padded; i++)
      if (cover[i] > top)
        top = cover[i];
    const cur = synth(ph);
    const buf = new Float64Array(padded);
    for (let i = 0;i < x.length; i++)
      buf[win / 2 + i] = cur[i];
    for (let it = 0;it < iters; it++) {
      const acc = new Float64Array(padded);
      const cc = new Float64Array(padded);
      for (let f = 0;f < frames; f++) {
        const base = f * bins;
        for (let m = 0;m < win; m++) {
          re[m] = buf[f * hop + m] * w[m];
          im[m] = 0;
        }
        fft.transform(re, im);
        for (let b = 0;b < bins; b++) {
          const d = Math.sqrt(re[b] ** 2 + im[b] ** 2) || 0.000000000000000000000000000001;
          re[b] = re[b] / d * mag[base + b];
          im[b] = im[b] / d * mag[base + b];
        }
        im[0] = 0;
        im[bins - 1] = 0;
        for (let b = 1;b < bins - 1; b++) {
          re[win - b] = re[b];
          im[win - b] = -im[b];
        }
        fft.transform(re, im, true);
        for (let m = 0;m < win; m++) {
          acc[f * hop + m] = acc[f * hop + m] + re[m] * w[m];
          cc[f * hop + m] = cc[f * hop + m] + w[m] * w[m];
        }
      }
      for (let i = 0;i < padded; i++)
        buf[i] = cc[i] > top * 0.05 ? acc[i] / cc[i] : 0;
    }
    const out = new Float64Array(x.length);
    for (let i = 0;i < out.length; i++)
      out[i] = buf[win / 2 + i];
    return out;
  };
  const rand = () => {
    const p = new Float64Array(mag.length);
    let s = 2654435769;
    for (let i = 0;i < p.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      p[i] = (s >>> 0) / 4294967295 * 2 * Math.PI - Math.PI;
    }
    return p;
  };
  const fit = (y) => {
    const full = new Float64Array(padded);
    for (let i = 0;i < y.length; i++)
      full[win / 2 + i] = y[i];
    let num = 0;
    let den = 0;
    for (let f = 0;f < frames; f++) {
      for (let m = 0;m < win; m++) {
        re[m] = full[f * hop + m] * w[m];
        im[m] = 0;
      }
      fft.transform(re, im);
      for (let b = 0;b < bins; b++) {
        const got = Math.sqrt(re[b] ** 2 + im[b] ** 2);
        num += (got - mag[f * bins + b]) ** 2;
        den += mag[f * bins + b] ** 2;
      }
    }
    return 10 * Math.log10(Math.max(den, 0.000000000000000000000000000001) / Math.max(num, 0.000000000000000000000000000001));
  };
  const pghi = phaseFromMagnitude(mag, frames, bins, win, hop);
  const ref = x;
  const show = (label, y) => {
    const a = align(ref, Float32Array.from(y), Math.min(2048, Math.floor(x.length / 4)));
    const s = spectral(magnitudes(ref, 1024, 256), magnitudes(Float32Array.from(y), 1024, 256));
    return `${label} ${a.snr.toFixed(1)}dB/${a.corr.toFixed(3)}/谱拟合${fit(y).toFixed(1)}`;
  };
  return `win=${win} hop=${hop}${quant ? ` ${quant}bit` : " 未量化"}  ` + [
    show("真相位", synth(truth)),
    show("PGHI", synth(pghi)),
    show("PGHI+GL30", gl(pghi, 30)),
    show("PGHI+GL300", gl(pghi, 300)),
    show("随机+GL300", gl(rand(), 300)),
    show("随机+GL2000", gl(rand(), 2000))
  ].join("  ");
}
function gradProbe(pcm, sr, win, hop) {
  const x = pcm.subarray(0, Math.min(pcm.length, Math.floor(sr * 3)));
  const bins = win / 2 + 1;
  const frames = Math.floor(x.length / hop) + 1;
  const fft = new FFT(win);
  const w = hannWindow(win);
  const pad = new Float64Array(x.length + win);
  for (let i = 0;i < x.length; i++)
    pad[win / 2 + i] = x[i];
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(frames * bins);
  const ph = new Float64Array(frames * bins);
  for (let f = 0;f < frames; f++) {
    for (let m = 0;m < win; m++) {
      re[m] = pad[f * hop + m] * w[m];
      im[m] = 0;
    }
    fft.transform(re, im);
    for (let b = 0;b < bins; b++) {
      mag[f * bins + b] = Math.sqrt(re[b] ** 2 + im[b] ** 2);
      ph[f * bins + b] = Math.atan2(im[b], re[b]);
    }
  }
  let top = 0;
  for (let i = 0;i < mag.length; i++)
    if (mag[i] > top)
      top = mag[i];
  const floor = top * 0.000000000001;
  const slog = new Float64Array(mag.length);
  for (let i = 0;i < mag.length; i++)
    slog[i] = Math.log(Math.max(mag[i], floor));
  const gamma = 0.25645 * win * win;
  const cF = gamma / (hop * win);
  const cT = hop * win / gamma;
  const wrapd = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const stat = (label, get) => {
    let num = 0;
    let den = 0;
    let raw = 0;
    for (let f = 1;f < frames - 1; f++)
      for (let b = 1;b < bins - 1; b++) {
        if (mag[f * bins + b] < top * 0.1)
          continue;
        const v = get(f, b);
        if (v === null)
          continue;
        const d = wrapd(v);
        num += d * d;
        raw += v * v;
        den++;
      }
    return `${label}: 样本 ${den}  梯度 RMS ${Math.sqrt(raw / Math.max(den, 1)).toFixed(2)} rad  残差 ${(Math.sqrt(num / Math.max(den, 1)) * 180 / Math.PI).toFixed(1)}°`;
  };
  const dF = (f, b) => wrapd(ph[f * bins + b + 1] - ph[f * bins + b]) - -cF * (slog[(f + 1) * bins + b] - slog[(f - 1) * bins + b]) / 2;
  const dT = (f, b) => wrapd(ph[(f + 1) * bins + b] - ph[f * bins + b]) - (cT * (slog[f * bins + b + 1] - slog[f * bins + b - 1]) / 2 + 2 * Math.PI * hop * b / win);
  return [stat("频率方向 Δb", dF), stat("时间方向 Δf", dT)];
}
var DEFAULTS = {
  VOICE,
  hopOf,
  winOf,
  dbSpanOf
};
var CASE_TAGS = { FINENESS };
export {
  CASE_TAGS,
  DEFAULTS,
  atRate,
  gradProbe,
  loadAudio,
  phaseProbe,
  pngCheck,
  reconProbe,
  runCase,
  setTune,
  sigProbe,
  sigProbeBlob,
  synthProbe
};

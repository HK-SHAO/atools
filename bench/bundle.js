// src/lib/audio.ts
async function decodeAudioFile(data) {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor)
    throw new Error("这个浏览器不支持 Web Audio");
  const ctx = new Ctor;
  try {
    const buffer = await ctx.decodeAudioData(data.slice(0));
    const tracks = buffer.numberOfChannels;
    const n = buffer.length;
    if (n === 0)
      throw new Error("这段音频是空的");
    const pcm = new Float32Array(n);
    if (tracks === 1) {
      pcm.set(buffer.getChannelData(0));
    } else {
      const parts = [];
      for (let c = 0;c < tracks; c++)
        parts.push(buffer.getChannelData(c));
      for (let c = 0;c < tracks; c++) {
        const src = parts[c];
        for (let i = 0;i < n; i++)
          pcm[i] = pcm[i] + src[i];
      }
      for (let i = 0;i < n; i++)
        pcm[i] = pcm[i] / tracks;
    }
    return { pcm, sr: buffer.sampleRate };
  } catch (e) {
    if (e instanceof Error && /空/.test(e.message))
      throw e;
    throw new Error(`解不出这段音频：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.close();
  }
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
    chunk("IEND", new Uint8Array(0))
  ];
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

// src/lib/params.ts
var FINENESS = [
  { label: "省", win: 256, div: 2 },
  { label: "中", win: 512, div: 2 },
  { label: "细", win: 1024, div: 4 }
];
var VOICE = {
  mode: "compact",
  sr: 8000,
  bits: 4,
  fineness: 0,
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
  rtisiGl: 0
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
    mirror(re, im, full, L);
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
    mirror(re, im, full, L);
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
function mirror(re, im, bins, size) {
  im[0] = 0;
  im[bins - 1] = 0;
  for (let b = 1;b < bins - 1; b++) {
    re[size - b] = re[b];
    im[size - b] = -im[b];
  }
}

// src/lib/spectrum.ts
var BANDS = 4;
var COLOR_BANDS = 2;
var MIN_WIN = 256;
var MAX_WIN = 4096;
var MAX_FRAMES = 20000;
var MAX_PIXELS = 8000000;
var DB_MIN = -120;
var DB_MAX = 0;
var DB_SPAN = DB_MAX - DB_MIN;
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
  const bands = enc.mode === "exact" ? COLOR_BANDS : 1;
  if (frames > MAX_FRAMES)
    throw new Error(`这段会出 ${frames} 帧，超过 ${MAX_FRAMES}：裁剪区间或调低采样率`);
  if (frames * bins * bands > MAX_PIXELS)
    throw new Error("频谱图太大了：调低精度或采样率");
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
    im[0] = 0;
    im[this.bins - 1] = 0;
    for (let b = 1;b < this.bins - 1; b++) {
      re[size - b] = re[b];
      im[size - b] = -im[b];
    }
    this.fft.transform(re, im, true);
    for (let m = 0;m < size; m++)
      acc[start + m] = acc[start + m] + re[m] * win[m];
  }
}
var dbToCode = (db) => {
  const t = (db - DB_MIN) / DB_SPAN * 65535;
  return t <= 0 ? 0 : t >= 65535 ? 65535 : Math.round(t);
};
var codeToDb = (code) => DB_MIN + code / 65535 * DB_SPAN;
var clampByte = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
function levelToDb(level, meta) {
  if (meta.exact)
    return codeToDb(level << 8);
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
  const meta = { sr, win, hop, frames, bins, samples, bits: 0, ref: 0, exact: false, color: false };
  const scale = win / 4;
  let next = 0;
  if (enc.mode === "exact") {
    meta.exact = true;
    meta.color = true;
    const levels = new Uint8Array(frames * bins);
    const fine = new Uint8Array(frames * bins);
    const phaseCos = new Uint8Array(frames * bins);
    const phaseSin = new Uint8Array(frames * bins);
    for (let f = 0;f < frames; f++) {
      core.analyse(x, f * hop);
      const base = f * bins;
      for (let b = 0;b < bins; b++) {
        const re = core.re[b];
        const im = core.im[b];
        const code = dbToCode(20 * Math.log10(Math.sqrt(re * re + im * im) / scale));
        levels[base + b] = code >>> 8;
        fine[base + b] = code & 255;
        const a = Math.atan2(im, re);
        phaseCos[base + b] = clampByte((Math.cos(a) * 0.5 + 0.5) * 255 | 0);
        phaseSin[base + b] = clampByte((Math.sin(a) * 0.5 + 0.5) * 255 | 0);
      }
      if (Date.now() >= next) {
        if (alive && !alive())
          throw new Aborted;
        onProgress?.((f + 1) / frames);
        await yieldToUi();
        next = Date.now() + SLICE_MS;
      }
    }
    return { meta, levels, fine, phaseCos, phaseSin };
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
  return { meta, levels, fine: null, phaseCos: null, phaseSin: null };
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
async function synthesiseExact(meta, levels, fine, phaseCos, phaseSin, alive, onProgress) {
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  const padded = samples + win;
  const acc = new Float64Array(padded);
  const scale = win / 4;
  let next = 0;
  for (let f = 0;f < frames; f++) {
    const base = f * bins;
    for (let b = 0;b < bins; b++) {
      const code = levels[base + b] << 8 | fine[base + b];
      const m = Math.pow(10, codeToDb(code) / 20) * scale;
      const c = (phaseCos[base + b] - 127.5) / 127.5;
      const s = (phaseSin[base + b] - 127.5) / 127.5;
      const a = Math.atan2(s, c);
      core.re[b] = m * Math.cos(a);
      core.im[b] = m * Math.sin(a);
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
async function glRefine(x, target, spec, iters, alive, onProgress) {
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
  const deadline = Date.now() + GL_BUDGET_MS;
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
async function griffinLim(spec, alive, onProgress) {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const core = new Frames(win);
  const full = core.bins;
  const padded = samples + win;
  const scale = win / 4;
  const target = targetOf(spec, scale);
  const acc = new Float64Array(padded);
  const cover = coverage(win, hop, frames, padded);
  let top = 0;
  for (let i = 0;i < padded; i++)
    if (cover[i] > top)
      top = cover[i];
  const floor = top * 0.05;
  const x = new Float64Array(padded);
  if (TUNE.pghi) {
    const start = phaseFromMagnitude(target, frames, bins, win, hop);
    acc.fill(0);
    for (let f = 0;f < frames; f++) {
      const base = f * bins;
      for (let b = 0;b < full; b++) {
        if (b < bins) {
          const a = start[base + b];
          core.re[b] = target[base + b] * Math.cos(a);
          core.im[b] = target[base + b] * Math.sin(a);
        } else {
          core.re[b] = 0;
          core.im[b] = 0;
        }
      }
      core.add(acc, f * hop);
    }
    for (let i = 0;i < padded; i++)
      x[i] = cover[i] > floor ? acc[i] / cover[i] : 0;
  } else {
    let seed = 2654435769;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967295 * 2 * Math.PI - Math.PI;
    };
    for (let i = 0;i < padded; i++)
      x[i] = Math.cos(rand()) * 0.001;
  }
  await glRefine(x, target, spec, TUNE.pghi ? TUNE.iters : 400, alive, onProgress);
  return finish(x, win, samples);
}
async function invert(spec, alive, onProgress) {
  const { meta } = spec;
  const { win, hop, bins, frames, samples } = meta;
  const scale = win / 4;
  const target = targetOf(spec, scale);
  const padded = samples + win;
  const warm = TUNE.pghi ? phaseFromMagnitude(target, frames, bins, win, hop) : null;
  let next = 0;
  const y = await rtisiLa(target, frames, bins, win, hop, samples, {
    iters: TUNE.rtisiIters,
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
  if (TUNE.rtisiGl > 0)
    await glRefine(x, target, spec, TUNE.rtisiGl, alive, onProgress);
  return finish(x, win, samples);
}
async function synthesise(spec, alive, onProgress) {
  const { meta, fine, phaseCos, phaseSin } = spec;
  if (meta.exact && fine && phaseCos && phaseSin)
    return synthesiseExact(meta, spec.levels, fine, phaseCos, phaseSin, alive, onProgress);
  return TUNE.rtisi ? invert(spec, alive, onProgress) : griffinLim(spec, alive, onProgress);
}
function paramsForImage(frames, rows, sr, bits, ref, exact) {
  const clamped = Math.max(2, Math.min(rows, MAX_WIN / 2 + 1));
  const win = pow2(2 * (clamped - 1));
  const bins = Math.min(clamped, win / 2 + 1);
  const hop = Math.max(1, Math.round(win / 4));
  const count = Math.max(1, Math.min(frames, MAX_FRAMES));
  return { sr, win, hop, frames: count, bins, samples: count * hop, bits, ref, exact, color: false };
}

// src/lib/image.ts
var VERSION = 3;
function metaToText(meta) {
  return JSON.stringify([
    VERSION,
    meta.sr,
    meta.win,
    meta.hop,
    meta.frames,
    meta.bins,
    meta.samples,
    meta.bits,
    Math.round(meta.ref * 10) / 10,
    meta.exact ? 1 : 0,
    meta.color ? 1 : 0
  ]);
}
function textToMeta(text) {
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v) || v.length < 10 || v[0] !== VERSION)
      return null;
    const n = v.slice(1).map(Number);
    if (n.some((x) => !Number.isFinite(x)))
      return null;
    const [sr, win, hop, frames, bins, samples, bits, ref, exact, color] = n;
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
      exact: exact === 1,
      color: color === 1
    };
  } catch {
    return null;
  }
}
function metaFromName(name) {
  const m = /_SR(\d+)_N(\d+)_H(\d+)_F(\d+)_L(\d+)(?:_B(\d+))?(?:_C(\d+))?\.(?:png|jpe?g|jpe|webp|avif|bmp|gif)$/i.exec(name);
  if (!m)
    return null;
  const [sr, win, hop, frames, samples, bits, color] = [1, 2, 3, 4, 5, 6, 7].map((i) => m[i] === undefined ? Number.NaN : Number(m[i]));
  if (![sr, win, hop, frames, samples].every((x) => Number.isFinite(x) && x > 0))
    return null;
  if ((win & win - 1) !== 0)
    return null;
  const b = Number.isFinite(bits) ? bits : 0;
  return {
    sr,
    win,
    hop: Math.min(win, hop),
    frames,
    bins: win / 2 + 1,
    samples,
    bits: b,
    ref: 0,
    exact: b === 0,
    color: Number.isFinite(color) ? color === 1 : false
  };
}
function downloadName(base, meta) {
  const stem = base.replace(/\.[^.]+$/, "") || "spectrum";
  return `${stem}_SR${meta.sr}_N${meta.win}_H${meta.hop}_F${meta.frames}_L${meta.samples}_B${meta.bits}_C${meta.color ? 1 : 0}.png`;
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
function toCosSin(cRaw, sRaw) {
  const n = cRaw.length;
  let sum = 0;
  let cnt = 0;
  for (let i = 0;i < n; i += 97) {
    const c = (cRaw[i] - 127.5) / 127.5;
    const s = (sRaw[i] - 127.5) / 127.5;
    sum += c * c + s * s;
    cnt++;
  }
  const mean = cnt ? sum / cnt : 0;
  if (mean > 0.5 && mean < 1.5)
    return { cos: cRaw, sin: sRaw };
  const cos = new Uint8Array(n);
  const sin = new Uint8Array(n);
  for (let i = 0;i < n; i++) {
    const code = cRaw[i] << 8 | sRaw[i];
    const a = code / 65536 * Math.PI * 2 - Math.PI;
    cos[i] = clampByte((Math.cos(a) * 0.5 + 0.5) * 255);
    sin[i] = clampByte((Math.sin(a) * 0.5 + 0.5) * 255);
  }
  return { cos, sin };
}
var MAX_SOURCE_PIXELS = 24000000;
var FOREIGN_FRAMES = 6000;
function surface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx)
    throw new Error("这个浏览器不支持 canvas");
  return { canvas, ctx };
}
function sampleBand(data, width, rowTop, rowCount, frames, bins, pick) {
  const out = new Uint8Array(frames * bins);
  const sx = width / frames;
  const sy = rowCount / bins;
  const rows = new Int32Array(bins);
  for (let b = 0;b < bins; b++) {
    const up = Math.min(rowCount - 1, Math.floor((b + 0.5) * sy));
    rows[b] = rowTop + rowCount - 1 - up;
  }
  for (let f = 0;f < frames; f++) {
    const col = Math.min(width - 1, Math.floor((f + 0.5) * sx)) * 4;
    const base = f * bins;
    for (let b = 0;b < bins; b++) {
      const p = rows[b] * width * 4 + col;
      out[base + b] = pick(data[p], data[p + 1], data[p + 2]);
    }
  }
  return out;
}
function rescaled(meta, width) {
  const frames = Math.max(2, Math.min(width, MAX_FRAMES));
  const hop = Math.max(1, Math.min(meta.win, Math.round(meta.samples / frames)));
  return { ...meta, frames, bins: meta.bins, hop, samples: frames * hop, exact: false };
}
async function imageToSpectrum(file, fileName) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = sniff(bytes);
  const meta = textToMeta(readMeta(bytes) ?? "") ?? metaFromName(fileName);
  const hint = meta;
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
    const h = bitmap.height;
    const pixels = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
    const known = meta !== null;
    const exact = known && meta.exact;
    const geomColor = exact && Math.abs(h - 2 * (meta?.bins ?? 0)) <= Math.abs(h - 4 * (meta?.bins ?? 0));
    const color = exact && (known && meta.color || geomColor);
    const bandRows = exact ? color ? Math.max(1, Math.floor(h / COLOR_BANDS)) : Math.max(1, Math.floor(h / BANDS)) : h;
    const intact = known && w === meta.frames && bandRows === meta.bins;
    if (exact) {
      const frames = known ? Math.min(w, meta.frames) : Math.min(w, FOREIGN_FRAMES);
      const next = intact ? { ...meta, bins: meta.bins } : rescaled(meta, w);
      if (color) {
        const cosRaw = sampleBand(pixels, w, 0, bandRows, frames, next.bins, (r) => r);
        const sinRaw = sampleBand(pixels, w, 0, bandRows, frames, next.bins, (_r, g) => g);
        const levels = sampleBand(pixels, w, 0, bandRows, frames, next.bins, (_r, _g, b) => b);
        const fine = sampleBand(pixels, w, bandRows, bandRows, frames, next.bins, (_r, g) => g);
        const { cos, sin } = toCosSin(cosRaw, sinRaw);
        const mode = intact ? "exact" : "degraded";
        return {
          spec: { meta: { ...next, exact: true, color: true }, levels, fine, phaseCos: cos, phaseSin: sin },
          mode,
          container,
          width: w,
          height: h
        };
      }
      const levels = sampleBand(pixels, w, 0, bandRows, next.frames, next.bins, (r, g, b) => FROM_LUMA[luma(r, g, b)]);
      const fine = sampleBand(pixels, w, bandRows, bandRows, frames, next.bins, (_r, g) => g);
      const cosRaw = sampleBand(pixels, w, 2 * bandRows, bandRows, frames, next.bins, (_r, g) => g);
      const sinRaw = sampleBand(pixels, w, 3 * bandRows, bandRows, frames, next.bins, (_r, g) => g);
      const { cos, sin } = toCosSin(cosRaw, sinRaw);
      const mode = intact ? "exact" : "degraded";
      return {
        spec: { meta: { ...next, exact: true, color: false }, levels, fine, phaseCos: cos, phaseSin: sin },
        mode,
        container,
        width: w,
        height: h
      };
    }
    const frames = known ? Math.min(w, meta.frames) : Math.min(w, FOREIGN_FRAMES);
    const rows = Math.max(2, Math.min(intact ? meta.bins : bandRows, 1025));
    const next = intact ? { ...meta, bins: meta.bins } : meta !== null ? rescaled(meta, w) : paramsForImage(frames, rows, hint?.sr ?? 44100, hint?.bits && hint.bits > 0 ? hint.bits : 8, hint?.ref ?? 0, false);
    const levels = sampleBand(pixels, w, 0, bandRows, next.frames, next.bins, (r, g, b) => FROM_LUMA[luma(r, g, b)]);
    const mode = !known ? "foreign" : intact ? "compact" : "degraded";
    return {
      spec: { meta: next, levels, fine: null, phaseCos: null, phaseSin: null },
      mode,
      container,
      width: w,
      height: h
    };
  } finally {
    bitmap.close();
  }
}
function exactPixels(spec) {
  const { meta, levels, fine, phaseCos, phaseSin } = spec;
  const { frames, bins } = meta;
  if (meta.color) {
    const width = frames;
    const height = COLOR_BANDS * bins;
    const pixels = new Uint8ClampedArray(width * height * 4);
    let p = 0;
    for (let row = 0;row < bins; row++) {
      const b = bins - 1 - row;
      for (let f = 0;f < frames; f++) {
        const i = f * bins + b;
        pixels[p] = phaseCos?.[i] ?? 0;
        pixels[p + 1] = phaseSin?.[i] ?? 0;
        pixels[p + 2] = levels[i] ?? 0;
        pixels[p + 3] = 255;
        p += 4;
      }
    }
    for (let row = 0;row < bins; row++) {
      const b = bins - 1 - row;
      for (let f = 0;f < frames; f++) {
        const v = fine?.[f * bins + b] ?? 0;
        pixels[p] = v;
        pixels[p + 1] = v;
        pixels[p + 2] = v;
        pixels[p + 3] = 255;
        p += 4;
      }
    }
    return { pixels, width, height };
  }
  const width = frames;
  const height = BANDS * bins;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  for (let row = 0;row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0;f < frames; f++) {
      const c = levels[f * bins + b] * 3;
      pixels[p] = RAMP[c];
      pixels[p + 1] = RAMP[c + 1];
      pixels[p + 2] = RAMP[c + 2];
      pixels[p + 3] = 255;
      p += 4;
    }
  }
  const gray = (get) => {
    for (let row = 0;row < bins; row++) {
      const b = bins - 1 - row;
      for (let f = 0;f < frames; f++) {
        const v = get(f * bins + b);
        pixels[p] = v;
        pixels[p + 1] = v;
        pixels[p + 2] = v;
        pixels[p + 3] = 255;
        p += 4;
      }
    }
  };
  gray((i) => fine?.[i] ?? 0);
  gray((i) => phaseCos?.[i] ?? 0);
  gray((i) => phaseSin?.[i] ?? 0);
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
  const packed = new Uint8Array(frames * bins);
  for (let row = 0;row < bins; row++) {
    const b = bins - 1 - row;
    for (let f = 0;f < frames; f++)
      packed[row * frames + f] = indices[f * bins + b];
  }
  const bytes = await indexedPng(packed, frames, bins, depth, palette, metaToText(meta));
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
async function degrade(blob, via, name) {
  if (via === "png")
    return blob;
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const scale = via === "half" ? 0.5 : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = via === "jpeg" || via === "jpeg-anon" ? "image/jpeg" : "image/png";
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
    meta: { sr, win, hop, frames, bins, samples, bits, ref, exact: false, color: false },
    levels,
    fine: null,
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
  if (c.via !== "none") {
    const png = await spectrumToPng(spec);
    const fileName = c.via === "jpeg-anon" ? "untitled.jpg" : downloadName(name, spec.meta);
    const degraded = await degrade(png, c.via, fileName);
    bytes = degraded.size;
    back = (await imageToSpectrum(degraded, fileName)).spec;
  }
  const y = await synthesise(back);
  const ref = tuned.subarray(0, Math.min(tuned.length, y.length));
  const a = align(ref, y, Math.min(2048, Math.floor(ref.length / 4)));
  const win = 1024;
  const hop = 256;
  const s = spectral(magnitudes(ref, win, hop), magnitudes(y, win, hop));
  return {
    file: name,
    case: `${c.mode}/${c.sr || "原"}/${c.bits}b/${FINENESS[c.fineness].label}/${c.via}`,
    ms: Math.round(performance.now() - t0),
    bytes,
    frames: spec.meta.frames,
    bins: spec.meta.bins,
    seconds: Math.round(spec.meta.samples / sr * 10) / 10,
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
async function pngCheck(bits) {
  const out = [];
  for (const b of bits) {
    const frames = 37;
    const bins = 129;
    const levels = new Uint8Array(frames * bins);
    for (let i = 0;i < levels.length; i++)
      levels[i] = i * 7 % 256;
    const spec = {
      meta: { sr: 8000, win: 256, hop: 64, frames, bins, samples: frames * 64, bits: b, ref: 0, exact: false, color: false },
      levels,
      fine: null,
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
  synthProbe
};

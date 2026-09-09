export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.size = size;

    const levels = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
      this.rev[i] = r;
    }

    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const { size: n, rev, cosTable: cos, sinTable: sin } = this;

    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const a = re[i]!;
        re[i] = re[j]!;
        re[j] = a;
        const b = im[i]!;
        im[i] = im[j]!;
        im[j] = b;
      }
    }

    for (let width = 2; width <= n; width *= 2) {
      const half = width / 2;
      const step = n / width;
      for (let base = 0; base < n; base += width) {
        for (let j = base, k = 0; j < base + half; j++, k += step) {
          const p = j + half;
          const c = cos[k]!;
          const s = inverse ? -sin[k]! : sin[k]!;
          const tre = re[p]! * c + im[p]! * s;
          const tim = -re[p]! * s + im[p]! * c;
          re[p] = re[j]! - tre;
          im[p] = im[j]! - tim;
          re[j] = re[j]! + tre;
          im[j] = im[j]! + tim;
        }
      }
    }

    if (inverse)
      for (let i = 0; i < n; i++) {
        re[i] = re[i]! / n;
        im[i] = im[i]! / n;
      }
  }
}

export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

export function mirrorSpectrum(re: Float64Array, im: Float64Array, bins: number, size: number): void {
  im[0] = 0;
  im[bins - 1] = 0;
  for (let b = 1; b < bins - 1; b++) {
    re[size - b] = re[b]!;
    im[size - b] = -im[b]!;
  }
}

import { mustKernel, openJob } from "./dsp";

export const stubRows = (): number => mustKernel().kernel.dsp_stub_rows();

export interface StubInfo {
  width: number;
  sr: number;
  win: number;
  exact: boolean;
}

const unpackStub = (packed: number): StubInfo | null => {
  if (packed === 0) return null;
  const k = mustKernel().kernel;
  return {
    width: packed & 0xffff,
    sr: k.dsp_stub_sr((packed >>> 16) & 0xf),
    win: k.dsp_stub_win((packed >>> 20) & 0x3),
    exact: ((packed >>> 22) & 1) === 1,
  };
};

export function drawStub(
  px: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  sr: number,
  win: number,
  exact: boolean,
): void {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const job = openJob(dsp, 0, k.dsp_stub_paint_bytes(w));
  try {
    if (!k.dsp_stub_paint(job.handle, w, sr, win, exact ? 1 : 0)) return;
    px.set(job.b(), (h - stubRows()) * w * 4);
  } finally {
    job.close();
  }
}

export function stubLuma(w: number, sr: number, win: number, exact: boolean): Uint8Array | null {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const job = openJob(dsp, 0, k.dsp_stub_luma_bytes(w));
  try {
    return k.dsp_stub_luma(job.handle, w, sr, win, exact ? 1 : 0) ? job.b().slice() : null;
  } finally {
    job.close();
  }
}

export function decodeStub(profile: ArrayLike<number>): StubInfo | null {
  const dsp = mustKernel();
  const k = dsp.kernel;
  const n = profile.length;
  const job = openJob(dsp, k.dsp_stub_decode_words(n), 0);
  try {
    job.d().set(profile);
    return unpackStub(k.dsp_stub_decode(job.handle, n));
  } finally {
    job.close();
  }
}

export const stubFits = (w: number): boolean => mustKernel().kernel.dsp_stub_fits(w) === 1;

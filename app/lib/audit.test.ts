import { beforeAll, describe, expect, test } from "bun:test";
import { compileWasm } from "../../scripts/moon";
import type { Samples } from "./arrays";
import { attachKernel, loadDsp } from "./dsp";
import { evaluateRow, sameSpectrum } from "./audit";
import { VOICE } from "./params";
import { resample } from "./resample";
import { encode, synthesise } from "./spectrum";

beforeAll(async () => {
  attachKernel(await loadDsp(compileWasm()));
});

const SR = 8000;

function signal(samples: number, sr: number): Samples {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sr;
    out[i] =
      0.32 * Math.sin(2 * Math.PI * 220 * t) +
      0.2 * Math.sin(2 * Math.PI * (900 + 700 * t) * t) +
      0.008 * Math.sin(2 * Math.PI * 6300 * t);
  }
  return out;
}

// Fine synthesis carries a time budget (glBudgetMs); two runs may drift a little
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

describe("sameSpectrum", () => {
  test("agrees on a match and rejects field by field", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, VOICE);
    expect(sameSpectrum(spec, spec)).toBe(true);

    const levels = spec.levels.slice();
    levels[spec.meta.frames >> 1] = (levels[spec.meta.frames >> 1]! + 7) & 255;
    expect(sameSpectrum(spec, { ...spec, levels })).toBe(false);

    const shifted = { ...spec, meta: { ...spec.meta, frames: spec.meta.frames - 1 } };
    expect(sameSpectrum(spec, shifted)).toBe(false);

    expect(sameSpectrum(spec, { ...spec, phaseCos: new Uint8Array(4) })).toBe(false);
  });
});

describe("evaluateRow cache reuse", () => {
  // Guard semantics: sameSpectrum only proves the read-back spectrum equals the encoded
  // one. That the cached audio is a fine synthesis of the same spectrum comes from the
  // caller contract (useAudit passes only the current job's audio).

  test("matching spectra take the reuse path: a bad cache passes through untouched (a fresh synthesis cannot reach corr≈0)", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, VOICE);
    const cached = await synthesise(spec, undefined, undefined, "fine");

    const reused = await evaluateRow(pcm, spec, spec, cached, false);
    const fresh = await evaluateRow(pcm, spec, spec, null, false);
    for (const key of ["corr", "snr", "lsd"] as const) {
      const tol = key === "corr" ? 0.02 : key === "snr" ? 1 : 0.3;
      expect(
        near(reused[key]!, fresh[key]!, tol),
        `${key}: reused ${reused[key]} vs computed fresh ${fresh[key]}`,
      ).toBe(true);
    }
    expect(reused.level).toBe(0);

    // All-zero cache with matching spectra must take the reuse path (if reuse did not
    // happen, corr would sit near the high fresh value)
    const hit = await evaluateRow(pcm, spec, spec, new Float32Array(cached.length), false);
    expect(hit.corr).toBeLessThan(0.5);
  });

  test("mismatched spectra refuse reuse: a tampered spectrum must be re-synthesised", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, VOICE);
    const levels = spec.levels.slice();
    for (let i = 0; i < levels.length; i += 97) levels[i] = Math.min(255, levels[i]! + 9);
    const tampered = { ...spec, levels };

    // The guard refuses reuse even when the cache passed in is all zeros, and
    // re-synthesises from the tampered spectrum, so the result still tracks the input.
    // A guard that degraded into unconditional reuse would let the zeros drop corr to 0.
    const bad = await evaluateRow(pcm, spec, tampered, new Float32Array(pcm.length), false);
    expect(bad.corr).toBeGreaterThan(0.8);
  });

  test("reversible strong phase takes the exact path: the self-check loses nothing", async () => {
    const pcm = resample(signal(SR * 2, 44100), 44100, SR);
    const spec = await encode(pcm, SR, { ...VOICE, mode: "exact" });
    const row = await evaluateRow(pcm, spec, spec, null, true);
    expect(row.level).toBe(0);
    expect(row.corr).toBeGreaterThan(0.999);
  });
});

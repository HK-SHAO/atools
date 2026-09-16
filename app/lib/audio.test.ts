import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containerRate, decodeAudioFile, sniffAudio } from "./audio";
import type { Samples } from "./arrays";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../..", "fixtures");

const fixtureBytes = async (name: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(join(FIXTURES, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
const ascii = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

describe("sniffAudio (audio container detection)", () => {
  test("both AMR-NB and AMR-WB headers", () => {
    expect(sniffAudio(ascii("#!AMR\n"))).toContain("AMR");
    expect(sniffAudio(ascii("#!AMR-WB\n"))).toContain("AMR");
  });

  test("both SILK headers (WeChat voice notes)", () => {
    expect(sniffAudio(bytes(0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33))).toContain(
      "SILK",
    );
    expect(sniffAudio(ascii("#!SILK_V3"))).toContain("SILK");
  });

  test("3GP (call recordings)", () => {
    const b = new Uint8Array(16);
    b.set(ascii("ftyp"), 4);
    b.set(ascii("3gp5"), 8);
    expect(sniffAudio(b)).toContain("3GP");
  });

  test("M4A (ftyp M4A_)", () => {
    const b = new Uint8Array(16);
    b.set(ascii("ftyp"), 4);
    b.set(ascii("M4A "), 8);
    expect(sniffAudio(b)).toContain("M4A");
  });

  test("WAV / OGG / FLAC / MP3 (ID3 and a bare frame header)", () => {
    expect(sniffAudio(ascii("RIFFxxxxWAVE"))).toContain("WAV");
    expect(sniffAudio(ascii("OggS"))).toContain("OGG");
    expect(sniffAudio(ascii("fLaC"))).toContain("FLAC");
    expect(sniffAudio(ascii("ID3xxxx"))).toContain("MP3");
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90, 0x00))).toContain("MP3");
  });

  test("WebM/MKV (EBML magic) and bare AAC ADTS streams", () => {
    expect(sniffAudio(bytes(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5))).toContain("WebM");
    expect(sniffAudio(bytes(0xff, 0xf1, 0x50, 0x80))).toContain("AAC");
    expect(sniffAudio(bytes(0xff, 0xf9, 0x50, 0x80))).toContain("AAC");
  });

  test("the Ogg container tells Opus from Vorbis by the first packet's magic", () => {
    const ogg = new Uint8Array(40);
    ogg.set(ascii("OggS"));
    ogg.set(ascii("OpusHead"), 28);
    expect(sniffAudio(ogg)).toBe("OGG/Opus");
    const vor = new Uint8Array(40);
    vor.set(ascii("OggS"));
    vor.set(ascii("\x01vorbis"), 28);
    expect(sniffAudio(vor)).toBe("OGG");
  });

  test("unrecognised input returns an empty string", () => {
    expect(sniffAudio(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13))).toBe("");
  });
});

describe("decodeAudioFile (AMR-only decoding)", () => {
  const fixture = () => fixtureBytes("speech-nb.amr");

  test("a real AMR-NB speech sample", async () => {
    const { pcm, sr } = await decodeAudioFile(await fixture());
    expect(sr).toBe(8000);
    expect(pcm.length / sr).toBeGreaterThan(30);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(peak).toBeGreaterThan(0.1);
  });

  test("a truncated AMR decodes on a best-effort basis without throwing", async () => {
    const { pcm, sr } = await decodeAudioFile((await fixture()).slice(0, 2000));
    expect(sr).toBe(8000);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test("synthetic AMR-WB aligns frame by frame (ToC + 23-byte payload = 1 frame, FT0)", async () => {
    const magic = ascii("#!AMR-WB\n");
    const frames = 10;
    const b = new Uint8Array(magic.length + frames * 24);
    b.set(magic);
    for (let i = 0; i < frames; i++) b[magic.length + i * 24] = 0b1100_0000;
    const { pcm, sr } = await decodeAudioFile(b.buffer);
    expect(sr).toBe(16000);
    expect(pcm.length).toBe(frames * 320);
  });

  test("damaged AMR does not crash either (lenient decoding)", async () => {
    const bad = new Uint8Array(64);
    bad.set(ascii("#!AMR\nxxx"));
    const { pcm, sr } = await decodeAudioFile(bad.buffer);
    expect(sr).toBe(8000);
    expect(pcm.length).toBeGreaterThan(0);
  });
});

describe("decodeAudioFile (M4A fallback decoding)", () => {
  const load = fixtureBytes;

  const peakOf = (pcm: Samples): number => {
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    return peak;
  };

  test("AAC-LC m4a", async () => {
    const { pcm, sr } = await decodeAudioFile(await load("aac-lc.m4a"));
    expect(sr).toBe(44100);
    expect(pcm.length / sr).toBeGreaterThan(1.4);
    expect(peakOf(pcm)).toBeGreaterThan(0.5);
  });

  test("HE-AAC (v1) m4a", async () => {
    const { pcm, sr } = await decodeAudioFile(await load("he-aac.m4a"));
    expect(sr).toBe(44100);
    expect(peakOf(pcm)).toBeGreaterThan(0.5);
  });

  test("ALAC m4a (Android Chrome cannot decode it natively, so the fallback has to take over)", async () => {
    const { pcm, sr } = await decodeAudioFile(await load("alac.m4a"));
    expect(sr).toBe(44100);
    expect(pcm.length).toBe(66150);
    expect(peakOf(pcm)).toBeGreaterThan(0.5);
  });
});

describe("decodeAudioFile (fallback matrix across formats)", () => {
  const load = fixtureBytes;

  const peakOf = (pcm: Samples): number => {
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    return peak;
  };

  const ok = (r: { pcm: Samples; sr: number }, sr: number, min = 0.3) => {
    expect(r.sr).toBe(sr);
    expect(r.pcm.length / r.sr).toBeGreaterThan(1.0);
    expect(peakOf(r.pcm)).toBeGreaterThan(min);
  };

  test("mp3 (mpg123 WASM)", async () => ok(await decodeAudioFile(await load("tone.mp3")), 44100));
  test("wav (full PCM fallback)", async () => ok(await decodeAudioFile(await load("tone.wav")), 44100));
  test("flac (libFLAC WASM)", async () => ok(await decodeAudioFile(await load("tone.flac")), 44100));
  test("ogg vorbis", async () =>
    ok(await decodeAudioFile(await load("tone-vorbis.ogg")), 44100));
  test("ogg opus", async () => ok(await decodeAudioFile(await load("tone-opus.ogg")), 48000));
  test("bare ADTS stream (.aac)", async () => ok(await decodeAudioFile(await load("tone.aac")), 44100));

  test("a truncated mp3 decodes on a best-effort basis without throwing", async () => {
    const { pcm, sr } = await decodeAudioFile((await load("tone.mp3")).slice(0, 3000));
    expect(sr).toBe(44100);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test("utterly unrecognised data throws with help text", async () => {
    const junk = new Uint8Array(1024);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    await expect(decodeAudioFile(junk.buffer)).rejects.toThrow("SILK");
  });
});

describe("containerRate (the source's own sample rate)", () => {
  const load = async (name: string): Promise<Uint8Array> =>
    new Uint8Array(await fixtureBytes(name));

  const rateOf = async (name: string): Promise<number | null> => {
    const b = await load(name);
    return containerRate(sniffAudio(b), b);
  };

  test("the five containers that declare a rate must read back what decoding really gives", async () => {
    for (const [file, sr] of [
      ["tone.wav", 44100],
      ["tone.mp3", 44100],
      ["tone.flac", 44100],
      ["tone-vorbis.ogg", 44100],
      ["tone-opus.ogg", 48000],
    ] as const)
      expect([file, await rateOf(file)]).toEqual([file, sr]);
  });

  test("M4A/MP4 is not read (on HE-AAC the container states the core rate, and building from it drops the high band)", async () => {
    expect(await rateOf("aac-lc.m4a")).toBeNull();
    expect(await rateOf("he-aac.m4a")).toBeNull();
    expect(await rateOf("alac.m4a")).toBeNull();
  });

  test("unrecognised containers and unreadable fields are always null (falling back to the default context)", async () => {
    expect(await containerRate("SILK", new Uint8Array(64))).toBeNull();
    expect(await containerRate("AAC/ADTS", new Uint8Array(64))).toBeNull();
    expect(await containerRate("WAV", ascii("RIFFxxxxWAVE"))).toBeNull();
    expect(await containerRate("MP3", new Uint8Array(0))).toBeNull();
    const junk = new Uint8Array(1024);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    for (const head of ["WAV", "MP3", "FLAC", "OGG", "OGG/Opus", "M4A/MP4"])
      expect([head, await containerRate(head, junk)]).toEqual([head, null]);
  });

  const frame = (version: number, layer: number, rateIdx: number): Uint8Array =>
    bytes(0xff, 0xe0 | (version << 3) | (layer << 1) | 1, rateIdx << 2, 0);

  const bySniff = (b: Uint8Array): Promise<number | null> => containerRate(sniffAudio(b), b);

  test("mp3 frame headers: each version family has its own sample-rate ladder", async () => {
    expect(await bySniff(frame(3, 1, 0))).toBe(44100);
    expect(await bySniff(frame(3, 1, 1))).toBe(48000);
    expect(await bySniff(frame(3, 1, 2))).toBe(32000);
    expect(await bySniff(frame(2, 1, 0))).toBe(22050);
    expect(await bySniff(frame(2, 1, 1))).toBe(24000);
    expect(await bySniff(frame(2, 1, 2))).toBe(16000);
    expect(await bySniff(frame(0, 1, 0))).toBe(11025);
    expect(await bySniff(frame(0, 1, 1))).toBe(12000);
    expect(await bySniff(frame(0, 1, 2))).toBe(8000);
  });

  test("reserved values in an mp3 frame header do not count", async () => {
    expect(await bySniff(frame(1, 1, 0))).toBeNull();
    expect(await containerRate("MP3", frame(3, 0, 0))).toBeNull();
    expect(await bySniff(frame(3, 1, 3))).toBeNull();
  });

  test("the whole ID3 tag is skipped, so a fake sync inside it does not count", async () => {
    const fake = frame(3, 1, 0);
    const real = frame(3, 1, 1);
    const tag = new Uint8Array(10 + fake.length);
    tag.set(ascii("ID3"));
    tag[3] = 3;
    tag[7] = (fake.length >> 14) & 0x7f;
    tag[8] = (fake.length >> 7) & 0x7f;
    tag[9] = fake.length & 0x7f;
    tag.set(fake, 10);

    const file = new Uint8Array(tag.length + real.length);
    file.set(tag);
    file.set(real, tag.length);
    expect(await containerRate(sniffAudio(file), file)).toBe(48000);
  });
});

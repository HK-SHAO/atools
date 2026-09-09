import { describe, expect, test } from "bun:test";
import { decodeAudioFile, sniffAudio } from "./audio";
import type { Samples } from "./arrays";

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
const ascii = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

describe("sniffAudio（音频容器识别）", () => {
  test("AMR-NB 与 AMR-WB 两种头", () => {
    expect(sniffAudio(ascii("#!AMR\n"))).toContain("AMR");
    expect(sniffAudio(ascii("#!AMR-WB\n"))).toContain("AMR");
  });

  test("SILK 两种头（微信语音）", () => {
    expect(sniffAudio(bytes(0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33))).toContain(
      "SILK",
    );
    expect(sniffAudio(ascii("#!SILK_V3"))).toContain("SILK");
  });

  test("3GP（通话录音）", () => {
    const b = new Uint8Array(16);
    b.set(ascii("ftyp"), 4);
    b.set(ascii("3gp5"), 8);
    expect(sniffAudio(b)).toContain("3GP");
  });

  test("M4A（ftyp M4A_）", () => {
    const b = new Uint8Array(16);
    b.set(ascii("ftyp"), 4);
    b.set(ascii("M4A "), 8);
    expect(sniffAudio(b)).toContain("M4A");
  });

  test("WAV / OGG / FLAC / MP3(ID3 与裸帧头)", () => {
    expect(sniffAudio(ascii("RIFFxxxxWAVE"))).toContain("WAV");
    expect(sniffAudio(ascii("OggS"))).toContain("OGG");
    expect(sniffAudio(ascii("fLaC"))).toContain("FLAC");
    expect(sniffAudio(ascii("ID3xxxx"))).toContain("MP3");
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90, 0x00))).toContain("MP3");
  });

  test("WebM/MKV（EBML 魔数）与 AAC ADTS 裸流", () => {
    expect(sniffAudio(bytes(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5))).toContain("WebM");
    expect(sniffAudio(bytes(0xff, 0xf1, 0x50, 0x80))).toContain("AAC");
    expect(sniffAudio(bytes(0xff, 0xf9, 0x50, 0x80))).toContain("AAC");
  });

  test("认不出的返回空串", () => {
    expect(sniffAudio(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13))).toBe("");
  });
});

describe("decodeAudioFile（AMR 专用解码）", () => {
  const fixture = () =>
    Bun.file(new URL("./fixtures/speech-nb.amr", import.meta.url)).arrayBuffer();

  test("真实 AMR-NB 语音样本", async () => {
    const { pcm, sr } = await decodeAudioFile(await fixture());
    expect(sr).toBe(8000);
    expect(pcm.length / sr).toBeGreaterThan(30);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(peak).toBeGreaterThan(0.1);
  });

  test("截断的 AMR 尽力解码、不抛错", async () => {
    const { pcm, sr } = await decodeAudioFile((await fixture()).slice(0, 2000));
    expect(sr).toBe(8000);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test("合成 AMR-WB 逐帧对齐（ToC + 23 字节载荷 = 1 帧，FT0）", async () => {
    const magic = ascii("#!AMR-WB\n");
    const frames = 10;
    const b = new Uint8Array(magic.length + frames * 24);
    b.set(magic);
    for (let i = 0; i < frames; i++) b[magic.length + i * 24] = 0b1100_0000;
    const { pcm, sr } = await decodeAudioFile(b.buffer);
    expect(sr).toBe(16000);
    expect(pcm.length).toBe(frames * 320);
  });

  test("损坏的 AMR 也不崩溃（宽容解码）", async () => {
    const bad = new Uint8Array(64);
    bad.set(ascii("#!AMR\nxxx"));
    const { pcm, sr } = await decodeAudioFile(bad.buffer);
    expect(sr).toBe(8000);
    expect(pcm.length).toBeGreaterThan(0);
  });
});

describe("decodeAudioFile（M4A 兜底解码）", () => {
  // Bun 无 Web Audio，原生路径恒失败 —— 走到的都是 WASM 兜底引擎（FAAD2 / ALAC）。
  // 浏览器里的原生路径与兜底切换由评测台端到端覆盖。
  async function load(name: string): Promise<ArrayBuffer> {
    return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer();
  }

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

  test("ALAC m4a（安卓 Chrome 原生解不出，兜底必须接管）", async () => {
    const { pcm, sr } = await decodeAudioFile(await load("alac.m4a"));
    expect(sr).toBe(44100);
    expect(pcm.length).toBe(66150);
    expect(peakOf(pcm)).toBeGreaterThan(0.5);
  });
});

describe("decodeAudioFile（全格式兜底矩阵）", () => {
  // Bun 无 Web Audio，原生路径恒失败 —— 下面每个夹具都只走 WASM 兜底引擎，
  // 等价于「最坏浏览器」（原生全拒）下的解码链路。
  async function load(name: string): Promise<ArrayBuffer> {
    return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer();
  }

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

  test("mp3（mpg123 WASM）", async () => ok(await decodeAudioFile(await load("tone.mp3")), 44100));
  test("wav（PCM 全量兜底）", async () => ok(await decodeAudioFile(await load("tone.wav")), 44100));
  test("flac（libFLAC WASM）", async () => ok(await decodeAudioFile(await load("tone.flac")), 44100));
  test("ogg vorbis", async () =>
    ok(await decodeAudioFile(await load("tone-vorbis.ogg")), 44100));
  test("ogg opus", async () => ok(await decodeAudioFile(await load("tone-opus.ogg")), 48000));
  test("webm opus（EBML 容器）", async () =>
    ok(await decodeAudioFile(await load("voice.webm")), 48000));
  test("adts 裸流（.aac）", async () => ok(await decodeAudioFile(await load("tone.aac")), 44100));
  test("3gp 容器内 AMR（mp4 demuxer 路由）", async () =>
    ok(await decodeAudioFile(await load("call.3gp")), 8000, 0.05));

  test("截断的 mp3 尽力解码、不抛错", async () => {
    const { pcm, sr } = await decodeAudioFile((await load("tone.mp3")).slice(0, 3000));
    expect(sr).toBe(44100);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test("彻底认不出的数据报错且带帮助文案", async () => {
    const junk = new Uint8Array(1024);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    expect(decodeAudioFile(junk.buffer)).rejects.toThrow("SILK");
  });
});

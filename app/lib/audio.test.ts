import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { containerRate, decodeAudioFile, sniffAudio } from "./audio";
import type { Samples } from "./arrays";

/** 夹具字节。用 node:fs 而不是 `Bun.file` —— 测试链跑在 vitest（Node）上。 */
const fixtureBytes = async (name: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

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

  test("Ogg 容器按首包魔数区分 Opus / Vorbis", () => {
    const ogg = new Uint8Array(40);
    ogg.set(ascii("OggS"));
    ogg.set(ascii("OpusHead"), 28);
    expect(sniffAudio(ogg)).toBe("OGG/Opus");
    const vor = new Uint8Array(40);
    vor.set(ascii("OggS"));
    vor.set(ascii("\x01vorbis"), 28);
    expect(sniffAudio(vor)).toBe("OGG");
  });

  test("认不出的返回空串", () => {
    expect(sniffAudio(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13))).toBe("");
  });
});

describe("decodeAudioFile（AMR 专用解码）", () => {
  const fixture = () => fixtureBytes("speech-nb.amr");

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

  test("ALAC m4a（安卓 Chrome 原生解不出，兜底必须接管）", async () => {
    const { pcm, sr } = await decodeAudioFile(await load("alac.m4a"));
    expect(sr).toBe(44100);
    expect(pcm.length).toBe(66150);
    expect(peakOf(pcm)).toBeGreaterThan(0.5);
  });
});

describe("decodeAudioFile（全格式兜底矩阵）", () => {
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

  test("mp3（mpg123 WASM）", async () => ok(await decodeAudioFile(await load("tone.mp3")), 44100));
  test("wav（PCM 全量兜底）", async () => ok(await decodeAudioFile(await load("tone.wav")), 44100));
  test("flac（libFLAC WASM）", async () => ok(await decodeAudioFile(await load("tone.flac")), 44100));
  test("ogg vorbis", async () =>
    ok(await decodeAudioFile(await load("tone-vorbis.ogg")), 44100));
  test("ogg opus", async () => ok(await decodeAudioFile(await load("tone-opus.ogg")), 48000));
  test("adts 裸流（.aac）", async () => ok(await decodeAudioFile(await load("tone.aac")), 44100));

  test("截断的 mp3 尽力解码、不抛错", async () => {
    const { pcm, sr } = await decodeAudioFile((await load("tone.mp3")).slice(0, 3000));
    expect(sr).toBe(44100);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test("彻底认不出的数据报错且带帮助文案", async () => {
    const junk = new Uint8Array(1024);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    await expect(decodeAudioFile(junk.buffer)).rejects.toThrow("SILK");
  });
});

describe("containerRate（素材自己的采样率）", () => {
  const load = async (name: string): Promise<Uint8Array> =>
    new Uint8Array(await fixtureBytes(name));

  const rateOf = async (name: string): Promise<number | null> => {
    const b = await load(name);
    return containerRate(sniffAudio(b), b);
  };

  // 每个容器的真素材。右边那个数就是各 decodeAudioFile 用例里 decoder 报出来的采样率 ——
  // 「按容器读出来的」与「真解出来的」对不上，就等于白按它建了一次上下文。
  test("容器里写着采样率的五种，读出来都要等于真解出来的", async () => {
    for (const [file, sr] of [
      ["tone.wav", 44100],
      ["tone.mp3", 44100],
      ["tone.flac", 44100],
      ["tone-vorbis.ogg", 44100],
      ["tone-opus.ogg", 48000],
    ] as const)
      expect([file, await rateOf(file)]).toEqual([file, sr]);
  });

  // M4A 是刻意不读的：它的 mp4a 条目在 HE-AAC 上写的是核速率（22050），照它建上下文会
  // 把 SBR 的高频带压没。所以这两个样本必须返回 null —— 不是读不出来，是不敢读。
  test("M4A/MP4 不读（HE-AAC 上容器写的是核速率，照它建会丢高频带）", async () => {
    expect(await rateOf("aac-lc.m4a")).toBeNull();
    expect(await rateOf("he-aac.m4a")).toBeNull();
    expect(await rateOf("alac.m4a")).toBeNull();
  });

  test("认不出的容器与读不出的字段一律 null（退回默认上下文）", async () => {
    expect(await containerRate("SILK（微信语音专有）", new Uint8Array(64))).toBeNull();
    expect(await containerRate("AAC（ADTS 裸流）", new Uint8Array(64))).toBeNull();
    expect(await containerRate("WAV", ascii("RIFFxxxxWAVE"))).toBeNull();
    expect(await containerRate("MP3", new Uint8Array(0))).toBeNull();
    const junk = new Uint8Array(1024);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    for (const head of ["WAV", "MP3", "FLAC", "OGG", "OGG/Opus", "M4A/MP4"])
      expect([head, await containerRate(head, junk)]).toEqual([head, null]);
  });

  /** 帧头四字节：同步 + 版本 + 层 + 采样率索引（码率索引随便填，本函数不看它）。 */
  const frame = (version: number, layer: number, rateIdx: number): Uint8Array =>
    bytes(0xff, 0xe0 | (version << 3) | (layer << 1) | 1, rateIdx << 2, 0);

  const bySniff = (b: Uint8Array): Promise<number | null> => containerRate(sniffAudio(b), b);

  test("mp3 帧头：三个版本族各自的采样率梯子", async () => {
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

  // 层位 00 的字节同时被 sniffAudio 认成 ADTS 裸流，所以这一条直接点名容器，绕过嗅探。
  test("mp3 帧头的保留值不算数", async () => {
    expect(await bySniff(frame(1, 1, 0))).toBeNull(); // 版本位 01 保留
    expect(await containerRate("MP3", frame(3, 0, 0))).toBeNull(); // 层位 00 保留
    expect(await bySniff(frame(3, 1, 3))).toBeNull(); // 采样率索引 11 保留
  });

  test("ID3 标签整段跨过去，正文里的假同步不算数", async () => {
    const fake = frame(3, 1, 0); // 44100，藏在 ID3 正文里
    const real = frame(3, 1, 1); // 48000，真正的第一帧
    const tag = new Uint8Array(10 + fake.length);
    tag.set(ascii("ID3"));
    tag[3] = 3; // v2.3
    tag[7] = (fake.length >> 14) & 0x7f; // 同步安全整数：每字节 7 位
    tag[8] = (fake.length >> 7) & 0x7f;
    tag[9] = fake.length & 0x7f;
    tag.set(fake, 10);

    const file = new Uint8Array(tag.length + real.length);
    file.set(tag);
    file.set(real, tag.length);
    expect(await containerRate(sniffAudio(file), file)).toBe(48000);
  });
});

import { describe, expect, test } from "bun:test";
import { decodeAudioFile, sniffAudio } from "./audio";

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

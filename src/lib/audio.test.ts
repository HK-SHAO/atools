import { describe, expect, test } from "bun:test";
import { sniffAudio } from "./audio";

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
const ascii = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

describe("sniffAudio（音频容器识别）", () => {
  test("AMR（微信等语音常用）", () => {
    expect(sniffAudio(ascii("#!AMR\n"))).toContain("AMR");
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

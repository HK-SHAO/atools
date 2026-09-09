// docs 音频的解码缓存：无头 Chromium 快照没有 AAC 等专有编解码，m4a 整曲走
// WASM 解码要几分钟，且每次评测重复付出。这里用 bun 侧解码一次、按文件内容
// （路径 + mtime + size）落盘 f32 PCM，之后评测直接读缓存。只缓存前
// PRECACHE_SEC 秒（评测只用开头若干秒）。
import { mkdirSync, statSync } from "node:fs";
import { decodeAudioFile } from "../src/lib/audio";

export const CACHE_DIR = `${import.meta.dir}/.cache`;
const PRECACHE_SEC = Number(process.env.PRECACHE_SEC ?? 30);

export function cachePath(rel: string): string {
  const st = statSync(`${import.meta.dir}/../docs/${rel}`);
  const key = new Bun.CryptoHasher("sha1")
    .update(`${rel}|${st.mtimeMs}|${st.size}`)
    .digest("hex");
  return `${CACHE_DIR}/${key}.pcm`;
}

export async function ensureCached(rels: string[]): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const rel of rels) {
    const path = cachePath(rel);
    if (await Bun.file(path).exists()) continue;
    const t = Date.now();
    const { pcm, sr } = await decodeAudioFile(
      await Bun.file(`${import.meta.dir}/../docs/${rel}`).arrayBuffer(),
    );
    const head = Math.min(pcm.length, PRECACHE_SEC * sr);
    const out = new Uint8Array(4 + head * 4);
    new DataView(out.buffer).setUint32(0, sr, true);
    new Float32Array(out.buffer, 4).set(pcm.subarray(0, head));
    await Bun.write(path, out);
    console.log(
      `  缓存 ${rel}  ${sr}Hz ${(head / sr).toFixed(1)}s（解码 ${((Date.now() - t) / 1000).toFixed(1)}s）`,
    );
  }
}

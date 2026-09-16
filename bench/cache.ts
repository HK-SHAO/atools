import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { decodeAudioFile } from "../app/lib/audio.ts";

const CACHE_DIR = `${import.meta.dirname}/.cache`;
const PRECACHE_SEC = Number(process.env.PRECACHE_SEC ?? 30);

export function cachePath(rel: string): string {
  const st = statSync(`${import.meta.dirname}/../docs/${rel}`);
  const key = createHash("sha1").update(`${rel}|${st.mtimeMs}|${st.size}`).digest("hex");
  return `${CACHE_DIR}/${key}.pcm`;
}

const arrayBuffer = async (path: string): Promise<ArrayBuffer> => {
  const raw = await readFile(path);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
};

export async function ensureCached(rels: string[]): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const rel of rels) {
    const path = cachePath(rel);
    if (await stat(path).catch(() => null)) continue;
    const t = Date.now();
    const { pcm, sr } = await decodeAudioFile(await arrayBuffer(`${import.meta.dirname}/../docs/${rel}`));
    const head = Math.min(pcm.length, PRECACHE_SEC * sr);
    const out = new Uint8Array(4 + head * 4);
    new DataView(out.buffer).setUint32(0, sr, true);
    new Float32Array(out.buffer, 4).set(pcm.subarray(0, head));
    await writeFile(path, out);
    console.log(
      `  cached ${rel}  ${sr}Hz ${(head / sr).toFixed(1)}s (decoded in ${((Date.now() - t) / 1000).toFixed(1)}s)`,
    );
  }
}

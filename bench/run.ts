import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cachePath, ensureCached } from "./cache.ts";
import { open, serve, sleep, waitFor } from "./cdp.ts";
import type { Row } from "./entry.ts";

const PORT = Number(process.env.BENCH_PORT ?? 4330);
const MAX_SEC = Number(process.env.MAX_SEC ?? 8);
const OUT = process.env.OUT ?? "/tmp/bench.json";
const AUDIO_EXT = new Set([".mp3", ".m4a", ".ogg", ".wav"]);

const built = await Bun.build({
  entrypoints: [`${import.meta.dirname}/entry.ts`],
  target: "browser",
  naming: "bundle.[ext]",
});
if (!built.success) throw new AggregateError(built.logs, "bench bundle build failed");

function discover(): string[] {
  const docs = `${import.meta.dirname}/../docs`;
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(`${docs}/${rel}`, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (AUDIO_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) out.push(`${rel}/${e.name}`);
    }
  };
  for (const g of readdirSync(docs, { withFileTypes: true })) if (g.isDirectory()) walk(g.name);
  return out.sort();
}

const list = process.env.FILES ? process.env.FILES.split(",").filter(Boolean) : discover();
await ensureCached(list);

const CASES = JSON.parse(
  process.env.CASES ??
    JSON.stringify([
      { sr: 8000, bits: 4, fineness: 0, fmax: 0, mode: "compact", via: "png" },
      { sr: 8000, bits: 4, fineness: 0, fmax: 0, mode: "compact", via: "jpeg" },
      { sr: 8000, bits: 4, fineness: 0, fmax: 0, mode: "compact", via: "half" },
      { sr: 8000, bits: 8, fineness: 1, fmax: 0, mode: "compact", via: "png" },
      { sr: 16000, bits: 6, fineness: 1, fmax: 0, mode: "compact", via: "png" },
      { sr: 0, bits: 8, fineness: 1, fmax: 0, mode: "exact", via: "png" },
      { sr: 0, bits: 8, fineness: 1, fmax: 0, mode: "exact", via: "jpeg" },
      { sr: 0, bits: 8, fineness: 1, fmax: 0, mode: "exact", via: "s75" },
      { sr: 0, bits: 8, fineness: 1, fmax: 0, mode: "exact", via: "s90" },
    ]),
);

const files: Record<string, string | Uint8Array> = {
  "/": new Uint8Array(await readFile(`${import.meta.dirname}/index.html`)),
};
for (const output of built.outputs)
  files[`/${path.basename(output.path)}`] = new Uint8Array(await output.arrayBuffer());
for (const rel of list) {
  files[`/audio/${rel}`] = `${import.meta.dirname}/../docs/${rel}`;
  files[`/pcm/${rel}`] = cachePath(rel);
}

const server = serve(PORT, { files });

const session = await open({
  port: PORT + 1000,
  size: [1200, 900],
  url: `http://127.0.0.1:${PORT}/${process.env.SYNTH_MODE === "fine" ? "?synth=fine" : ""}`,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

const errors: string[] = [];
session.on(m => {
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
    console.error(
      "[page]",
      (m.params.args ?? []).map((a: any) => a.description ?? JSON.stringify(a.value) ?? "").join(" "),
    );
  if (m.method === "Runtime.exceptionThrown")
    errors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "");
});

const ev = session.ev;
const rows: Row[] = [];

const load = async (file: string): Promise<[number, number]> => {
  await ev(`window.__src = await Bench.loadAudio(${JSON.stringify(`/audio/${file}`)});`);
  return ev<[number, number]>("return [window.__src.sr, window.__src.pcm.length]");
};

const HEAD = `window.__src.pcm.subarray(0, Math.min(window.__src.pcm.length, ${MAX_SEC} * window.__src.sr))`;

try {
  await waitFor("bench bundle", async () => ((await ev("return typeof Bench")) === "object" ? true : null));

  for (const file of list) {
    const [sr, samples] = await load(file);
    const tune = process.env.TUNE ? JSON.parse(process.env.TUNE) : null;
    if (tune) await ev(`Bench.setTune(${JSON.stringify(tune)})`);
    console.log(`\n── ${file}  ${sr}Hz  ${(samples / sr).toFixed(1)}s`);
    for (const c of CASES) {
      const row = await ev<Row>(
        `return await Bench.runCase(${HEAD}, window.__src.sr, ${JSON.stringify(
          file.split("/").pop(),
        )}, ${JSON.stringify(c)}, ${JSON.stringify(file.split("/")[0] ?? "")})`,
      );
      rows.push(row);
      const m = row.m;
      console.log(
        `  ${row.case.padEnd(26)} ${String(row.frames).padStart(5)}×${String(row.bins).padStart(4)}` +
          `  ${String(Math.round(row.bytes / 1024)).padStart(4)}KB` +
          `  SNR ${String(m.snr).padStart(6)}  corr ${m.corr.toFixed(3)}` +
          `  conv ${String(m.conv).padStart(6)}  LSD ${String(m.lsd).padStart(5)}` +
          `  mag ${String(m.magSnr).padStart(6)}  level gap ${String(m.levelGap).padStart(3)}` +
          `  read mode ${row.readMode || "-"}` +
          `  phase reliability ${row.rel === null ? "-" : row.rel.toFixed(2)}` +
          `  ${row.ms}ms`,
      );
    }
  }

  console.log("\nPNG check:", await ev<string[]>("return await Bench.pngCheck([1,2,4,6,8])"));
  await writeFile(OUT, JSON.stringify(rows, null, 2));
  console.log("\nerrs:", errors.length ? errors.slice(0, 3).join(" | ") : "(none)");
} finally {
  await session.stop();
  server.stop();
  await sleep(300);
}

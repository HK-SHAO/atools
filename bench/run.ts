import { readdirSync } from "node:fs";
import { ensureCached } from "./cache";
import { open, sleep, waitFor } from "./cdp";
import type { Row } from "./entry";

const PORT = Number(process.env.BENCH_PORT ?? 4330);
const MAX_SEC = Number(process.env.MAX_SEC ?? 8);
const OUT = process.env.OUT ?? "/tmp/bench.json";
const AUDIO_EXT = new Set([".mp3", ".m4a", ".ogg", ".wav"]);

const built = await Bun.build({ entrypoints: [`${import.meta.dir}/entry.ts`], target: "browser" });
if (!built.success) throw new AggregateError(built.logs, "bench bundle 构建失败");
await Bun.write(`${import.meta.dir}/bundle-${PORT}.js`, built.outputs[0]!);

function discover(): string[] {
  const docs = `${import.meta.dir}/../docs`;
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

const server = Bun.spawn([process.execPath, `${import.meta.dir}/serve.ts`], {
  env: { ...process.env, PORT: String(PORT) },
  stdout: "ignore",
  stderr: "inherit",
});

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
  await ev(`return (window.__src = await Bench.loadAudio(${JSON.stringify(`/audio/${file}`)}));`);
  return ev<[number, number]>("return [window.__src.sr, window.__src.pcm.length]");
};

const HEAD = `window.__src.pcm.subarray(0, Math.min(window.__src.pcm.length, ${MAX_SEC} * window.__src.sr))`;

const probes = async (samples: string): Promise<void> => {
  const sr = await ev<number>("return window.__src.sr");

  if (process.env.SYNTH) {
    await ev("window.__p8 = Bench.atRate(window.__src.pcm, window.__src.sr, 8000)");
    for (const [win, hop] of JSON.parse(process.env.SYNTH) as [number, number][])
      for (const q of [4, 8])
        console.log("   ", await ev(`return await Bench.synthProbe(window.__p8.pcm, 8000, ${win}, ${hop}, ${q})`));
  }

  if (process.env.RECON) {
    await ev("window.__p8 = Bench.atRate(window.__src.pcm, window.__src.sr, 8000)");
    for (const [win, hop] of [
      [256, 128],
      [256, 64],
      [256, 32],
      [256, 16],
      [512, 128],
      [512, 64],
    ] as [number, number][])
      for (const q of [0, 4])
        console.log("   ", await ev(`return Bench.reconProbe(window.__p8.pcm, 8000, ${win}, ${hop}, ${q})`));
  }

  if (process.env.PHASE)
    for (const [win, hop] of [
      [256, 128],
      [256, 64],
      [256, 32],
      [256, 16],
      [512, 256],
      [512, 128],
      [512, 64],
      [1024, 256],
    ] as [number, number][])
      console.log("   ", await ev(`return Bench.phaseProbe(window.__src.pcm, ${sr}, ${win}, ${hop}, 0.25645)`));

  if (process.env.GRAD)
    for (const [win, hop] of [
      [256, 64],
      [256, 128],
    ] as [number, number][])
      console.log(`win=${win} hop=${hop}`, await ev(`return Bench.gradProbe(window.__src.pcm, ${sr}, ${win}, ${hop})`));

  if (process.env.SIG)
    for (const via of JSON.parse(process.env.SIG) as string[])
      console.log(
        "  签名",
        via.padEnd(12),
        await ev(`return await Bench.sigProbe(${samples}, window.__src.sr, ${JSON.stringify(via)})`),
      );
};

try {
  await waitFor("bench bundle", async () => ((await ev("return typeof Bench")) === "object" ? true : null));

  if (process.env.NEURAL) {
    await ev(`Bench.setNeural(${JSON.stringify(await Bun.file(process.env.NEURAL).json())})`);
    console.log("神经修正已启用:", process.env.NEURAL);
  }

  if (process.env.DATA) {
    const dir = `${import.meta.dir}/.data`;
    for (const file of list) {
      await ev(`return (window.__src = await Bench.loadAudio(${JSON.stringify(`/audio/${file}`)}));`);
      const tag = file.replaceAll("/", "_").replace(/\.[^.]+$/, "");
      for (const via of JSON.parse(process.env.DATA) as string[]) {
        const b64 = await ev<string>(
          `return await Bench.dumpPair(${HEAD}, window.__src.sr, ${JSON.stringify({
            sr: 0,
            bits: 8,
            fineness: 1,
            fmax: 0,
            mode: "exact",
            via,
          })})`,
        );
        if (!b64) {
          console.log(`  跳过 ${tag}.${via}（读回无相位）`);
          continue;
        }
        await Bun.write(`${dir}/${tag}.${via}.bin`, Buffer.from(b64, "base64"));
        console.log(`  ${tag}.${via}.bin`);
      }
    }
  } else {
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
            `  SNR ${String(m.snr).padStart(6)}  相关 ${m.corr.toFixed(3)}` +
            `  收敛 ${String(m.conv).padStart(6)}  LSD ${String(m.lsd).padStart(5)}` +
            `  幅度 ${String(m.magSnr).padStart(6)}  层级偏差 ${String(m.levelErr).padStart(3)}` +
            `  认图 ${row.readMode || "-"}` +
            `  相位可靠 ${row.rel === null ? "-" : row.rel.toFixed(2)}` +
            `  ${row.ms}ms`,
        );
      }
      await probes(HEAD);
    }

    console.log("\nPNG 体检:", await ev<string[]>("return await Bench.pngCheck([1,2,4,6,8])"));
    await Bun.write(OUT, JSON.stringify(rows, null, 2));
    console.log("\nerrs:", errors.length ? errors.slice(0, 3).join(" | ") : "(none)");
  }
} finally {
  await session.stop();
  server.kill();
  await sleep(300);
}

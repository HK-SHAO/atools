const PORT = Number(process.env.BENCH_PORT ?? 4330);
const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/entry.ts`],
  target: "browser",
});
if (!built.success) throw new AggregateError(built.logs, "bench bundle 构建失败");
// 按端口分文件写 bundle，并行跑多实例时不互相覆盖
await Bun.write(`${import.meta.dir}/bundle-${PORT}.js`, built.outputs[0]!);
const { ensureCached } = await import("./cache");

const CHROME =
  "/Users/sf/.chromium-browser-snapshots/chromium/mac_arm-1684550/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const CDP = PORT + 1000; // 并行跑多实例时从 BENCH_PORT 派生，避免随机碰撞

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const AUDIO_EXT = new Set([".mp3", ".m4a", ".ogg", ".wav"]);

// 默认覆盖 docs/ 下全部音频（voice、ra2、audio-examples…），新加文件自动纳入；
// FILES 环境变量可覆盖为子集。
const FILES =
  process.env.FILES ??
  (() => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const docs = `${import.meta.dir}/../docs`;
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(`${docs}/${rel}`, { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${rel}/${e.name}`);
        else if (AUDIO_EXT.has(e.name.slice(e.name.lastIndexOf("."))))
          out.push(`${rel}/${e.name}`);
      }
    };
    for (const g of readdirSync(docs, { withFileTypes: true }))
      if (g.isDirectory()) walk(g.name);
    return out.sort().join(",");
  })();
const list = FILES.split(",").filter(Boolean);

// 评测前确保 docs 音频的解码缓存齐备（m4a 等在无头浏览器里解码极慢）
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

const MAX_SEC = Number(process.env.MAX_SEC ?? 8);

const server = Bun.spawn([process.execPath, `${import.meta.dir}/serve.ts`], {
  env: { ...process.env, PORT: String(PORT) },
  stdout: "ignore",
  stderr: "inherit",
});
const proc = Bun.spawn(
  [
    CHROME,
    "--headless=new",
    `--remote-debugging-port=${CDP}`,
    "--no-first-run",
    "--no-sandbox",
    "--disable-gpu",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1200,900",
    `--user-data-dir=/tmp/cdp-bench-${Date.now()}`,
    `http://127.0.0.1:${PORT}/${process.env.SYNTH_MODE === "fine" ? "?synth=fine" : ""}`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

async function waitFor<T>(label: string, fn: () => Promise<T | null>, t = 30000): Promise<T> {
  const end = Date.now() + t;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout " + label);
    await sleep(250);
  }
}

try {
  await sleep(1200);
  const wsUrl = await waitFor("target", async () => {
    const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl?: string;
    }[];
    return list.find(x => x.type === "page")?.webSocketDebuggerUrl ?? null;
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, err) => {
    ws.onopen = ok;
    ws.onerror = err;
  });
  let seq = 0;
  const pending = new Map<number, (v: never) => void>();
  const errs: string[] = [];
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as {
      id?: number;
      method?: string;
      result?: unknown;
    params?: {
      exceptionDetails?: { exception?: { description?: string }; text?: string };
      type?: string;
      args?: { value?: unknown; description?: string }[];
    };
  };
  if (m.id !== undefined) pending.get(m.id)?.(m.result as never);
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
    console.error(
      "[page]",
      (m.params.args ?? []).map(a => a.description ?? JSON.stringify(a.value) ?? "").join(" "),
    );
    if (m.method === "Runtime.exceptionThrown")
      errs.push(
        m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "",
      );
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, never>>(res => {
      const id = ++seq;
      pending.set(id, res as never);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression: string) => {
    const r = (await send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
    return r.result?.value;
  };

  await send("Runtime.enable");
  await waitFor("bundle", async () => ((await ev(`return typeof Bench`)) === "object" ? true : null));

  const rows: {
    file: string;
    case: string;
    ms: number;
    bytes: number;
    frames: number;
    bins: number;
    seconds: number;
    m: { snr: number; corr: number; conv: number; lsd: number; magSnr: number; levelErr: number };
    rel: number | null;
    readMode: string;
  }[] = [];

  const TUNE = process.env.TUNE ? JSON.parse(process.env.TUNE) : null;
  for (const file of list) {
    const url = `/audio/${file}`;
    if (TUNE) await ev(`Bench.setTune(${JSON.stringify(TUNE)})`);
    await ev(`return (window.__src = await Bench.loadAudio(${JSON.stringify(url)}));`);
    const info = (await ev(
      `return [window.__src.sr, window.__src.pcm.length]`,
    )) as unknown as [number, number];
    console.log(`\n── ${file}  ${info[0]}Hz  ${(info[1] / info[0]).toFixed(1)}s`);
    for (const c of CASES) {
      const row = (await ev(
        `return await Bench.runCase(window.__src.pcm.subarray(0, Math.min(window.__src.pcm.length, ${MAX_SEC} * window.__src.sr)), window.__src.sr, ${JSON.stringify(file.split("/").pop())}, ${JSON.stringify(c)}, ${JSON.stringify(file.split("/")[0] ?? "")})`,
      )) as (typeof rows)[number];
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
  if (process.env.SYNTH) {
    const sr = (await ev(`return window.__src.sr`)) as number;
    await ev(`window.__p8 = Bench.atRate(window.__src.pcm, window.__src.sr, 8000)`);
    for (const [win, hop] of JSON.parse(process.env.SYNTH) as [number, number][])
      for (const q of [4, 8])
        console.log(
          "   ",
          (await ev(
            `return await Bench.synthProbe(window.__p8.pcm, 8000, ${win}, ${hop}, ${q})`,
          )) as string,
        );
    }
  }

  if (process.env.GRAD) {
    const sr = (await ev(`return window.__src.sr`)) as number;
    for (const [win, hop] of [[256, 64], [256, 128]] as [number, number][])
      console.log(`win=${win} hop=${hop}`, await ev(`return Bench.gradProbe(window.__src.pcm, ${sr}, ${win}, ${hop})`));
  }
  if (process.env.RECON) {
    const sr = (await ev(`return window.__src.sr`)) as number;
    await ev(`window.__p8 = Bench.atRate(window.__src.pcm, window.__src.sr, 8000)`);
    for (const [win, hop] of [
      [256, 128],
      [256, 64],
      [256, 32],
      [256, 16],
      [512, 128],
      [512, 64],
    ] as [number, number][])
      for (const q of [0, 4])
        console.log(
          "   ",
          (await ev(
            `return Bench.reconProbe(window.__p8.pcm, 8000, ${win}, ${hop}, ${q})`,
          )) as string,
        );
  }
  if (process.env.SYNTH) {
    const sr = (await ev(`return window.__src.sr`)) as number;
    await ev(`window.__p8 = Bench.atRate(window.__src.pcm, window.__src.sr, 8000)`);
    for (const [win, hop] of (
      JSON.parse(process.env.SYNTH) as [number, number][]
    ) as [number, number][])
      for (const q of [4, 8])
        console.log(
          "   ",
          (await ev(`return await Bench.synthProbe(window.__p8.pcm, 8000, ${win}, ${hop}, ${q})`)) as string,
        );
  }
  if (process.env.PHASE) {
    const sr = (await ev(`return window.__src.sr`)) as number;
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
      for (const g of [0.25645])
        console.log(
          "   ",
          (await ev(`return Bench.phaseProbe(window.__src.pcm, ${sr}, ${win}, ${hop}, ${g})`)) as string,
        );
  }
  console.log("\nPNG 体检:", (await ev(`return await Bench.pngCheck([1,2,4,6,8])`)) as string[]);
  if (process.env.SIG) {
    const sr2 = (await ev(`return window.__src.sr`)) as number;
    for (const via of JSON.parse(process.env.SIG) as string[])
      console.log(
        "  签名",
        via.padEnd(12),
        (await ev(
          `return await Bench.sigProbe(window.__src.pcm.subarray(0, 4 * window.__src.sr), window.__src.sr, ${JSON.stringify(via)})`,
        )) as string,
      );
  }
  await Bun.write(process.env.OUT ?? "/tmp/bench.json", JSON.stringify(rows, null, 2));
  console.log("\nerrs:", errs.length ? errs.slice(0, 3).join(" | ") : "(none)");
  ws.close();
} finally {
  proc.kill();
  server.kill();
  await sleep(300);
}

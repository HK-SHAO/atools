/** 界面冒烟：定宽起页面 → 点内置示例 → 点质检 → 点频谱图试跳转，只报控制台错误。 */

const CHROME =
  "/Users/sf/.chromium-browser-snapshots/chromium/mac_arm-1684550/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const CDP = 9700 + Math.floor(Math.random() * 200);
const URL = process.env.URL ?? "http://127.0.0.1:3000/";
const W = Number(process.env.W ?? 1200);
const H = Number(process.env.H ?? 900);
const TAG = process.env.TAG ?? `${W}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
    `--window-size=${W},${H}`,
    `--user-data-dir=/tmp/cdp-smoke-${Date.now()}`,
    URL,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

try {
  await sleep(1500);
  const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl?: string;
  }[];
  const ws = new WebSocket(list.find(x => x.type === "page")!.webSocketDebuggerUrl!);
  await new Promise(ok => (ws.onopen = ok));
  const problems: string[] = [];
  let seq = 0;
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as {
      method?: string;
      params?: { type?: string; text?: string; exception?: { description?: string } };
    };
    if (m.method === "Runtime.exceptionThrown")
      problems.push(m.params?.exception?.description ?? "exception");
    if (m.method === "Log.entryAdded" && m.params?.type === "error")
      problems.push(m.params.text ?? "log");
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, never>>(res => {
      const id = ++seq;
      const on = (ev: MessageEvent) => {
        const r = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
        if (r.id === id) {
          ws.removeEventListener("message", on as EventListener);
          res(r.result as Record<string, never>);
        }
      };
      ws.addEventListener("message", on as EventListener);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: W < 500,
  });
  await sleep(800);

  const ev = async (expression: string) => {
    const r = (await send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
    return r.result?.value;
  };
  const shot = async (name: string) => {
    const r = (await send("Page.captureScreenshot", { format: "png" })) as unknown as { data: string };
    await Bun.write(`/tmp/smoke-${TAG}-${name}.png`, Buffer.from(r.data, "base64"));
  };

  await shot("empty");
  await ev(`return document.querySelector('.drop-act')?.textContent`);

  // 内置示例
  await ev(`
    const b = [...document.querySelectorAll('button')];
    const t = b.find(x => /示例/.test(x.textContent ?? ""));
    t?.click();
    return t ? t.textContent.trim() : "";
  `);
  await sleep(3000);
  await shot("loaded");

  const wide = await ev(`return document.querySelector('.app')?.dataset.wide ?? "0"`);
  const gridCols = await ev(
    `return getComputedStyle(document.querySelector('.params')).gridTemplateColumns`,
  );

  // 点频谱图三分之二处：应该开始播放
  const box = (await ev(`
    const s = document.querySelector('.spec');
    const r = s.getBoundingClientRect();
    return [r.left + r.width * 0.66, r.top + r.height / 2];
  `)) as [number, number];
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      x: box[0]!,
      y: box[1]!,
      button: "left",
      clickCount: 1,
    });
  await sleep(900);
  const playing = await ev(
    `return document.querySelector('.icon-btn')?.getAttribute('aria-label')`,
  );
  const head = await ev(`
    const h = document.querySelector('.spec-head');
    const s = h.getBoundingClientRect();
    const p = document.querySelector('.spec').getBoundingClientRect();
    return [h.style.opacity, Math.round(s.left - p.left), Math.round(p.right - s.right)];
  `);
  await shot("playing");

  // 质检
  await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /质检/.test(x.textContent ?? ""));
    b?.click();
    return "";
  `);
  await sleep(Number(process.env.WAIT ?? 9000));
  const facts = (await ev(
    `return [...document.querySelectorAll('.facts')].map(x => x.textContent).join(" ⏐ ")`,
  )) as string;
  await shot("audit");

  console.log(`── ${W}×${H}`);
  console.log("  data-wide:", wide, " 参数列:", String(gridCols).slice(0, 90));
  console.log("  播放键状态:", playing, " 竖线[透明度,距左,距右]:", JSON.stringify(head));
  console.log("  自检:", String(facts).replace(/\s+/g, " ").slice(0, 320));
  console.log("  问题:", problems.length ? problems.slice(0, 4).join(" || ") : "(none)");
  ws.close();
} finally {
  proc.kill();
  await sleep(200);
}

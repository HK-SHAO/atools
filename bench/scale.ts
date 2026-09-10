const root = import.meta.dir;
const project = `${root}/..`;
const PORT = Number(process.env.PORT ?? 4390);
const CDP = PORT + 700;
const CHROME =
  "/Users/sf/.chromium-browser-snapshots/chromium/mac_arm-1684550/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const SAMPLE = "voice/greeting.mp3";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

const cssFiles = [...new Bun.Glob("*.css").scanSync({ cwd: `${project}/dist` })];
let server: ReturnType<typeof Bun.serve> | null = null;
const viaUrl = process.env.URL;

if (!viaUrl) {
  if (cssFiles.length !== 1) {
    console.error(`dist/ 里应当只有一个 css 产物，实际 ${cssFiles.length} 个：重建后再跑`);
    process.exit(1);
  }
  const dist = `${project}/dist`;
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file =
        path === "/"
          ? `${dist}/index.html`
          : path.startsWith("/audio/")
            ? `${project}/docs/${path.slice(7)}`
            : `${dist}${path}`;
      const body = Bun.file(file);
      if (!(await body.exists())) return new Response("missing", { status: 404 });
      const ext = file.slice(file.lastIndexOf("."));
      return new Response(body, { headers: { "content-type": TYPES[ext] ?? "text/plain" } });
    },
  });
}

const target = viaUrl ?? `http://127.0.0.1:${PORT}/`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const SIZES: [number, number][] = [
  [1500, 950],
  [1200, 900],
  [860, 900],
  [520, 800],
  [340, 700],
];

const RATIOS: Record<string, number> = {
  "--fs-lead": 0.9375,
  "--fs-hi": 0.75,
  "--fs-lo": 0.6875,
  "--h-ctl": 1.75,
  "--r-md": 0.75,
  "--r-lg": 1,
};

const CURVE = { ref: 340, base: 14, slope: 1 / 280, ceil: 16.5 };

const curveU = (w: number, h: number): number => {
  const eff = Math.min(w, h * 1.6);
  const raw =
    eff < CURVE.ref
      ? (CURVE.base * eff) / CURVE.ref
      : CURVE.base + (eff - CURVE.ref) * CURVE.slope;
  return Math.min(CURVE.ceil, raw);
};

const CONTROLS = [".act", ".params .chip", ".params .num", ".icon-btn", ".drop-act"];

const CHECKS: string[] = [];
const fail = (msg: string) => CHECKS.push(msg);
const seen: { w: number; u: number; box: { w: number; h: number } }[] = [];

const PROBE = `
  const px = (v) => parseFloat(v);
  const appEl = document.querySelector('.app');
  const shellEl = document.querySelector('.shell');
  const u = px(getComputedStyle(shellEl).getPropertyValue('--u'));
  const box = { w: appEl.clientWidth, h: appEl.clientHeight };
  const view = {
    inner: innerWidth + 'x' + innerHeight,
    app: box.w + 'x' + box.h,
    root: (document.getElementById('root')?.clientHeight ?? -1) + '',
  };
  const boxH = (sel) => {
    const el = document.querySelector(sel);
    return el ? +el.getBoundingClientRect().height.toFixed(3) : null;
  };
  const font = (sel) => {
    const el = document.querySelector(sel);
    return el ? px(getComputedStyle(el).fontSize) : null;
  };
  const ref = document.querySelector('.params .chip') ?? document.querySelector('.drop-act');
  const tokens = Object.fromEntries(
    ${JSON.stringify(Object.keys(RATIOS))}.map((k) => [k, getComputedStyle(ref).getPropertyValue(k).trim()]),
  );
  const probeEl = document.createElement('div');
  probeEl.style.cssText = 'width:600px;position:absolute;left:-9999px;top:0';
  probeEl.innerHTML = '<div class="card"><div class="params"><div class="prow">x</div></div></div>';
  document.body.append(probeEl);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const narrow = getComputedStyle(probeEl.querySelector('.params')).display;
  probeEl.style.width = '900px';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wide = getComputedStyle(probeEl.querySelector('.params')).display;
  probeEl.remove();
  return {
    u,
    box,
    view,
    h1: font('.head h1'),
    chip: font('.params .chip'),
    heights: ${JSON.stringify(CONTROLS)}.map(boxH),
    tokens,
    beforeLoad: {
      params: getComputedStyle(document.querySelector('.params')).display,
      wide,
      narrow,
    },
  };
`;

const DROP = `
  if (!document.querySelector('.params .chip')) {
    const res = await fetch('/audio/${SAMPLE}');
    const blob = await res.blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'sample.mp3', { type: blob.type }));
    document.querySelector('.app').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (document.querySelector('.params .chip')) break;
  }
  return !!document.querySelector('.params .chip');
`;

const proc = Bun.spawn(
  [
    CHROME,
    "--headless=new",
    `--remote-debugging-port=${CDP}`,
    "--no-first-run",
    "--no-sandbox",
    "--disable-gpu",
    "--mute-audio",
    "--window-size=1500,950",
    `--user-data-dir=/tmp/cdp-scale-${Date.now()}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

try {
  await sleep(1200);
  const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl?: string;
  }[];
  const ws = new WebSocket(list.find(x => x.type === "page")!.webSocketDebuggerUrl!);
  await new Promise(ok => (ws.onopen = ok));

  let seq = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown };
    if (m.id !== undefined) pending.get(m.id)?.(m.result);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>(res => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression: string) => {
    const r = (await send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
    return r.result?.value as any;
  };

  await send("Runtime.enable");
  await send("Page.enable");

  if (!viaUrl) {
    for (const f of cssFiles) {
      const css = await Bun.file(`${project}/dist/${f}`).text();
      if (css.includes("@layer"))
        fail(`产物 ${f} 含 @layer：本方案靠 @import 顺序决定层叠，不接受分层`);
    }
  }

  console.log("容器宽度   u        字号（标题/控件）    控件高度 ×5                              令牌锚定");
  for (const [w, h] of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: target });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if (await ev(`return !!document.querySelector('.app')`)) break;
    }
    await sleep(400);

    const pristine = await ev(`
      const el = document.querySelector('.drop-act');
      return { dropAct: el ? +el.getBoundingClientRect().height.toFixed(3) : null };
    `);
    const loaded = await ev(DROP);
    if (!loaded) throw new Error(`${w}px：样例音频未能载入，量不到参数区`);
    await sleep(250);

    const r = await ev(PROBE);
    const heights: (number | null)[] = r.heights.map((v: number | null, i: number) =>
      v === null && CONTROLS[i] === ".drop-act" ? pristine.dropAct : v,
    );
    const shown = CONTROLS.map(
      (sel, i) => `${sel.split(" ").pop()} ${heights[i] ?? "缺失"}`,
    ).join(" / ");
    if (![r.u, r.h1, r.chip].every(finite)) {
      fail(`${w}px：尺寸读不到有限数（u=${r.u} 标题=${r.h1} 控件=${r.chip}）—— 令牌没解析成具体长度`);
      console.log(`${String(w).padEnd(9)} 尺寸读取失败：${shown}`);
      continue;
    }
    console.log(
      `${String(w).padEnd(9)} ${r.u.toFixed(3).padEnd(8)} ${r.h1.toFixed(2).padEnd(6)}/${r.chip
        .toFixed(2)
        .padEnd(6)} ${shown.padEnd(40)} ${Object.values(r.tokens)[0]}`,
    );
    console.log(
      `         视口 ${r.view.inner}  容器 ${r.view.app}  #root 高 ${r.view.root}`,
    );

    const known = heights.filter(finite);
    const want = curveU(r.box.w, r.box.h);
    seen.push({ w, u: r.u, box: r.box });
    if (Math.abs(r.u - want) > 0.01)
      fail(
        `${w}x${h}：u = ${r.u}，容器 ${r.box.w}x${r.box.h} 的曲线应给出 ${want.toFixed(3)}（曲线常量被改过？）`,
      );
    if (known.length !== 5) fail(`${w}px：只量到 ${known.length} 种控件，应有 5 种（${shown}）`);
    else {
      const spread = Math.max(...known) - Math.min(...known);
      if (spread > 0.05)
        fail(`${w}px：控件高度不一致，极差 ${spread.toFixed(3)}px（${shown}）`);
      if (Math.abs(known[0]! - r.u * RATIOS["--h-ctl"]!) > 0.05)
        fail(`${w}px：控件高度 ${known[0]} ≠ 1.75×u = ${(r.u * 1.75).toFixed(3)}`);
    }

    if (Math.abs(r.h1 - r.u * RATIOS["--fs-lead"]!) > 0.01)
      fail(`${w}px：标题字号 ${r.h1} ≠ 0.9375×u = ${(r.u * 0.9375).toFixed(3)}`);
    if (Math.abs(r.chip - r.u * RATIOS["--fs-lo"]!) > 0.01)
      fail(`${w}px：控件字号 ${r.chip} ≠ 0.6875×u = ${(r.u * 0.6875).toFixed(3)}`);

    for (const [name, ratio] of Object.entries(RATIOS)) {
      const got: string = r.tokens[name];
      if (/var\(/.test(got)) {
        fail(`${name} 在 ${w}px 下仍是未替换的 var()：${got}`);
        continue;
      }
      const anchor = got.match(/([\d.]+)px/)?.[1];
      if (anchor === undefined) {
        fail(`${name} 在 ${w}px 下没解析出 px 锚点：${got}`);
        continue;
      }
      if (Math.abs(parseFloat(anchor) - r.u) > 0.01)
        fail(
          `${name} 锚在 ${anchor}px，当前 u 是 ${r.u}px —— 令牌被算死在别的元素上了（${got}）`,
        );
    }

    if (r.beforeLoad.params !== "grid" && w >= 900)
      fail(`${w}px：参数区应为 grid，实际 ${r.beforeLoad.params}`);
    if (r.beforeLoad.wide !== "grid")
      fail(`${w}px：900px 容器下参数区应为 grid，实际 ${r.beforeLoad.wide}`);
    if (r.beforeLoad.narrow !== "flex")
      fail(`${w}px：600px 容器下参数区应为 flex，实际 ${r.beforeLoad.narrow}`);
  }

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: target });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await ev(`return !!document.querySelector('.shell')`)) break;
  }
  await sleep(300);

  const cq = await ev(`
    const app = document.querySelector('.app');
    const shrink = document.createElement('style');
    shrink.textContent = '.app{width:520px}';
    document.head.append(shrink);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = { w: app.clientWidth, h: app.clientHeight };
    const u = parseFloat(getComputedStyle(document.querySelector('.shell')).getPropertyValue('--u'));
    shrink.remove();
    return { box, u, vw: innerWidth };
  `);
  const wantCq = curveU(cq.box.w, cq.box.h);
  const wantVp = curveU(cq.vw, cq.box.h);
  console.log(
    `容器相对  .app 收到 ${cq.box.w}px（视口 ${cq.vw}px）  u=${cq.u}  期望 ${wantCq.toFixed(3)}（视口口径会给出 ${wantVp.toFixed(3)}）`,
  );
  if (cq.box.w >= cq.vw) fail(`收缩探针无效：.app 仍是 ${cq.box.w}px，未小于视口 ${cq.vw}px`);
  if (Math.abs(wantCq - wantVp) < 0.5)
    fail(`收缩探针无法区分容器与视口（${wantCq.toFixed(3)} vs ${wantVp.toFixed(3)}）`);
  else if (Math.abs(cq.u - wantCq) > 0.01)
    fail(`.app 收窄到 ${cq.box.w}px 后 u=${cq.u}，应为容器曲线 ${wantCq.toFixed(3)} —— cq 单位没锚在容器上`);
} finally {
  proc.kill();
  server?.stop(true);
}

if (seen.length) {
  const narrowest = seen.find(s => s.w === SIZES[SIZES.length - 1]![0]);
  const widest = seen[0];
  if (narrowest && Math.abs(narrowest.u - CURVE.base) > 0.01)
    fail(`最窄档 u=${narrowest.u}，应等于基准 ${CURVE.base}（下限没去干净，或被别处钳住）`);
  if (widest && widest.u < CURVE.ceil - 0.01)
    fail(`最宽档 u=${widest.u} 未触到上限 ${CURVE.ceil}：上限是死代码`);
  for (let i = 1; i < seen.length; i++)
    if (seen[i]!.u > seen[i - 1]!.u + 1e-6)
      fail(`u 不随容器单调：${seen[i - 1]!.w}px 时 ${seen[i - 1]!.u}，${seen[i]!.w}px 时 ${seen[i]!.u}`);
}

if (CHECKS.length) {
  console.error(`\n不合格 ${CHECKS.length} 项：`);
  for (const c of CHECKS) console.error(`  - ${c}`);
  process.exit(1);
}
console.log("\n样式尺度全部合格");

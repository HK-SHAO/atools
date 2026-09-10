import { open, serveDir, sleep } from "./cdp";

const project = `${import.meta.dir}/..`;
const SAMPLE = "voice/greeting.mp3";
const PORT = Number(process.env.PORT ?? 4390);
const CDP = PORT + 700;

/** 覆盖曲线的两段与封顶：桌面、窄卡片、手机、极窄。 */
const SIZES: [number, number][] = [
  [1500, 950],
  [1200, 900],
  [860, 900],
  [520, 800],
  [340, 700],
];

/**
 * 令牌 → 与 `--u` 的比值。逐条都要在**计算值**里解析成锚在当前 `--u` 的 px：
 * `@property` 注册一丢，`cqi` 就留在令牌里、到使用点才被最近的容器抢走，
 * 而截图上看不出区别（实测控件高 24.5 → 20.3、字号 → 7.98）。
 */
const RATIOS: Record<string, number> = {
  "--fs-lead": 0.9375,
  "--fs-hi": 0.75,
  "--fs-lo": 0.6875,
  "--h-ctl": 1.75,
  "--r-md": 0.75,
  "--r-lg": 1,
};

/** `--u = min(14×eff/340, 14+(eff−340)/280, 16.5)`，`eff = min(100cqi, 160cqb)`。 */
const CURVE = { ref: 340, base: 14, slope: 1 / 280, ceil: 16.5 };
const curveU = (w: number, h: number): number => {
  const eff = Math.min(w, h * 1.6);
  const raw =
    eff < CURVE.ref ? (CURVE.base * eff) / CURVE.ref : CURVE.base + (eff - CURVE.ref) * CURVE.slope;
  return Math.min(CURVE.ceil, raw);
};

/** 四种控件共用 `primitives.css` 里同一组几何，逐种量高度以确认没谁自带高度。
 *  `drop-act` 只在空态存在，单独量。 */
const CONTROLS = [".act", ".params .chip", ".params .num", ".icon-btn"];

const PROBE = `
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const app = document.querySelector('.app');
  const shell = document.querySelector('.shell');
  const chip = document.querySelector('.params .chip');
  const height = (sel) => {
    const el = document.querySelector(sel);
    return el ? +el.getBoundingClientRect().height.toFixed(3) : null;
  };
  const font = (sel) => {
    const el = document.querySelector(sel);
    return el ? parseFloat(getComputedStyle(el).fontSize) : null;
  };
  return {
    u: parseFloat(getComputedStyle(shell).getPropertyValue('--u')),
    box: { w: app.clientWidth, h: app.clientHeight },
    title: font('.head h1'),
    chip: font('.params .chip'),
    heights: ${JSON.stringify(CONTROLS)}.map(height),
    labels: [...document.querySelectorAll('.params .plabel')].map(
      (el) => +el.getBoundingClientRect().left.toFixed(2),
    ),
    tokens: Object.fromEntries(
      ${JSON.stringify(Object.keys(RATIOS))}.map((k) => [
        k,
        getComputedStyle(chip).getPropertyValue(k).trim(),
      ]),
    ),
  };
`;

const DROP = `
  if (!document.querySelector('.params')) {
    const blob = await (await fetch('/audio/${SAMPLE}')).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'sample.mp3', { type: blob.type }));
    document.querySelector('.app').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (document.querySelector('.params')) return true;
  }
  return false;
`;

/**
 * 容器 vs 视口的判别探针：视口固定，只把 `.app` 压窄。若 `--u` 仍等于视口口径，
 * 说明 `cqi` 没锚在 `.app` 上 —— 在任何单一视口下都看不出来。
 */
const SHRINK = `
  const app = document.querySelector('.app');
  const shell = document.querySelector('.shell');
  const style = document.createElement('style');
  document.head.append(style);
  const out = [];
  for (const w of [1500, 900, 600, 520]) {
    style.textContent = '.app{width:' + w + 'px}';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.push({
      w,
      bw: app.clientWidth,
      bh: app.clientHeight,
      u: parseFloat(getComputedStyle(shell).getPropertyValue('--u')),
    });
  }
  style.remove();
  return out;
`;

interface Probe {
  u: number;
  box: { w: number; h: number };
  title: number | null;
  chip: number | null;
  heights: (number | null)[];
  labels: number[];
  tokens: Record<string, string>;
}

interface Shrink {
  w: number;
  bw: number;
  bh: number;
  u: number;
}

const failures: string[] = [];
const fail = (msg: string): void => void failures.push(msg);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const cssFiles = [...new Bun.Glob("*.css").scanSync({ cwd: `${project}/dist` })];
if (cssFiles.length !== 1) {
  console.error(`dist/ 里应当只有一个 css 产物，实际 ${cssFiles.length} 个 —— 先 bun run build:web`);
  process.exit(1);
}
const css = await Bun.file(`${project}/dist/${cssFiles[0]}`).text();
for (const [needle, why] of [
  ["@property --u", "尺度令牌会被使用点最近的容器抢走"],
  ["-webkit-backdrop-filter", "Safari 的毛玻璃会静默失效"],
] as const)
  if (!css.includes(needle)) fail(`${cssFiles[0]} 丢了 ${needle}：${why}`);

const server = serveDir(PORT, `${project}/dist`, { "/audio/": `${project}/docs/` });
const session = await open({ port: CDP, size: SIZES[0]!, url: `http://127.0.0.1:${PORT}/` });
const seen: { w: number; u: number }[] = [];

try {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: SIZES[0]![0],
    height: SIZES[0]![1],
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.goto(`http://127.0.0.1:${PORT}/`, ".app");
  await sleep(400);

  // 空态：量 drop-act（载入音频后它就不在文档里了），并把「跟容器而非视口」证掉
  const bare = await session.ev<{ u: number; h: number | null }>(`
    const el = document.querySelector('.drop-act');
    return {
      u: parseFloat(getComputedStyle(document.querySelector('.shell')).getPropertyValue('--u')),
      h: el ? +el.getBoundingClientRect().height.toFixed(3) : null,
    };
  `);
  const wantBare = bare.u * RATIOS["--h-ctl"]!;
  if (!finite(bare.h) || Math.abs(bare.h - wantBare) > 0.05)
    fail(`.drop-act 高 ${bare.h} ≠ ${RATIOS["--h-ctl"]}×u = ${wantBare.toFixed(3)}`);

  const shrink = await session.ev<Shrink[]>(SHRINK);
  const pure = curveU(SIZES[0]![0], SIZES[0]![1]);
  if (!shrink.some((r) => Math.abs(r.u - pure) > 0.5))
    fail(`收缩探针区分不出容器与视口：四行都是视口口径 ${pure.toFixed(3)} —— 断言是空的`);
  for (const r of shrink) {
    const want = curveU(r.bw, r.bh);
    if (!finite(r.u)) fail(`.app ${r.bw}px 时 --u 读不到有限数（${r.u}）—— 令牌没解析成具体长度`);
    else if (Math.abs(r.u - want) > 0.01)
      fail(`.app ${r.bw}px 宽时 u=${r.u}，容器曲线应给 ${want.toFixed(3)} —— cq 单位没锚在容器上`);
  }

  if (!(await session.ev<boolean>(DROP))) throw new Error("样例音频未载入");
  await sleep(250);

  console.log("视口      容器        u        字号 标题/控件   控件高度                           令牌");
  for (const [w, h] of SIZES) {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const r = await session.ev<Probe>(PROBE);
    const shown = CONTROLS.map((name, i) => `${name} ${r.heights[i] ?? "缺失"}`).join(" / ");

    if (!finite(r.u) || !finite(r.title) || !finite(r.chip)) {
      fail(`${w}px：尺寸读不到有限数（u=${r.u} 标题=${r.title} 控件=${r.chip}）—— 令牌没解析成具体长度`);
      console.log(`${String(w).padEnd(9)} 尺寸读取失败`);
      continue;
    }
    console.log(
      `${String(w).padEnd(9)} ${`${r.box.w}x${r.box.h}`.padEnd(10)} ${r.u.toFixed(3).padEnd(8)} ` +
        `${r.title.toFixed(2).padEnd(6)}/${r.chip.toFixed(2).padEnd(6)} ${shown.padEnd(34)} ` +
        `${Object.values(r.tokens)[0]}`,
    );
    seen.push({ w, u: r.u });

    const want = curveU(r.box.w, r.box.h);
    if (Math.abs(r.u - want) > 0.01)
      fail(`${w}x${h}：u = ${r.u}，容器 ${r.box.w}x${r.box.h} 的曲线应给 ${want.toFixed(3)}`);

    const known = r.heights.filter(finite);
    if (known.length !== CONTROLS.length) {
      fail(`${w}px：只量到 ${known.length}/${CONTROLS.length} 种控件（${shown}）`);
    } else {
      const spread = Math.max(...known) - Math.min(...known);
      if (spread > 0.05) fail(`${w}px：控件高度不一致，极差 ${spread.toFixed(3)}px（${shown}）`);
      if (Math.abs(known[0]! - r.u * RATIOS["--h-ctl"]!) > 0.05)
        fail(`${w}px：控件高 ${known[0]} ≠ 1.75×u = ${(r.u * 1.75).toFixed(3)}`);
    }

    for (const [name, got, ratio] of [
      ["标题", r.title, RATIOS["--fs-lead"]!],
      ["控件", r.chip, RATIOS["--fs-lo"]!],
    ] as const)
      if (Math.abs(got - r.u * ratio) > 0.01)
        fail(`${w}px：${name}字号 ${got} ≠ ${ratio}×u = ${(r.u * ratio).toFixed(3)}`);

    for (const name of Object.keys(RATIOS)) {
      const got = r.tokens[name]!;
      const anchor = /var\(/.test(got) ? null : (got.match(/([\d.]+)px/)?.[1] ?? null);
      if (anchor === null) fail(`${name} 在 ${w}px 下没解析成 px（${got}）—— 锚在别的元素上`);
      else if (Math.abs(parseFloat(anchor) - r.u) > 0.01)
        fail(`${name} 锚在 ${anchor}px，当前 u 是 ${r.u}px（${got}）`);
    }

    // 参数面板：一个参数一行，标签共享同一条竖线 —— 这是它唯一的结构承诺
    if (r.labels.length < 4)
      fail(`${w}px：只找到 ${r.labels.length} 个参数标签 —— 标签对齐那条断言是空的`);
    else {
      const spread = Math.max(...r.labels) - Math.min(...r.labels);
      if (spread > 0.5) fail(`${w}px：参数标签左缘极差 ${spread.toFixed(1)}px —— 不在同一列`);
    }
  }

  const narrowest = seen[seen.length - 1];
  const widest = seen[0];
  if (seen.length === SIZES.length && narrowest && widest) {
    if (Math.abs(narrowest.u - CURVE.base) > 0.01)
      fail(`最窄档 u=${narrowest.u}，应等于基准 ${CURVE.base}（被别处钳住，或下限没去干净）`);
    if (widest.u < CURVE.ceil - 0.01) fail(`最宽档 u=${widest.u} 未触到上限 ${CURVE.ceil}：上限是死代码`);
    for (let i = 1; i < seen.length; i++)
      if (seen[i]!.u > seen[i - 1]!.u + 1e-6)
        fail(`u 不随容器单调：${seen[i - 1]!.w}px → ${seen[i]!.w}px 反而变大`);
  }
} finally {
  await session.stop();
  server.stop(true);
}

if (failures.length) {
  console.error(`\n不合格 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n样式尺度全部合格");

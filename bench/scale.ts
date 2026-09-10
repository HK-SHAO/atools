import { open, serveDir, sleep } from "./cdp";

const project = `${import.meta.dir}/..`;
const SAMPLE = "voice/greeting.mp3";
const PORT = Number(process.env.PORT ?? 4390);
const CDP = PORT + 700;

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
    eff < CURVE.ref ? (CURVE.base * eff) / CURVE.ref : CURVE.base + (eff - CURVE.ref) * CURVE.slope;
  return Math.min(CURVE.ceil, raw);
};

const CONTROLS = ["act", "chip", "num", "icon-btn", "drop-act"];
const SELECTORS = [
  '.act',
  '.params .chip',
  '.params .num',
  '.icon-btn',
  '.drop-act',
];

const PROBE = `
  const px = (v) => parseFloat(v);
  const app = document.querySelector('.app');
  const shell = document.querySelector('.shell');
  const chip = document.querySelector('.params .chip');
  const height = (sel) => {
    const el = document.querySelector(sel);
    return el ? +el.getBoundingClientRect().height.toFixed(3) : null;
  };
  const font = (sel) => {
    const el = document.querySelector(sel);
    return el ? px(getComputedStyle(el).fontSize) : null;
  };
  return {
    u: px(getComputedStyle(shell).getPropertyValue('--u')),
    box: { w: app.clientWidth, h: app.clientHeight },
    title: font('.head h1'),
    chip: font('.params .chip'),
    heights: ${JSON.stringify(SELECTORS)}.map(height),
    tokens: Object.fromEntries(
      ${JSON.stringify(Object.keys(RATIOS))}.map((k) => [k, getComputedStyle(chip).getPropertyValue(k).trim()]),
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

const SWEEP = `
  const app = document.querySelector('.app');
  const shell = document.querySelector('.shell');
  const params = document.querySelector('.params');
  const style = document.createElement('style');
  document.head.append(style);
  const out = [];
  for (const w of [1500, 900, 800, 600, 520]) {
    style.textContent = '.app{width:' + w + 'px}';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cs = getComputedStyle(params);
    const pr = params.getBoundingClientRect();
    const blocks = [...params.querySelectorAll('.prow')].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: +r.width.toFixed(2), top: +r.top.toFixed(1), l: +r.left.toFixed(2), r: +r.right.toFixed(2) };
    });
    out.push({
      w,
      u: parseFloat(getComputedStyle(shell).getPropertyValue('--u')),
      box: { w: app.clientWidth, h: app.clientHeight },
      card: params.parentElement.clientWidth,
      display: getComputedStyle(params).display,
      paramsW: params.clientWidth,
      innerR: +(pr.right - parseFloat(cs.paddingRight)).toFixed(2),
      justify: cs.justifyContent,
      blocks,
    });
  }
  style.remove();
  return { rows: out, viewport: innerWidth };
`;

interface Probe {
  u: number;
  box: { w: number; h: number };
  title: number | null;
  chip: number | null;
  heights: (number | null)[];
  tokens: Record<string, string>;
}

interface SweepRow {
  w: number;
  u: number | null;
  box: { w: number; h: number };
  card: number;
  display: string;
  paramsW: number;
  innerR: number;
  justify: string;
  blocks: { w: number; top: number; l: number; r: number }[];
}

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const cssFiles = [...new Bun.Glob("*.css").scanSync({ cwd: `${project}/dist` })];
if (cssFiles.length !== 1) {
  console.error(`dist/ 里应当只有一个 css 产物，实际 ${cssFiles.length} 个：先 bun run build:web`);
  process.exit(1);
}
const css = await Bun.file(`${project}/dist/${cssFiles[0]}`).text();
for (const [needle, why] of [
  ["@property --u", "尺度令牌会被最近的内联容器抢走"],
  ["-webkit-backdrop-filter", "Safari 的毛玻璃会静默失效"],
] as const)
  if (!css.includes(needle)) fail(`${cssFiles[0]} 丢了 ${needle}：${why}`);

const server = serveDir(PORT, `${project}/dist`, { "/audio/": `${project}/docs/` });
const session = await open({ port: CDP, size: SIZES[0]!, url: `http://127.0.0.1:${PORT}/` });
const seen: { w: number; u: number }[] = [];

try {
  console.log("视口      容器        u        字号 标题/控件   控件高度 ×5                              令牌锚定");
  for (const [w, h] of SIZES) {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await session.goto(`http://127.0.0.1:${PORT}/`, '.app');
    await sleep(400);

    const bare = await session.ev<number | null>(
      `const el = document.querySelector('.drop-act');
       return el ? +el.getBoundingClientRect().height.toFixed(3) : null;`,
    );
    if (!(await session.ev<boolean>(DROP))) throw new Error(`${w}px：样例音频未载入`);
    await sleep(250);

    const r = await session.ev<Probe>(PROBE);
    const heights = r.heights.map((v, i) => (v === null && CONTROLS[i] === "drop-act" ? bare : v));
    const shown = CONTROLS.map((name, i) => `${name} ${heights[i] ?? "缺失"}`).join(" / ");

    const { u, title, chip } = r;
    if (!finite(u) || !finite(title) || !finite(chip)) {
      fail(`${w}px：尺寸读不到有限数（u=${u} 标题=${title} 控件=${chip}）—— 令牌没解析成具体长度`);
      console.log(`${String(w).padEnd(8)} 尺寸读取失败`);
      continue;
    }

    console.log(
      `${String(w).padEnd(8)} ${`${r.box.w}x${r.box.h}`.padEnd(10)} ${u.toFixed(3).padEnd(8)} ` +
        `${title.toFixed(2).padEnd(6)}/${chip.toFixed(2).padEnd(6)} ${shown.padEnd(40)} ` +
        `${Object.values(r.tokens)[0]}`,
    );

    seen.push({ w, u });

    const want = curveU(r.box.w, r.box.h);
    if (Math.abs(u - want) > 0.01)
      fail(`${w}x${h}：u = ${u}，容器 ${r.box.w}x${r.box.h} 的曲线应给出 ${want.toFixed(3)}`);

    const known = heights.filter(finite);
    if (known.length !== 5) {
      fail(`${w}px：只量到 ${known.length} 种控件，应有 5 种（${shown}）`);
    } else {
      const spread = Math.max(...known) - Math.min(...known);
      if (spread > 0.05) fail(`${w}px：控件高度不一致，极差 ${spread.toFixed(3)}px（${shown}）`);
      if (Math.abs(known[0]! - u * RATIOS["--h-ctl"]!) > 0.05)
        fail(`${w}px：控件高度 ${known[0]} ≠ 1.75×u = ${(u * 1.75).toFixed(3)}`);
    }

    for (const [name, got, ratio] of [
      ["标题", title, RATIOS["--fs-lead"]!],
      ["控件", chip, RATIOS["--fs-lo"]!],
    ] as [string, number, number][]) {
      if (Math.abs(got - u * ratio) > 0.01)
        fail(`${w}px：${name}字号 ${got} ≠ ${ratio}×u = ${(u * ratio).toFixed(3)}`);
    }

    for (const name of Object.keys(RATIOS)) {
      const got = r.tokens[name]!;
      if (/var\(/.test(got)) {
        fail(`${name} 在 ${w}px 下仍是未替换的 var()：${got}`);
        continue;
      }
      const anchor = got.match(/([\d.]+)px/)?.[1];
      if (anchor === undefined) {
        fail(`${name} 在 ${w}px 下没解析出 px 锚点：${got}`);
        continue;
      }
      if (Math.abs(parseFloat(anchor) - u) > 0.01)
        fail(`${name} 锚在 ${anchor}px，当前 u 是 ${u}px —— 令牌被算死在别的元素上了（${got}）`);
    }
  }

  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.goto(`http://127.0.0.1:${PORT}/`, '.shell');
  await session.ev(DROP);
  await sleep(250);

  const sweep = await session.ev<{ rows: SweepRow[]; viewport: number }>(SWEEP);
  console.log(`\n容器相对：视口固定 ${sweep.viewport}px，压窄 .app 看 u 与参数区跟谁走`);
  console.log("  .app 宽   卡片宽    u         期望       参数区布局        块宽");
  for (const row of sweep.rows) {
    const want = curveU(row.box.w, row.box.h);
    const widths = row.blocks.map(b => b.w);
    const lines = new Set(row.blocks.map(b => b.top)).size;
    const shape = `${row.display} ${lines}行/${row.blocks.length}块`;
    const span = `${Math.min(...widths).toFixed(0)}~${Math.max(...widths).toFixed(0)}px`;
    console.log(
      `  ${String(row.w).padEnd(9)} ${String(row.card).padEnd(9)} ${String(row.u).padEnd(10)} ` +
        `${want.toFixed(3).padEnd(10)} ${shape.padEnd(15)} ${span}`,
    );
    if (!finite(row.u)) {
      fail(`.app ${row.box.w}px 时 --u 读不到有限数（${row.u}）—— 令牌没解析成具体长度`);
      continue;
    }
    if (Math.abs(row.u - want) > 0.01)
      fail(`.app ${row.box.w}px 时 u=${row.u}，应为容器曲线 ${want.toFixed(3)} —— cq 单位没锚在容器上`);
    if (row.display !== "flex")
      fail(`.app ${row.box.w}px 时参数区为 ${row.display}，应为按内容换行的 flex —— 面板不该有断点`);
    if (Math.max(...widths) > row.paramsW + 0.5)
      fail(`.app ${row.box.w}px 时最宽区块 ${Math.max(...widths)}px 溢出参数区 ${row.paramsW}px`);
  }

  // 换行的余量要分到块之间（space-between），不能堆在行尾。堆着的时候最后一块的右缘离右内边距
  // 还差几百 px，于是左内边距 16.5px、右内边距 16.5+余量 —— 就是「右边空一大块、左右不对称」。
  // 单块行本就左对齐、没有可分的余量，跳过。
  let slack = 0;
  let slackAt = "";
  let checkedLines = 0;
  for (const row of sweep.rows)
    for (const top of new Set(row.blocks.map(b => b.top))) {
      const line = row.blocks.filter(b => b.top === top);
      if (line.length < 2) continue;
      checkedLines++;
      const gap = row.innerR - Math.max(...line.map(b => b.r));
      if (gap > slack) {
        slack = gap;
        slackAt = `.app ${row.box.w}px 的 ${line.length} 块行`;
      }
    }
  if (checkedLines === 0)
    fail("收缩探针一个多块行都没覆盖到 —— 行尾余量那条断言是空的");
  else if (slack > 0.5)
    fail(
      `参数区把换行余量堆在行尾（${slackAt}，右缘差 ${slack.toFixed(1)}px）` +
        ` —— 右内边距比左内边距宽这么多`,
    );
  console.log(
    `\n参数区换行余量：实测 ${checkedLines} 个多块行，最大的行尾空隙 ${slack.toFixed(2)}px` +
      (slackAt ? `（${slackAt}）` : ""),
  );

  const wide = sweep.rows[0]!;
  const wideWidths = wide.blocks.map(b => b.w);
  const wideLines = new Set(wide.blocks.map(b => b.top)).size;
  const spread = Math.max(...wideWidths) - Math.min(...wideWidths);
  if (spread < 20)
    fail(`参数区块几乎等宽（极差 ${spread.toFixed(1)}px）—— 按内容取宽退回了等宽栅格`);
  if (wideLines >= wide.blocks.length)
    fail(`参数区 ${wide.blocks.length} 块占了 ${wideLines} 行 —— 没有自适应换行`);

  const narrow = sweep.rows[sweep.rows.length - 1]!;
  const pure = curveU(1500, 950);
  if (finite(narrow.u) && Math.abs(narrow.u - pure) < 0.5)
    fail(`收缩探针无法区分容器与视口：${narrow.u} ≈ 视口口径 ${pure}`);
  if (narrow.box.w >= 1500) fail(`收缩探针无效：.app 仍是 ${narrow.box.w}px，未窄于视口 1500px`);
} finally {
  await session.stop();
  server.stop(true);
}

if (seen.length === SIZES.length) {
  const narrowest = seen[seen.length - 1]!;
  const widest = seen[0]!;
  if (Math.abs(narrowest.u - CURVE.base) > 0.01)
    fail(`最窄档 u=${narrowest.u}，应等于基准 ${CURVE.base}（被别处钳住，或下限没去干净）`);
  if (widest.u < CURVE.ceil - 0.01) fail(`最宽档 u=${widest.u} 未触到上限 ${CURVE.ceil}：上限是死代码`);
  for (let i = 1; i < seen.length; i++)
    if (seen[i]!.u > seen[i - 1]!.u + 1e-6)
      fail(`u 不随容器单调：${seen[i - 1]!.w}px → ${seen[i]!.w}px 反而变大`);
}

if (failures.length) {
  console.error(`\n不合格 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n样式尺度全部合格");

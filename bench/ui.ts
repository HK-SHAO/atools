import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { open, serve, waitFor } from "./cdp.ts";

const PORT = Number(process.env.UI_PORT ?? 4399);
const project = `${import.meta.dirname}/..`;
const SUBPATH = process.env.SUBPATH ?? "";
const BASELINE = process.env.UI_BASELINE ?? "";

type Ev = <R = unknown>(expression: string) => Promise<R>;

const COUNT_CONTEXT = `
  window.__ac = 0;
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Native = window[name];
    if (!Native) continue;
    window[name] = class extends Native {
      constructor(...args) {
        super(...args);
        window.__ac += 1;
      }
    };
  }
`;

const press = (sel: string, label: string): string =>
  `(() => {
     const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(v => (v.textContent ?? '').trim() === ${JSON.stringify(label)});
     if (!b) throw new Error(${JSON.stringify("界面上没有这个按钮：")} + ${JSON.stringify(label)});
     if (b.disabled) throw new Error(${JSON.stringify("按钮此刻不可点：")} + ${JSON.stringify(label)});
     b.click();
     return 1;
   })()`;

const FACTS = "return document.querySelector('p.facts')?.textContent ?? ''";

const enabled = (label: string): string =>
  `return (() => {
     const b = [...document.querySelectorAll('button.act')].find(v => (v.textContent ?? '').trim() === ${JSON.stringify(label)});
     return b && !b.disabled ? 1 : 0;
   })()`;

const pngOf = (line: string): string => line.match(/PNG [^；]+/)?.[0] ?? "";

async function chain(
  ev: Ev,
  mark: (label: string) => void,
  onReady?: () => Promise<void>,
): Promise<readonly [string, string]> {
  await waitFor("应用载入", async () =>
    (await ev<number>("return document.querySelector('.drop') ? 1 : 0")) ? 1 : null,
  );
  await onReady?.();

  await ev(press("button.act", "演示"));
  await waitFor(
    "演示就绪（解码 + 编码 + 出图）",
    async () => ((await ev<number>("return document.querySelector('.spec') ? 1 : 0")) ? 1 : null),
    120000,
  );
  mark("演示就绪");

  const contexts = await ev<number>("return window.__ac ?? -1");
  if (contexts === 0)
    failures.push(
      "演示就绪时还没有构造过 AudioContext：那一百多毫秒的一次性开销会落在第一次点播放那一刻",
    );
  if (contexts > 0) mark(`播放前 AudioContext ${contexts} 个`);

  await ev(press("button.act", "质检"));
  const compact = await waitFor(
    "紧凑档质检",
    async () => {
      const t = await ev<string>(FACTS);
      return t.includes("还原度") ? t : null;
    },
    60000,
  );
  mark(`紧凑档质检  ${compact}`);

  await ev(press("button.act", "重建相位"));
  await waitFor(
    "精修完成",
    async () => ((await ev<string>(FACTS)).includes("相位已重建") ? true : null),
    120000,
  );
  mark("相位已重建");

  await ev(press("button.chip", "可逆"));
  const rendered = await waitFor(
    "可逆档出图",
    async () => {
      const t = await ev<string>(FACTS);
      if (!t.includes("可逆模式") || pngOf(t) === "" || pngOf(t) === pngOf(compact)) return null;
      return (await ev<number>(enabled("质检"))) ? t : null;
    },
    120000,
  );
  mark("可逆档出图");

  await ev(press("button.act", "质检"));
  const exact = await waitFor(
    "可逆档质检",
    async () => {
      const t = await ev<string>(FACTS);
      return t.includes("还原度") && t !== rendered ? t : null;
    },
    60000,
  );
  mark(`可逆档质检  ${exact}`);
  return [compact, exact];
}

const staged = SUBPATH ? `${tmpdir()}/atools-subpath-${process.pid}` : "";
if (staged) await cp(`${project}/dist`, `${staged}${SUBPATH}`, { recursive: true });
const base = `http://127.0.0.1:${PORT}${SUBPATH}/`;
const server = serve(PORT, { dir: staged || `${project}/dist` });
const session = await open({ port: PORT + 1000, size: [1200, 900], url: "about:blank" });
const ev = session.ev;
await session.send("Page.addScriptToEvaluateOnNewDocument", { source: COUNT_CONTEXT });

const failures: string[] = [];
const errs: string[] = [];
session.on(m => {
  if (m.method === "Runtime.exceptionThrown")
    errs.push(m.params?.exceptionDetails?.exception?.description ?? "（未捕获异常）");
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
    errs.push(
      "console.error " +
        (m.params.args ?? []).map((a: any) => a.description ?? JSON.stringify(a.value) ?? "").join(" "),
    );
});

await session.goto(`${base}${staged ? "index.html" : ""}`, ".drop");

let origin = 0;
const mark = (label: string, at = performance.now()) =>
  console.log(`  ${String(Math.round(at - origin)).padStart(6)}ms  ${label}`);

let compact = "";
let exact = "";
try {
  [compact, exact] = await chain(ev, mark, async () => {
    origin = await ev<number>("return Math.round(performance.now())");
    await ev(`
      window.__ui = { tasks: [], notes: [] };
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__ui.tasks.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ entryTypes: ['longtask'] });
      let last = '';
      setInterval(() => {
        const notes = document.querySelectorAll('p.note');
        const text = notes.length ? notes[notes.length - 1].textContent.replace(/\\d+%$/, '') : '';
        if (text !== last) { last = text; window.__ui.notes.push([Math.round(performance.now()), text]); }
      }, 20);
      return true;
    `);
    console.log("界面链：");
  });

  const pairs = [
    ["紧凑", compact],
    ["可逆", exact],
  ] as const;
  for (const [mode, line] of pairs) {
    if (line.includes("还原度")) {
      for (const label of ["原图", "有损", "半尺寸"])
        if (!line.includes(`${label} `)) failures.push(`${mode}档质检里缺「${label}」那一项：${line}`);
    } else if (!line.includes("完全一致")) failures.push(`${mode}档质检没给出结论：${line}`);
  }

  const seen = await ev<{ tasks: [number, number][]; notes: [number, string][] }>("return window.__ui");
  console.log("  阶段（按 p.note 的文案变化还原）：");
  for (const [at, text] of seen.notes) mark(text || "（静默）", at);
  const total = seen.tasks.reduce((sum, [, ms]) => sum + ms, 0);
  console.log(`  主线程长任务（>50ms）：${seen.tasks.length} 个，合计 ${total}ms`);
  for (const [at, ms] of seen.tasks) mark(`阻塞 ${ms}ms`, at);
} catch (e) {
  failures.push(String(e));
  console.log("  当前 facts：", await ev<string>(FACTS).catch(() => "(取不到)"));
} finally {
  await session.stop();
  server.stop();
  if (staged) await rm(staged, { recursive: true, force: true });
}

if (BASELINE && compact && exact) {
  console.log(`\n基线对照（${BASELINE}）：`);
  const port = PORT + 2;
  const theirServer = serve(port, { dir: BASELINE });
  const theirSession = await open({
    port: port + 1000,
    size: [1200, 900],
    url: `http://127.0.0.1:${port}/`,
  });
  let theirs: readonly [string, string] = ["", ""];
  try {
    theirs = await chain(theirSession.ev, () => {});
  } catch (e) {
    failures.push(`基线那一遍没走通：${String(e)}`);
  } finally {
    await theirSession.stop();
    theirServer.stop();
  }
  const compared = [
    ["紧凑", compact, theirs[0]],
    ["可逆", exact, theirs[1]],
  ] as const;
  for (const [mode, mine, their] of compared) {
    const same = mine === their;
    console.log(`  ${mode}档：${same ? "与基线逐字符相同" : "*** 与基线有差异 ***"}`);
    if (!same)
      failures.push(`基线对照《${mode}档》不一致：\n      候选 ${mine}\n      基线 ${their}`);
  }
}

if (errs.length) failures.push(...errs.slice(0, 5));
if (failures.length) {
  console.error(`\n不合格 ${failures.length} 项：`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log(
  `\n界面链通过：演示 / 质检（紧凑与可逆各一次）/ 重建相位 都到位，页面零异常` +
    (BASELINE ? "，两行数字与基线逐字符相同" : ""),
);
process.exit(0);

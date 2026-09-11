// 真应用的界面链体检：演示 → 质检 → 重建相位，顺带报一遍主线程长任务。
//
// 为什么要有它：数值实现整段搬进内核之后，「**哪一侧忘了挂内核**」不会在编译期或单元测试里
// 现形 —— 读图链住在主线程（要 canvas），内核却是 worker 先挂上的那份，wasm 实例又不跨线程。
// 实测症状：拖进一张频谱图后点质检，`.facts` 停在采样率那一行不动，控制台一条
// 「数值内核还没挂上」。这条链因此必须有一条**真页面**的门禁，而它同时走过了
// 主线程那份内核的每一个消费者（`imageToSpectrum` 读图、`spectrumToPng` 出图、
// `audit` 的读回）与 worker 的 `synthesise` / `compare`。
//
// 判据是**确定性的三项**：三次交互都等到自己的就绪态、页面零异常、零 console.error。
// 长任务只报数不设阈值（同 `perf.ts` 的理由：它随机器快慢浮动）。
//
// 用法：`bun run build:web && bun bench/ui.ts`（读 `dist/`，不是 dev server）。
import { open, serveDir, waitFor } from "./cdp";

const PORT = Number(process.env.UI_PORT ?? 4399);
const project = `${import.meta.dir}/..`;

const press = (label: string): string =>
  `[...document.querySelectorAll('button.act')].find(b => (b.textContent ?? '').trim() === ${JSON.stringify(label)})?.click(); 1`;

const server = serveDir(PORT, `${project}/dist`);
const session = await open({
  port: PORT + 1000,
  size: [1200, 900],
  url: `http://127.0.0.1:${PORT}/`,
});
const ev = session.ev;
const facts = (): Promise<string> =>
  ev<string>("return document.querySelector('p.facts')?.textContent ?? ''");

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

/** 拉一条相对起点的时间轴：`p.note` 的文案变化 + 长任务各占一行。 */
let from = 0;
const mark = (label: string, at = performance.now()) =>
  console.log(`  ${String(Math.round(at - from)).padStart(6)}ms  ${label}`);

try {
  await waitFor("应用载入", async () =>
    (await ev<number>("return document.querySelector('.drop') ? 1 : 0")) ? 1 : null,
  );
  from = await ev<number>("return Math.round(performance.now())");
  console.log("界面链：");

  // 长任务与阶段文案的观察器都装在**用户动作之前** —— 装晚了会漏掉开头那几段。
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

  await ev(press("演示"));
  await waitFor(
    "演示就绪（解码 + 编码 + 出图）",
    async () => ((await ev<number>("return document.querySelector('.spec') ? 1 : 0")) ? 1 : null),
    120000,
  );
  mark("演示就绪");

  // 质检：读回刚出的 PNG（主线程）→ 还原（worker）→ 比指标（worker）。
  await ev(press("质检"));
  const line = await waitFor(
    "质检结果",
    async () => {
      const t = await facts();
      return t.includes("还原度") ? t : null;
    },
    60000,
  );
  mark(`质检完成  ${line}`);
  for (const label of ["原图", "有损", "半尺寸"])
    if (!line.includes(`${label} `)) failures.push(`质检结果里缺「${label}」那一项：${line}`);

  // 重建相位：精修档（更多迭代 + GL 打磨）整段在 worker 里，就绪态是 facts 末尾那句提示。
  await ev(press("重建相位"));
  await waitFor("精修完成", async () => ((await facts()).includes("相位已重建") ? true : null), 120000);
  mark("相位已重建");

  const seen = await ev<{ tasks: [number, number][]; notes: [number, string][] }>("return window.__ui");
  console.log("  阶段（按 p.note 的文案变化还原）：");
  for (const [at, text] of seen.notes) mark(text || "（静默）", at);
  const total = seen.tasks.reduce((sum, [, ms]) => sum + ms, 0);
  console.log(`  主线程长任务（>50ms）：${seen.tasks.length} 个，合计 ${total}ms`);
  for (const [at, ms] of seen.tasks) mark(`阻塞 ${ms}ms`, at);
} catch (e) {
  failures.push(String(e));
  console.log("  当前 facts：", await facts().catch(() => "(取不到)"));
} finally {
  await session.stop();
  server.stop(true);
}

if (errs.length) failures.push(...errs.slice(0, 5));
if (failures.length) {
  console.error(`\n不合格 ${failures.length} 项：`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log("\n界面链通过：三次交互都到位，页面零异常");

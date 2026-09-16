import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { open, serve, sleep, waitFor } from "./cdp.ts";

const PORT = Number(process.env.UI_PORT ?? 4399);
const project = `${import.meta.dirname}/..`;
const SUBPATH = process.env.SUBPATH ?? "";
const BASELINE = process.env.UI_BASELINE ?? "";

type Ev = <R = unknown>(expression: string) => Promise<R>;

const INSTRUMENT = `
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
  const live = new Set();
  window.__synth = { posted: 0, inflight: 0 };
  window.__jobs = { posted: {}, cancelled: {}, aborted: {}, done: {}, encodes: 0 };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const post = this.postMessage.bind(this);
      this.postMessage = (message, ...rest) => {
        if (message && message.kind === "synthesise") {
          window.__synth.posted += 1;
          window.__synth.inflight += 1;
          live.add(message.id);
        }
        if (message && message.kind === "audit") window.__jobs.posted[message.id] = 1;
        if (message && message.kind === "encode") window.__jobs.encodes += 1;
        if (message && message.kind === "cancel" && Array.isArray(message.ids))
          for (const id of message.ids) window.__jobs.cancelled[id] = 1;
        post(message, ...rest);
      };
      this.addEventListener("message", (event) => {
        const data = event.data;
        if (data && live.has(data.id) && data.kind !== "progress") {
          live.delete(data.id);
          window.__synth.inflight -= 1;
        }
        if (data && window.__jobs.posted[data.id]) {
          if (data.kind === "aborted") window.__jobs.aborted[data.id] = 1;
          if (data.kind === "done") window.__jobs.done[data.id] = 1;
        }
      });
    }
  };
`;

const PLAY = `(() => {
   const b = document.querySelector('button.icon-btn');
   if (!b) throw new Error("界面上没有播放按钮");
   b.click();
   return 1;
 })()`;

const PLAYING = `return document.querySelector('button.icon-btn')?.getAttribute('aria-label') === "暂停" ? 1 : 0`;

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
  probe = false,
  chrome = false,
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

  if (chrome) await chromeChecks(ev, mark);

  // 参数收在「进阶」卡片里，先展开它，后面按 chip 才打在真界面上。
  // 主构建那一遍的存在性由上面的 chromeChecks 钉住，所以这里的容错不会盖掉漏洞。
  await ev(`
    const d = document.querySelector('details.more');
    if (d && !d.open) d.querySelector('summary')?.click();
    return 1;
  `);

  if (probe) {
    const posted = await waitFor(
      "后台预载开始",
      async () => {
        const s = await ev<{ posted: number; inflight: number }>("return window.__synth");
        return s.posted >= 1 ? s.posted : null;
      },
      10000,
    ).catch(() => 0);
    const baked = posted
      ? await waitFor(
          "后台预载完成",
          async () => {
            const s = await ev<{ posted: number; inflight: number }>("return window.__synth");
            return s.inflight === 0 ? s : null;
          },
          120000,
        ).catch(() => null)
      : null;
    if (!baked)
      failures.push("演示就绪后 worker 没把「还原」算完：点播放仍然要现算，那段等待会落在用户身上");
    else {
      const ms = await ev<number>(`
        return await new Promise((done) => {
          const b = document.querySelector('button.icon-btn');
          const t0 = performance.now();
          const mo = new MutationObserver(() => {
            if (b.getAttribute('aria-label') === '暂停') {
              mo.disconnect();
              done(Math.round(performance.now() - t0));
            }
          });
          mo.observe(b, { attributes: true, attributeFilter: ['aria-label'] });
          b.click();
          setTimeout(() => { mo.disconnect(); done(-1); }, 60000);
        });
      `);
      await ev(PLAY);
      await waitFor("停下", async () => ((await ev<number>(PLAYING)) ? null : 1));
      const after = await ev<{ posted: number; inflight: number }>("return window.__synth");
      mark(`点播放到出声 ${ms} ms（材料就绪时已算 ${baked.posted} 次）`);
      if (ms < 0) failures.push("点了播放但一直没有出声");
      else if (after.posted !== baked.posted)
        failures.push(
          `点播放又让 worker 现算了一遍「还原」（${baked.posted} → ${after.posted}）：材料就绪时没有把它算掉`,
        );
    }
  }

  await ev(`
    window.__auditBtn = [];
    const mo = new MutationObserver(() => {
      const b = [...document.querySelectorAll('button.act')].find(v => v.textContent.startsWith('质检'));
      if (b) window.__auditBtn.push(b.textContent.trim());
    });
    mo.observe(document.querySelector('.acts'), { subtree: true, childList: true, characterData: true });
  `);
  await ev(press("button.act", "质检"));
  const compact = await waitFor(
    "紧凑档质检",
    async () => {
      const t = await ev<string>(FACTS);
      return t.includes("谱距离") ? t : null;
    },
    60000,
  );
  mark(`紧凑档质检  ${compact}`);

  const pcts = [
    ...new Set(
      ((await ev<string[]>("return window.__auditBtn")) ?? [])
        .map(t => /^质检 (\d+)%$/.exec(t)?.[1])
        .filter(Boolean),
    ),
  ];
  if (!pcts.length) failures.push("质检进行中按钮没出现「质检 N%」进度：worker 的 progress 没接到 UI");
  else if (pcts.length < 2) failures.push(`质检进度只出现一个档位（${pcts.join(",")}）：看不到推进`);

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
      return (t.includes("相关度，信噪比") || t.includes("自检")) && t !== rendered ? t : null;
    },
    60000,
  );
  mark(`可逆档质检  ${exact}`);

  await ev(`
    const audit = [...document.querySelectorAll('button.act')].find(v => v.textContent.trim() === '质检');
    const chip = [...document.querySelectorAll('button.chip')].find(v => v.textContent.trim() === '紧凑');
    if (!audit || audit.disabled) throw new Error("质检按钮不可用");
    if (!chip || chip.disabled) throw new Error("紧凑档按钮不可用");
    audit.click();
    chip.click();
    return 1;
  `);
  const jobs = await waitFor(
    "质检在改参数后被收回",
    async () => {
      const j = await ev<{
        posted: Record<string, number>;
        cancelled: Record<string, number>;
        aborted: Record<string, number>;
        encodes: number;
      }>("return window.__jobs");
      return Object.keys(j.posted).length >= 3 &&
        Object.keys(j.cancelled).length >= 1 &&
        Object.keys(j.aborted).length >= 1 &&
        j.encodes >= 1
        ? j
        : null;
    },
    60000,
  ).catch(() => null);
  if (!jobs)
    failures.push(
      "质检进行中改参数：在跑的质检没被取消而是烧到结束（堵住 worker，新编码只能排队等它）",
    );
  else mark(`质检改参数即收回（收到 cancel 的作业 ${Object.keys(jobs.cancelled).length} 个）`);

  // —— 图片往返：读回存出的可逆 PNG，相位提示与「重建相位」按钮必须一致 ——
  // （回归防护：曾出现「提示说可重建、按钮却消失」——载入后重编码换了谱，提示却按旧图留着）
  await ev(press("button.chip", "可逆"));
  await waitFor(
    "可逆档出图（往返用）",
    async () => {
      const t = await ev<string>(FACTS);
      return t.includes("可逆模式") && (await ev<number>(enabled("质检"))) ? t : null;
    },
    120000,
  );

  await ev(`
    window.__capBlob = null;
    window.__capName = null;
    const origURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob) window.__capBlob = b; return origURL(b); };
    const proto = HTMLElement.prototype;
    const origClick = proto.click;
    proto.click = function () {
      if (this.tagName === 'A' && this.download) { window.__capName = this.download; return 1; }
      return origClick.call(this);
    };
    return 1;
  `);
  await ev(press("button.act", "存频谱图"));
  const roundtrip = await ev<{ size: number; label: string; encodes: number; name: string }>(`
    if (!window.__capBlob || !window.__capName) throw new Error("存频谱图没有产生可截获的 PNG");
    const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
    const drop = async (blob, name) => {
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type: name.endsWith(".jpg") ? "image/jpeg" : "image/png" }));
      const target = document.querySelector('.app');
      if (!target) throw new Error("界面上没有拖放目标");
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    };
    window.__dropPng = () => drop(window.__capBlob, window.__capName);
    window.__dropJpeg = async q => {
      const bmp = await createImageBitmap(window.__capBlob);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * 0.7);
      c.height = Math.round(bmp.height * 0.7);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const jpeg = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      await drop(jpeg, window.__capName.replace(/\\.png$/i, '.jpg'));
      return jpeg.size;
    };
    return { size: window.__capBlob.size, label: "PNG " + kb(window.__capBlob.size), encodes: window.__jobs.encodes, name: window.__capName };
  `);
  mark(`截获 ${roundtrip.name}（${roundtrip.size} 字节）`);

  await ev("return window.__dropPng()");
  await waitFor(
    "无损 PNG 读回",
    async () => ((await ev<string>(FACTS)).includes("相位已载入") ? true : null),
    60000,
  );
  const pngLine = await ev<string>(FACTS);
  if (!pngLine.includes(roundtrip.label))
    failures.push(`无损 PNG 读回后显示的尺寸与原文件不符（${pngLine.match(/PNG [^；]+/)?.[0]}，应为 ${roundtrip.label}）：作业应直接用读回的文件`);
  if (await ev<number>(enabled("重建相位")))
    failures.push("无损可逆 PNG 读回：出现了「重建相位」按钮（相位完整，无需重建）");
  if ((await ev<string>(FACTS)).includes("点「重建相位」"))
    failures.push("无损可逆 PNG 读回：出现了相位重建提示");
  if ((await ev<number>("return window.__jobs.encodes")) !== roundtrip.encodes)
    failures.push(`无损 PNG 读回发生了重编码（${roundtrip.encodes}→）：读回的谱应直接作为作业，参考相位不应被扔掉`);

  await ev("return window.__dropJpeg(0.08)");
  const damaged = await waitFor(
    "读回受损伤的 JPEG",
    async () => {
      const t = await ev<string>(FACTS);
      if (t.includes("点「重建相位」")) return { line: t, err: "" };
      const err = await ev<string>(
        "return document.querySelector('.note.is-error')?.textContent ?? ''",
      );
      return err ? { line: t, err } : null;
    },
    60000,
  ).catch(() => null);
  if (!damaged || damaged.err) {
    const factsNow = await ev<string>(FACTS);
    failures.push(
      `读回受损 JPEG 未完成：${damaged?.err || "超时；相位参考既未判弱也未报错（伤害可能没被识别）"}；当前 facts：${factsNow}`,
    );
  } else {
    const weakBtn = await ev<number>(enabled("重建相位"));
    if (!weakBtn)
      failures.push(`受损图读回：有重建提示却没有「重建相位」按钮——${damaged.line}`);
    else mark("受损图读回：重建提示与按钮一致，参考相位可借");
  }

  return [compact, exact];
}

interface MoreState {
  open: boolean;
  height: number;
  slack: number;
  shown: boolean;
}

const MORE_PROBE = `
  const details = document.querySelector('details.more');
  const chip = [...document.querySelectorAll('button.chip')].find(v => v.textContent.trim() === '可逆');
  if (!details || !chip) return null;
  const head = details.querySelector('summary').getBoundingClientRect();
  const cs = getComputedStyle(details);
  const frame = head.height
    + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return {
    open: details.open,
    height: Math.round(details.getBoundingClientRect().height),
    slack: Math.round(details.getBoundingClientRect().height - frame),
    shown: chip.checkVisibility(),
  };
`;

interface Narrow {
  cw: number;
  over: number;
  clipped: string[];
  shell: number;
  spec: number;
  acts: number;
}

// .app 是 overflow-x: hidden，横向溢出不会冒到 document 上（documentElement 的 scrollWidth
// 恒等于 clientWidth），只会被悄悄裁掉 —— 所以要逐个元素量，不能只看文档宽度。
const SCAN_NARROW = `
  const scan = () => {
    const w = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().width ?? 0);
    const app = document.querySelector('.app');
    const clipped = [];
    for (const el of app.querySelectorAll('*'))
      if (el.scrollWidth > el.clientWidth + 1)
        clipped.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] +
          ' ' + el.clientWidth + '→' + el.scrollWidth);
    return {
      cw: document.documentElement.clientWidth,
      over: app.scrollWidth - app.clientWidth,
      clipped: clipped.slice(0, 5),
      shell: w('.shell'),
      spec: w('.spec'),
      acts: w('.acts'),
    };
  };
`;

// 只在主构建那一遍跑：基线是旧产物，没有「进阶参数」与「关于」这两块界面。
async function chromeChecks(ev: Ev, mark: (label: string) => void): Promise<void> {
  // 没打开的弹窗必须在页面里不占位：作者的 .about 一旦压过 UA 的
  // `dialog:not([open]) { display: none }`，它就会以 absolute + margin:auto 叠在页面上。
  const idle = await ev<{ display: string; shown: boolean } | null>(`
    const d = document.querySelector('dialog.about');
    if (!d) throw new Error("界面上没有关于弹窗");
    return { display: getComputedStyle(d).display, shown: d.checkVisibility() };
  `);
  if (!idle) failures.push("界面上没有关于弹窗");
  else if (idle.shown || idle.display !== "none")
    failures.push(`没打开的关于弹窗还占着页面（display: ${idle.display}）：样式压过了 dialog:not([open])`);
  else mark("关于弹窗默认不占页面");

  const shut = await ev<MoreState | null>(MORE_PROBE);
  if (!shut) failures.push("界面上没有「进阶参数」卡片或参数控件");
  else if (shut.open || shut.shown)
    failures.push("进阶参数一上来就露在界面上：小白默认态不该带着这些参数");
  // 收起时除摘要行与自身的边框内边距外不该再多出任何高度：details 一旦被摆成 flex 容器，
  // 隐藏的正文仍会占掉一个 gap（实测 8px），而「展开后变高、参数可见」那两条看不见它。
  else if (Math.abs(shut.slack) > 1)
    failures.push(`收起的「进阶参数」仍为隐藏的参数留了 ${shut.slack}px 空隙：卡片不能当弹性容器摆`);
  else mark(`进阶参数默认收起（卡片 ${shut.height}px）`);

  // 用 checkVisibility 而不是 getBoundingClientRect：收起的 details 里，后者仍返回旧盒子。
  await ev(`document.querySelector('details.more > summary').click(); return 1`);
  const expanded = await ev<MoreState | null>(MORE_PROBE);
  if (!expanded || !expanded.open || !expanded.shown)
    failures.push("点开「进阶参数」后参数仍不可见：展开开关坏了");
  else if (expanded.height <= (shut?.height ?? 0))
    failures.push(`展开「进阶参数」后卡片没变高（${shut?.height} → ${expanded.height}）：参数没被放出来`);
  else mark(`进阶参数展开后 ${expanded.height}px，参数可见`);

  await ev(`
    const b = document.querySelector('button.head-btn');
    if (!b) throw new Error("页头没有「关于」按钮");
    b.click();
    return 1;
  `);
  const about = await ev<{
    open: boolean;
    box: [number, number];
    inView: boolean;
    title: boolean;
    close: boolean;
  }>(`
    const d = document.querySelector('dialog.about');
    if (!d) throw new Error("界面上没有关于弹窗");
    const r = d.getBoundingClientRect();
    const head = document.querySelector('#about-title').getBoundingClientRect();
    const foot = document.querySelector('.about-foot button').getBoundingClientRect();
    const inside = (b) => b.height > 0 && b.top >= -1 && b.bottom <= window.innerHeight + 1;
    return {
      open: d.open,
      box: [Math.round(r.width), Math.round(r.height)],
      inView: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      title: inside(head),
      close: inside(foot),
    };
  `);
  if (!about.open) failures.push("点「关于」没有弹出弹窗");
  else if (!about.inView) failures.push(`关于弹窗没完整落在视口里（${about.box.join("×")}）`);
  else if (!about.title || !about.close)
    failures.push("关于弹窗的标题或「关闭」按钮不在视口里：正文把它们挤出屏幕了");
  else mark(`关于弹窗 ${about.box.join("×")}，标题与关闭都在视口内`);

  await ev(`document.querySelector('.about-foot button').click(); return 1`);
  if (await ev<boolean>(`return document.querySelector('dialog.about').open`))
    failures.push("在弹窗里点「关闭」没有关掉它");
  else mark("关于弹窗可关");
}

const staged = SUBPATH ? `${tmpdir()}/atools-subpath-${process.pid}` : "";
if (staged) await cp(`${project}/dist`, `${staged}${SUBPATH}`, { recursive: true });
const base = `http://127.0.0.1:${PORT}${SUBPATH}/`;
const server = serve(PORT, { dir: staged || `${project}/dist` });
const session = await open({ port: PORT + 1000, size: [1200, 900], url: "about:blank" });
const ev = session.ev;
await session.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });

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
  [compact, exact] = await chain(
    ev,
    mark,
    async () => {
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
    },
    true,
    true,
  );

  const pairs = [
    ["紧凑", compact],
    ["可逆", exact],
  ] as const;
  for (const [mode, line] of pairs) {
    if (line.includes("还原度") || line.includes("谱距离")) {
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

  // —— 窄屏：这是给手机设计的界面，320 宽下不许出现横向溢出 ——
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 640,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(400);
  const narrow = await ev<Narrow>(`${SCAN_NARROW}\nreturn scan();`);
  // 阳性对照：把谱图临时撑到 900px，同一套扫描必须报出溢出与出处。
  // 没有它，选择器写错或扫描本身退化会变成「对着什么都报没问题」—— 而那时它照样全绿。
  const forced = await ev<Narrow>(`${SCAN_NARROW}
    const st = document.createElement('style');
    st.textContent = '.spec { min-width: 900px; }';
    document.head.append(st);
    const out = scan();
    st.remove();
    return out;
  `);
  // cw 是这次断言的另一道阳性对照：视口没换成功的话，溢出检查会变成对着宽屏说「没问题」。
  if (narrow.cw !== 320) failures.push(`窄屏那一步没换到 320 宽（拿到 ${narrow.cw}）：检查本身没生效`);
  else if (!(forced.over > 0 && forced.clipped.length))
    failures.push(
      `窄屏溢出的扫描失效了：把谱图硬撑到 900px 也报不出溢出（外壳多出 ${forced.over}px，元素级读数 ${forced.clipped.length} 条）`,
    );
  else if (narrow.over > 0 || narrow.clipped.length)
    failures.push(
      `320 宽下有内容横向溢出并被裁掉：外壳多出 ${narrow.over}px；${narrow.clipped.join("，") || "（无元素级读数）"}`,
    );
  else mark(`320 宽无横向裁切（外壳 ${narrow.shell}、谱图 ${narrow.spec}、动作行 ${narrow.acts}）`);
  await session.send("Emulation.clearDeviceMetricsOverride", {});
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

// 性能体检：数值内核的比值对照 + 真实页面里加载一条长音频的主线程卡顿。
// 「比值」是机器无关的，可以当门禁；「长任务」随机器快慢浮动，只报数不设阈值。
// 用法：bun bench/perf.ts        （SECS=60 可改合成素材时长，PAGE=0 跳过浏览器那半）
import path from "node:path";
import type { Samples } from "../src/lib/arrays";
import { resample } from "../src/lib/resample";
import { open, serveDir, sleep } from "./cdp";

const project = path.resolve(import.meta.dir, "..");
const SECS = Number(process.env.SECS ?? 60);
const SR = 44100;

const signal = (n: number, sr: number): Samples => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = 0.5 * (0.4 + 0.6 * Math.sin((2 * Math.PI * 3 * i) / sr)) * Math.sin((2 * Math.PI * 220 * i) / sr);
  return out as Samples;
};

// 对照实现：与「相位表」逐位一致的逐样点现算版本（spectrum.test.ts 有比位用例钉着），
// 只用来量省下了多少，别拿它当第二份真相。
const naive = (x: Samples, from: number, to: number): Float32Array => {
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(x.length / ratio)));
  const nyq = 0.5 * Math.min(1, to / from);
  const fc = nyq * 0.92;
  const half = Math.min(64, Math.max(3, Math.round(2 / Math.max(fc, 1e-5))));
  for (let j = 0; j < out.length; j++) {
    const center = j * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;
    let acc = 0;
    let wsum = 0;
    for (let m = 1 - half; m <= half; m++) {
      const d = m - frac;
      const t = d / (half + 0.5);
      const w =
        (d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d)) *
        (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
      const i = i0 + m;
      if (i >= 0 && i < x.length) {
        acc += x[i]! * w;
        wsum += w;
      }
    }
    out[j] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
};

const failures: string[] = [];
let sink = 0;
const ms = (run: () => unknown, rounds = 3): number => {
  run();
  const at = performance.now();
  for (let i = 0; i < rounds; i++) sink += (run() as Float32Array).length;
  return (performance.now() - at) / rounds;
};

const pcm = signal(SR * SECS, SR);
console.log(`重采样相位表（${SECS}s @${SR / 1000}k，${(pcm.length / 1e6).toFixed(1)}M 样点）`);
console.log("  目标     相位表      逐样点现算     倍数");
for (const to of [8000, 16000, 48000]) {
  const table = ms(() => resample(pcm, SR, to));
  const plain = ms(() => naive(pcm, SR, to));
  const ratio = plain / table;
  console.log(
    `  ${String(to / 1000).padEnd(8)} ${table.toFixed(1).padStart(7)} ms ${plain.toFixed(1).padStart(11)} ms ${ratio.toFixed(1).padStart(8)}×`,
  );
  if (ratio < 3) failures.push(`→${to} 相位表只快 ${ratio.toFixed(1)}×，缓存没生效或又被绕过了`);
}

// 相位数最多的那几个组合：既约分母大 + 浮点漂移，实际相位数可达一万（11025→32000 实测 10001）。
// 相位表上限若设小了，这些组合会从「省钱」变成「每样点一次未命中 + 一次分配」，
// 曾经实测比逐样点现算还慢 1.18×。这里把它们钉住：慢于逐样点就是不合格。
console.log("\n相位种类最多的几个组合（相位表最容易退化的地方）");
console.log("  组合              样点      相位表      逐样点现算     倍数");
for (const [from, to] of [
  [11025, 16000],
  [11025, 32000],
  [22050, 32000],
  [11025, 8000],
] as [number, number][]) {
  const src = signal(from * SECS, from);
  const table = ms(() => resample(src, from, to));
  const plain = ms(() => naive(src, from, to));
  const ratio = plain / table;
  console.log(
    `${from}→${to}`.padEnd(18) +
      String(src.length).padStart(8) +
      `${table.toFixed(1)} ms`.padStart(12) +
      `${plain.toFixed(1)} ms`.padStart(14) +
      `${ratio.toFixed(2)}×`.padStart(9),
  );
  if (ratio < 1.05)
    failures.push(`${from}→${to} 相位表 ${ratio.toFixed(2)}× —— 相位种类超过预算时退化得比逐样点还慢`);
}

if (process.env.PAGE !== "0") {
  const PORT = Number(process.env.PORT ?? 4370);
  const CDP = PORT + 700;
  const WAV = `
    const sr = ${SR};
    const n = sr * ${SECS};
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const env = 0.4 + 0.6 * Math.sin((2 * Math.PI * 3 * i) / sr);
      pcm[i] = Math.round(12000 * env * Math.sin((2 * Math.PI * 220 * i) / sr));
    }
    const head = new ArrayBuffer(44);
    const view = new DataView(head);
    const put = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
    put(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); put(8, 'WAVE');
    put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    put(36, 'data'); view.setUint32(40, pcm.byteLength, true);
    return new File([head, pcm.buffer], 'perf.wav', { type: 'audio/wav' });
  `;

  const server = serveDir(PORT, `${project}/dist`);
  const session = await open({ port: CDP, size: [1200, 900], url: `http://127.0.0.1:${PORT}/` });
  try {
    await session.goto(`http://127.0.0.1:${PORT}/`, ".app");
    await session.ev(`
      window.__perf = { tasks: [], notes: [] };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__perf.tasks.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ entryTypes: ['longtask'] });
      let last = '';
      setInterval(() => {
        const note = document.querySelector('.note');
        const text = note ? note.textContent.replace(/\\d+%$/, '') : '';
        if (text !== last) { last = text; window.__perf.notes.push([Math.round(performance.now()), text]); }
      }, 20);
      return true;
    `);
    const from = await session.ev<number>(`return Math.round(performance.now());`);

    await session.ev(`
      const file = (() => { ${WAV} })();
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector('.app').dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      return true;
    `);
    for (let i = 0; i < 600; i++) {
      await sleep(500);
      if (await session.ev<boolean>(`return !!document.querySelector('.params');`)) break;
    }
    await sleep(500);

    const perf = await session.ev<{ tasks: [number, number][]; notes: [number, string][] }>(
      `return window.__perf;`,
    );
    const mark = (at: number) => `${String(at - from).padStart(6)}ms`;
    console.log(`\n真实页面：落一个 ${SECS}s 的 44.1k WAV，看默认参数（8k 紧凑）走完`);
    for (const [at, text] of perf.notes) console.log(`  ${mark(at)}  ${text || "（静默）"}`);
    console.log("  长任务（>50ms，含测量脚本自己合成 WAV 的开销）");
    let total = 0;
    for (const [at, ms] of perf.tasks) {
      total += ms;
      console.log(`  ${mark(at)}  阻塞 ${ms}ms`);
    }
    console.log(`  合计阻塞 ${total}ms，共 ${perf.tasks.length} 个长任务`);
  } finally {
    await session.stop();
    server.stop(true);
  }
}

void sink;
if (failures.length) {
  console.error(`\n不合格 ${failures.length} 项：`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log("\n性能体检通过");

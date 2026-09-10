import { open, sleep } from "./cdp";

const url = process.env.URL ?? "http://127.0.0.1:3000/";
const W = Number(process.env.W ?? 1200);
const H = Number(process.env.H ?? 900);
const TAG = process.env.TAG ?? `${W}`;
const CDP = 9700 + Math.floor(Math.random() * 200);

const problems: string[] = [];
const session = await open({
  port: CDP,
  size: [W, H],
  url,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

session.on(m => {
  if (m.method === "Runtime.exceptionThrown")
    problems.push(m.params?.exceptionDetails?.exception?.description ?? "exception");
  if (m.method === "Log.entryAdded" && m.params?.type === "error") problems.push(m.params.text ?? "log");
});

const ev = <T>(js: string): Promise<T> => session.ev<T>(js);

const click = (pattern: RegExp): Promise<string> =>
  ev<string>(`
    const b = [...document.querySelectorAll('button')].find((x) => ${pattern}.test(x.textContent ?? ''));
    b?.click();
    return b ? b.textContent.trim() : '';
  `);

/** 点某一档（按参数标签找，不依赖列序）。 */
const pick = (label: string, chip: string): Promise<string> =>
  ev<string>(`
    const l = [...document.querySelectorAll('.params .plabel')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    const c = l && [...l.nextElementSibling.querySelectorAll('.chip')].find((x) => x.textContent.trim() === ${JSON.stringify(chip)});
    c?.click();
    return c ? c.textContent.trim() : '(没找到)';
  `);

/** 等界面空下来（stage 的进度条消失）。 */
async function idle(patience = 120_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < patience) {
    if (!(await ev<boolean>(`return !!document.querySelector('.note-bar')`))) return true;
    await sleep(200);
  }
  return false;
}

/**
 * 等某个元素出现。**不能只等 `idle`** —— 点完「演示」到进度条冒出来之间有一段空档，
 * 这段空档里 `idle()` 立刻返回 true，接着读 `.params` 就是 null（曾偶发崩在
 * `getComputedStyle` 上，是门禁自身的假阴性）。
 */
async function appear(selector: string, patience = 120_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < patience) {
    if (await ev<boolean>(`return !!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(150);
  }
  return false;
}

/**
 * 按播放，直到这一次的录音真出现；返回本次截到的样本数（0 表示没响）。
 *
 * 播放前要先把**图里装的声音**还原出来，所以这里不能只 sleep 一个固定值 —— 短素材
 * 几百毫秒，长素材要好几秒。`keep` 为真时不停，留着继续播（验「播放中改参数」用）。
 */
async function play(patience = 120_000, keep = false): Promise<number> {
  const before = await ev<number>(`return window.__cap.length`);
  await ev(`document.querySelector('.icon-btn').click(); return 1`);
  const t0 = Date.now();
  let n = before;
  while (Date.now() - t0 < patience) {
    n = await ev<number>(`return window.__cap.length`);
    if (n > before) break;
    await sleep(150);
  }
  await sleep(500);
  if (!keep) await ev(`document.querySelector('.icon-btn').click(); return 1`); // 停
  const last = await ev<number | null>(`return window.__cap[window.__cap.length - 1]?.length ?? null`);
  return n > before ? (last ?? 0) : 0;
}

/** 等一份**新**的 PCM 被送进 AudioBuffer（不改参数、不按任何按钮）。 */
async function waitPushed(before: number, patience = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < patience) {
    if ((await ev<number>(`return window.__cap.length`)) > before) return true;
    await sleep(150);
  }
  return false;
}

try {
  await session.send("Log.enable");
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: W < 500,
  });
  await sleep(800);

  await session.shot(`/tmp/smoke-${TAG}-empty.png`);
  await click(/演示/);
  if (!(await appear(".params"))) problems.push("演示点下去之后参数面板一直没出现");
  if (!(await idle(60_000))) problems.push("演示加载完界面没停下来");
  await sleep(300);
  await session.shot(`/tmp/smoke-${TAG}-loaded.png`);

  // 取不到面板也要报「问题」，而不是把整轮门禁崩掉（缺元素时 querySelector 是 null）。
  const gridCols = await ev<string>(
    `const el = document.querySelector('.params');
     return el ? getComputedStyle(el).gridTemplateColumns : '(无参数面板)';`,
  );
  if (gridCols === "(无参数面板)") problems.push("参数面板没渲染出来");

  // 截住真正送进 AudioBuffer 的 PCM —— 界面「听到什么」只有这一条路能验。
  // 在演示加载完之后才装钩子，免得把解码器内部的拷贝也算进来。
  await ev(`
    window.__cap = [];
    const orig = AudioBuffer.prototype.copyToChannel;
    AudioBuffer.prototype.copyToChannel = function (src, ch) {
      window.__cap.push(new Float32Array(src));
      return orig.call(this, src, ch);
    };
    return 1;
  `);

  // 频谱图就是进度条：点一下就该从那里响起来。
  const [x, y] = await ev<[number, number]>(`
    const r = document.querySelector('.spec').getBoundingClientRect();
    return [r.left + r.width * 0.66, r.top + r.height / 2];
  `);
  for (const type of ["mousePressed", "mouseReleased"])
    await session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  const t0 = Date.now();
  let playing: string | null = null;
  while (Date.now() - t0 < 60_000) {
    playing = await ev<string | null>(`return document.querySelector('.icon-btn')?.getAttribute('aria-label')`);
    if (playing === "暂停") break;
    await sleep(150);
  }
  if (playing !== "暂停") problems.push("点频谱图后没有开始播放");
  const head = await ev<[string, number, number]>(`
    const h = document.querySelector('.spec-head');
    const s = h.getBoundingClientRect();
    const p = document.querySelector('.spec').getBoundingClientRect();
    return [h.style.opacity, Math.round(s.left - p.left), Math.round(p.right - s.right)];
  `);
  await ev(`document.querySelector('.icon-btn').click(); return 1`);
  await session.shot(`/tmp/smoke-${TAG}-playing.png`);

  // 参数必须进到耳朵里：位深只改图，但播的必须是图里装的声音 ——
  // 曾经播的是编码前的原声，于是 2bit 与 8bit 听起来一模一样（差 0 dB），
  // 用户报「调低位深没感觉、像是没应用」。
  const records: number[] = [];
  for (const bits of ["2", "8"]) {
    const got = await pick("位深", bits);
    if (got === "(没找到)") problems.push(`参数面板里没有位深 ${bits}`);
    if (!(await idle())) problems.push(`切到位深 ${bits} 后界面没停下来`);
    await sleep(200);
    records.push(await play());
  }
  const [low, high] = records as [number, number];
  if (low === 0 || high === 0) problems.push(`换位深后没截到播放的音频（${low} / ${high}）`);
  else if (low !== high) problems.push(`两种位深播出的样本数不同（${low} / ${high}）`);
  else {
    const rel = await ev<number | null>(`
      const [a, b] = window.__cap.slice(-2);
      let num = 0, den = 0;
      for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; num += d * d; den += a[i] * a[i]; }
      return num === 0 ? null : 10 * Math.log10(num / den);
    `);
    if (rel === null || rel < -30)
      problems.push(
        rel === null
          ? "2bit 与 8bit 播出的竟然是同一段音频 —— 位深没进到声音里"
          : `2bit 与 8bit 的播出差异只有 ${rel.toFixed(1)} dB —— 位深几乎没进到声音里`,
      );
    else console.log(`  位深差异: ${rel.toFixed(1)} dB（${low} 样本）`);
  }

  /**
   * 播放**中**改参数：耳朵必须跟着最新那张图走。
   *
   * 界面上写着「位深 2」，耳朵里却还是上一张图的 8bit —— 用户会以为参数没生效。
   * 这条只在本来就在放时成立（闲着调参数不该触发还原，那是按需算的前提），
   * 且在等待期间旧的那声继续放，新的一份就绪后原地接上。
   */
  await pick("位深", "8");
  if (!(await idle())) problems.push("切回位深 8 后界面没停下来");
  await ev(`window.__cap.length = 0; return 1`);
  if ((await play(120_000, true)) === 0) problems.push("对照组：播放时没截到音频");
  if ((await ev<string | null>(`return document.querySelector('.icon-btn')?.getAttribute('aria-label')`)) !== "暂停")
    problems.push("对照组：按下播放后没在播");
  const beforeCount = await ev<number>(`return window.__cap.length`);
  await pick("位深", "4");
  if (!(await waitPushed(beforeCount)))
    problems.push("播放中改位深后，耳朵里还是上一张图的声音（没有自动换成新的一份）");
  else {
    const label = await ev<string | null>(`return document.querySelector('.icon-btn')?.getAttribute('aria-label')`);
    if (label !== "暂停") problems.push("换上新的一份之后没有接着放");
    else console.log(`  播放中改参数：自动换到新的 PCM 并续播 ✓`);
  }
  await ev(`document.querySelector('.icon-btn').click(); return 1`);
  if (!(await idle())) problems.push("停止播放后界面没停下来");

  await click(/质检/);
  const tq = Date.now();
  while (Date.now() - tq < 60_000) {
    if (!(await ev<boolean>(`return /质检中/.test(document.querySelector('.acts')?.textContent ?? '')`))) break;
    await sleep(300);
  }
  const facts = await ev<string>(
    `return [...document.querySelectorAll('.facts')].map((x) => x.textContent).join(' | ')`,
  );
  await session.shot(`/tmp/smoke-${TAG}-audit.png`);

  console.log(`── ${W}×${H}`);
  console.log("  参数列:", String(gridCols).slice(0, 90));
  console.log("  播放键:", playing, " 竖线[透明度,距左,距右]:", JSON.stringify(head));
  console.log("  自检:", String(facts).replace(/\s+/g, " ").slice(0, 320));
} finally {
  await session.stop();
}

console.log("  问题:", problems.length ? problems.slice(0, 4).join(" || ") : "(none)");
process.exit(problems.length ? 1 : 0);

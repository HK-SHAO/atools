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

const click = (pattern: RegExp): Promise<string> =>
  session.ev<string>(`
    const b = [...document.querySelectorAll('button')].find((x) => ${pattern}.test(x.textContent ?? ''));
    b?.click();
    return b ? b.textContent.trim() : '';
  `);

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
  await sleep(3000);
  await session.shot(`/tmp/smoke-${TAG}-loaded.png`);

  const gridCols = await session.ev<string>(
    `return getComputedStyle(document.querySelector('.params')).gridTemplateColumns`,
  );

  const [x, y] = await session.ev<[number, number]>(`
    const r = document.querySelector('.spec').getBoundingClientRect();
    return [r.left + r.width * 0.66, r.top + r.height / 2];
  `);
  for (const type of ["mousePressed", "mouseReleased"])
    await session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await sleep(900);

  const playing = await session.ev<string | null>(
    `return document.querySelector('.icon-btn')?.getAttribute('aria-label')`,
  );
  const head = await session.ev<[string, number, number]>(`
    const h = document.querySelector('.spec-head');
    const s = h.getBoundingClientRect();
    const p = document.querySelector('.spec').getBoundingClientRect();
    return [h.style.opacity, Math.round(s.left - p.left), Math.round(p.right - s.right)];
  `);
  await session.shot(`/tmp/smoke-${TAG}-playing.png`);

  await click(/质检/);
  await sleep(Number(process.env.WAIT ?? 9000));
  const facts = await session.ev<string>(
    `return [...document.querySelectorAll('.facts')].map((x) => x.textContent).join(' | ')`,
  );
  await session.shot(`/tmp/smoke-${TAG}-audit.png`);

  console.log(`── ${W}×${H}`);
  console.log("  参数列:", String(gridCols).slice(0, 90));
  console.log("  播放键:", playing, " 竖线[透明度,距左,距右]:", JSON.stringify(head));
  console.log("  自检:", String(facts).replace(/\s+/g, " ").slice(0, 320));
  console.log("  问题:", problems.length ? problems.slice(0, 4).join(" || ") : "(none)");
} finally {
  await session.stop();
}

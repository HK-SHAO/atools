// PWA 门禁：先 bun run build:web，再验证 manifest 可装 + 应用壳离线可用。
// 离线判据是「cache: 'reload' 仍 200」——该模式强制绕过 HTTP 缓存。
// 「断网」不靠 CDP 模拟（实测 Network.emulateNetworkConditions 对本机回环不起作用），
// 而是直接关掉 HTTP 服务：源真的不可达，浏览器无从糊弄；
// 同时探一个从没请求过的地址作对照，它若不为 0 就说明这门禁是空的。
import path from "node:path";
import { open, serveDir, sleep, waitFor } from "./cdp";

const project = path.resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 4380);
const CDP = PORT + 700;
const APP = `http://127.0.0.1:${PORT}/`;
const CONTROL = "./__offline-control__";

const failures: string[] = [];
const fail = (why: string) => failures.push(why);

interface Manifest {
  mime: string | null;
  name: string;
  start: string;
  scope: string;
  root: string;
  display: string;
  icons: [string, number][];
}

const INSPECT = `
  const link = (rel) => document.querySelector('link[rel="' + rel + '"]');
  const href = (rel) => (link(rel) ? new URL(link(rel).href, location.href).href : null);
  return {
    href: {
      script: document.querySelector('script[type="module"]')?.src ?? null,
      style: href('stylesheet'),
      manifest: href('manifest'),
      icon: href('icon'),
      apple: href('apple-touch-icon'),
    },
    hook: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content ?? null,
    controlled: !!navigator.serviceWorker.controller,
  };
`;

const CACHED = `
  const out = [];
  for (const key of await caches.keys()) {
    const cache = await caches.open(key);
    out.push(...(await cache.keys()).map((r) => new URL(r.url).pathname));
  }
  return out;
`;

const server = serveDir(PORT, `${project}/dist`);
let serving = true;
const shutDown = (): void => {
  if (!serving) return;
  serving = false;
  server.stop(true);
};
const session = await open({ port: CDP, size: [1200, 900], url: APP });
const status = async (url: string | null): Promise<number> =>
  url
    ? session.ev<number>(
        `return await fetch(${JSON.stringify(url)}, { cache: 'reload' }).then((r) => r.status, () => 0);`,
      )
    : 0;

try {
  await session.goto(APP, ".app");
  const ready = await session.ev<boolean>(`
    if (!('serviceWorker' in navigator)) return false;
    return await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((done) => setTimeout(() => done(false), 10000)),
    ]);
  `);
  if (!ready) fail("Service Worker 十秒内没就绪：没注册上，或浏览器拒绝了（非安全上下文？）");
  else console.log("已注册：dist/sw.js");

  if (!(await session.ev<boolean>(`return !!navigator.serviceWorker.controller;`)))
    fail("注册完成后当前页面仍未受控（clients.claim 没生效，首次访问要等下次加载才离线可用）");

  await session.goto(APP, ".app");
  const online = await session.ev<{
    href: Record<string, string | null>;
    hook: string | null;
    controlled: boolean;
  }>(INSPECT);
  if (!online.controlled) fail("二次加载后页面仍不受 Service Worker 控制");

  const manifest = await session.ev<Manifest | null>(`
    const url = document.querySelector('link[rel="manifest"]').href;
    const response = await fetch(url, { cache: 'reload' });
    const json = await response.json();
    const icons = [];
    for (const icon of json.icons ?? [])
      icons.push([icon.src, await fetch(new URL(icon.src, url).href).then((r) => r.status, () => 0)]);
    return {
      mime: response.headers.get('content-type'),
      name: json.name,
      start: new URL(json.start_url, url).pathname,
      scope: new URL(json.scope, url).pathname,
      root: new URL('./', location.href).pathname,
      display: json.display,
      icons,
    };
  `);

  if (!manifest) fail("index.html 没有 <link rel=manifest>");
  else {
    console.log(`manifest：${manifest.name}  ${manifest.mime}  display=${manifest.display}`);
    if (!manifest.mime?.includes("manifest"))
      fail(`manifest 的 MIME 是 ${manifest.mime}，应为 application/manifest+json`);
    if (manifest.display !== "standalone") fail(`display=${manifest.display}，装不成独立窗口`);
    // manifest 必须落在应用根：它一旦挪进子目录，scope/start_url 会被解析成那个子目录
    if (manifest.scope !== manifest.root || manifest.start !== manifest.root)
      fail(`scope/start_url 解析成 ${manifest.scope}/${manifest.start}，应用根是 ${manifest.root}`);
    for (const [src, code] of manifest.icons)
      if (code !== 200)
        fail(`manifest 图标 ${src} 拿不到（${code}）—— manifest 的内容不经过打包器改写，得按字面路径部署`);
  }

  for (const [what, url] of [
    ["apple-touch-icon", online.href.apple],
    ["favicon", online.href.icon],
  ] as [string, string | null][]) {
    const code = await status(url);
    if (code !== 200) fail(`${what} 拿不到（${code}）：iOS 加主屏会退化成截图`);
  }
  if (online.hook !== "yes") fail(`apple-mobile-web-app-capable=${online.hook}，iOS 独立窗口起不来`);

  const shell =
    (await waitFor(
      "应用壳入缓存",
      async () => {
        const cached = await session.ev<string[]>(CACHED);
        return cached.length >= 6 ? cached : null;
      },
      10000,
    ).catch(() => null)) ?? [];
  if (!shell.length) fail("Service Worker 一项都没预缓存");
  for (const [what, at] of [
    ["index.html", "/index.html"],
    ["入口脚本", new URL(online.href.script!).pathname],
    ["样式", new URL(online.href.style!).pathname],
    ["manifest", new URL(online.href.manifest!).pathname],
    ["favicon", new URL(online.href.icon!).pathname],
  ] as [string, string][])
    if (!shell.includes(at)) fail(`预缓存里没有${what}（${at}）`);
  console.log(`预缓存 ${shell.length} 项：${shell.join(" ")}`);

  await session.ev(`
    const b = [...document.querySelectorAll('button')].find((x) => /演示/.test(x.textContent ?? ''));
    b?.click();
    return !!b;
  `);
  const loaded = await waitFor("演示载入", () =>
    session.ev<boolean>(`return !!document.querySelector('.spec');`),
  ).catch(() => false);
  const grown = await waitFor(
    "演示资源入缓存",
    async () => {
      const cached = await session.ev<string[]>(CACHED);
      return cached.length > shell.length ? cached : null;
    },
    8000,
  ).catch(() => null);
  const demo = (grown ?? []).filter(entry => entry.endsWith(".ogg"));
  if (!loaded) fail("演示没能载入");
  if (!demo.length) fail("演示音频没进运行期缓存：用过一次的素材应当离线可用");
  else console.log(`运行期缓存 +${grown!.length - shell.length} 项（含演示音频 ${demo.join(" ")}）`);

  console.log("关掉 HTTP 服务：这个源真的不可达了");
  shutDown();
  await sleep(300);
  const probe = await session.ev<Record<string, number | boolean>>(`
    const status = (url) => fetch(url, { cache: 'reload' }).then((r) => r.status, () => 0);
    const out = {
      controlled: !!navigator.serviceWorker.controller,
      html: await status('./index.html'),
      script: await status(document.querySelector('script[type="module"]').src),
      style: await status(document.querySelector('link[rel="stylesheet"]').href),
      manifest: await status(document.querySelector('link[rel="manifest"]').href),
      offline: await status(${JSON.stringify(CONTROL)}),
    };
    ${demo[0] ? `out.demo = await status(${JSON.stringify(demo[0])});` : ""}
    return out;
  `);
  console.log(`断网探针（cache:reload 绕过 HTTP 缓存）：${JSON.stringify(probe)}`);
  if (probe.offline !== 0)
    fail(`对照地址 ${CONTROL} 断网后仍拿到 ${probe.offline} —— 离线这半段是空的`);
  for (const key of ["html", "script", "style", "manifest"])
    if (probe[key] !== 200) fail(`断网后 ${key} 拿不到（${probe[key]}）`);
  if (demo[0] && probe.demo !== 200) fail(`断网后演示音频拿不到（${probe.demo}）`);
  if (!probe.controlled) fail("断网后页面丢了 Service Worker 控制");

  const reloaded = await session.goto(APP, ".app").then(() => true, () => false);
  const cold = await session
    .ev<{ drop: boolean; params: boolean }>(`
      return { drop: !!document.querySelector('.drop'), params: !!document.querySelector('.params') };
    `)
    .catch(() => null);
  if (!reloaded || !cold) fail("断网后重载打不开：应用壳没落到位");
  else if (!cold.drop || cold.params) fail("断网重载后的首屏不对：应当只有空态拖放区");
  else console.log("断网重载：应用壳完整渲染出空态");
} finally {
  await session.stop();
  shutDown();
}

if (failures.length) {
  console.error(`\n不合格 ${failures.length} 项：`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log("\nPWA 与离线全部合格");

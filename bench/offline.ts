import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { open, serve, sleep, waitFor } from "./cdp.ts";

const project = path.resolve(import.meta.dirname, "..");
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

const server = serve(PORT, {
  dir: `${project}/dist`,
  spa: true,
  files: { "/__cache-test__.html": new TextEncoder().encode("<!doctype html><title>Cache test</title>") },
});
let serving = true;
const shutDown = (): void => {
  if (!serving) return;
  serving = false;
  server.stop();
};
const session = await open({ port: CDP, size: [1200, 900], url: `${APP}__cache-test__.html` });
const status = async (url: string | null): Promise<number> =>
  url
    ? session.ev<number>(
        `return await fetch(${JSON.stringify(url)}, { cache: 'reload' }).then((r) => r.status, () => 0);`,
      )
    : 0;

try {
  await session.ev(`
    for (const name of ['other-app', 'atools:/other/sw.js:old', 'atools:/sw.js:old']) {
      const cache = await caches.open(name);
      await cache.put('/index.html', new Response('foreign home'));
    }
  `);
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

  const controlled = await session.ev<boolean>(`
    if (navigator.serviceWorker.controller) return true;
    return await Promise.race([
      new Promise((done) => navigator.serviceWorker.addEventListener(
        'controllerchange', () => done(true), { once: true })),
      new Promise((done) => setTimeout(() => done(false), 3000)),
    ]);
  `);
  if (!controlled)
    fail("首次加载后当前页面未受控（clients.claim 没生效：首次访问拿不到离线能力，得再加载一次）");

  const cacheNames = await session.ev<string[]>("return await caches.keys();");
  if (!cacheNames.includes("other-app") || !cacheNames.includes("atools:/other/sw.js:old"))
    fail("激活删除了其他应用或其他部署的缓存");
  if (cacheNames.includes("atools:/sw.js:old")) fail("激活没有清理当前部署的旧缓存");

  const online = await session.ev<{
    href: Record<string, string | null>;
    hook: string | null;
    controlled: boolean;
  }>(INSPECT);
  if (!online.controlled) fail("页面不受 Service Worker 控制");

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

  const wanted: [string, string][] = [
    ["index.html", "/index.html"],
    ["入口脚本", new URL(online.href.script!).pathname],
    ["样式", new URL(online.href.style!).pathname],
    ["manifest", new URL(online.href.manifest!).pathname],
    ["favicon", new URL(online.href.icon!).pathname],
    ["apple-touch-icon", new URL(online.href.apple!).pathname],
  ];
  for (const [src] of manifest?.icons ?? [])
    wanted.push([`manifest 图标 ${src}`, new URL(src, online.href.manifest!).pathname]);

  const shell =
    (await waitFor(
      "应用壳入缓存",
      async () => {
        const cached = await session.ev<string[]>(CACHED);
        return cached.length >= wanted.length ? cached : null;
      },
      10000,
    ).catch(() => null)) ?? (await session.ev<string[]>(CACHED));
  if (!shell.length) fail("Service Worker 一项都没预缓存");

  const kernel = shell.find(at => at.endsWith(".wasm"));
  if (!kernel) fail(`应用壳 ${shell.length} 项里没有 .wasm：数值内核掉出了壳，断网后编不了`);
  else wanted.push(["数值内核", kernel]);
  for (const [what, at] of wanted) if (!shell.includes(at)) fail(`预缓存里没有${what}（${at}）`);

  if (shell.some(at => at.endsWith("/sw.js")))
    fail("sw.js 自己进了预缓存：浏览器再也拿不到新的 Service Worker");
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

  const swPath = path.join(project, "dist/sw.js");
  const swBytes = await readFile(swPath, "utf8");
  try {
    await writeFile(swPath, `${swBytes}\n// 更新探针 ${Date.now()}\n`);
    await session.ev(`
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
      return !!reg;
    `);
    const parked = await waitFor(
      "新版停在 waiting",
      () =>
        session.ev<boolean>(`
          const reg = await navigator.serviceWorker.getRegistration();
          return !!reg?.waiting;
        `),
      8000,
    ).then(() => true, () => false);
    if (!parked) fail("新版 Service Worker 没停在 waiting：要么没被检测到，要么直接接管了正在用的页面");
    else console.log("更新语义：新版停在 waiting，旧版继续服务");
    if (!(await session.ev<boolean>(`return !!navigator.serviceWorker.controller;`)))
      fail("更新检测之后当前页面丢了 Service Worker 控制");
    const kept = await session.ev<string[]>(CACHED);
    for (const [what, at] of wanted) if (!kept.includes(at)) fail(`更新检测之后壳里少了${what}（${at}）`);
  } finally {
    await writeFile(swPath, swBytes);
  }

  const ghost = "./__no-such-chunk__.js";
  const ghostResp = await session.ev<{ status: number; type: string }>(`
    const r = await fetch(${JSON.stringify(ghost)}).catch(() => null);
    return r
      ? { status: r.status, type: (r.headers.get('content-type') ?? '').split(';')[0] }
      : { status: 0, type: '' };
  `);
  await sleep(300);
  const poisoned = (await session.ev<string[]>(CACHED)).some(at => at.endsWith("__no-such-chunk__.js"));
  if (ghostResp.status !== 200 || ghostResp.type !== "text/html")
    fail(
      `不存在的资源没走 SPA 回落（${ghostResp.status} ${ghostResp.type}）` +
        "：服务端与部署端不同语义，下面这条断言是空的",
    );
  else if (poisoned)
    fail(`SPA 回落出来的 index.html 被冻进了运行期缓存（${ghost}）：一次偶发缺文件会变成永久坏死`);
  else console.log("SPA 回落不进运行期缓存：缺失资源拿回 200 的 HTML，但没被冻住");

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
      kernel: await status(${JSON.stringify(kernel ?? "")}),
      offline: await status(${JSON.stringify(CONTROL)}),
    };
    ${demo[0] ? `out.demo = await status(${JSON.stringify(demo[0])});` : ""}
    return out;
  `);
  console.log(`断网探针（cache:reload 绕过 HTTP 缓存）：${JSON.stringify(probe)}`);
  if (probe.offline !== 0)
    fail(`对照地址 ${CONTROL} 断网后仍拿到 ${probe.offline} —— 离线这半段是空的`);
  for (const key of ["html", "script", "style", "manifest", "kernel"])
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

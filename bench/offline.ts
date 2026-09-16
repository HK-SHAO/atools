import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { strings } from "../app/lib/i18n.ts";
import { open, serve, sleep, waitFor } from "./cdp.ts";

const project = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 4380);
const CDP = PORT + 700;
const APP = `http://127.0.0.1:${PORT}/`;
const CONTROL = "./__offline-control__";

const failures: string[] = [];
const fail = (why: string) => failures.push(why);

// The gate drives the English UI; labels come from the dictionary so they cannot drift from it.
const L = strings("en");

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
  const prefix = 'atools:' + new URL('./sw.js', location.href).pathname + ':';
  const key = (await caches.keys()).find((name) => name.startsWith(prefix));
  if (!key) return [];
  return (await (await caches.open(key)).keys()).map((r) => new URL(r.url).pathname);
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
  if (!ready)
    fail("the Service Worker was not ready within ten seconds: not registered, or the browser refused (insecure context?)");
  else console.log("registered: dist/sw.js");

  const controlled = await session.ev<boolean>(`
    if (navigator.serviceWorker.controller) return true;
    return await Promise.race([
      new Promise((done) => navigator.serviceWorker.addEventListener(
        'controllerchange', () => done(true), { once: true })),
      new Promise((done) => setTimeout(() => done(false), 3000)),
    ]);
  `);
  if (!controlled)
    fail("the page is not controlled after the first load (clients.claim did not take effect: the first visit gets no offline ability and would need a reload)");

  const cacheNames = await session.ev<string[]>("return await caches.keys();");
  if (!cacheNames.includes("other-app") || !cacheNames.includes("atools:/other/sw.js:old"))
    fail("activation deleted the caches of another app or another deployment");
  if (cacheNames.includes("atools:/sw.js:old"))
    fail("activation did not clear the stale cache of the current deployment");

  const online = await session.ev<{
    href: Record<string, string | null>;
    hook: string | null;
    controlled: boolean;
  }>(INSPECT);
  if (!online.controlled) fail("the page is not controlled by the Service Worker");

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

  if (!manifest) fail("index.html has no <link rel=manifest>");
  else {
    console.log(`manifest: ${manifest.name}  ${manifest.mime}  display=${manifest.display}`);
    if (!manifest.mime?.includes("manifest"))
      fail(`the manifest MIME is ${manifest.mime}, expected application/manifest+json`);
    if (manifest.display !== "standalone")
      fail(`display=${manifest.display}, so it cannot install as a standalone window`);
    if (manifest.scope !== manifest.root || manifest.start !== manifest.root)
      fail(`scope/start_url resolve to ${manifest.scope}/${manifest.start} while the app root is ${manifest.root}`);
    for (const [src, code] of manifest.icons)
      if (code !== 200)
        fail(
          `manifest icon ${src} is unreachable (${code}): the manifest is not rewritten by the bundler, so it deploys by literal path`,
        );
  }

  for (const [what, url] of [
    ["apple-touch-icon", online.href.apple],
    ["favicon", online.href.icon],
  ] as [string, string | null][]) {
    const code = await status(url);
    if (code !== 200) fail(`${what} is unreachable (${code}): adding to the iOS home screen would fall back to a screenshot`);
  }
  if (online.hook !== "yes")
    fail(`apple-mobile-web-app-capable=${online.hook}, so the iOS standalone window cannot start`);

  const wanted: [string, string][] = [
    ["index.html", "/index.html"],
    ["entry script", new URL(online.href.script!).pathname],
    ["styles", new URL(online.href.style!).pathname],
    ["manifest", new URL(online.href.manifest!).pathname],
    ["favicon", new URL(online.href.icon!).pathname],
    ["apple-touch-icon", new URL(online.href.apple!).pathname],
  ];
  for (const [src] of manifest?.icons ?? [])
    wanted.push([`manifest icon ${src}`, new URL(src, online.href.manifest!).pathname]);

  const shell =
    (await waitFor(
      "app shell cached",
      async () => {
        const cached = await session.ev<string[]>(CACHED);
        return cached.length >= wanted.length ? cached : null;
      },
      10000,
    ).catch(() => null)) ?? (await session.ev<string[]>(CACHED));
  if (!shell.length) fail("the Service Worker precached nothing");

  const kernel = shell.find(at => at.endsWith(".wasm"));
  if (!kernel)
    fail(`none of the ${shell.length} shell entries is a .wasm: the numeric kernel fell out of the shell and cannot encode offline`);
  else wanted.push(["numeric kernel", kernel]);
  for (const [what, at] of wanted)
    if (!shell.includes(at)) fail(`the precache has no ${what} (${at})`);

  if (shell.some(at => at.endsWith("/sw.js")))
    fail("sw.js precached itself: the browser could never pick up a new Service Worker");
  console.log(`precached ${shell.length} entries: ${shell.join(" ")}`);

  await session.ev(`
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(L.demo)});
    b?.click();
    return !!b;
  `);
  const loaded = await waitFor("demo loaded", () =>
    session.ev<boolean>(`return !!document.querySelector('.spec');`),
  ).catch(() => false);
  const grown = await waitFor(
    "demo asset cached",
    async () => {
      const cached = await session.ev<string[]>(CACHED);
      return cached.length > shell.length ? cached : null;
    },
    8000,
  ).catch(() => null);
  const demo = (grown ?? []).filter(entry => entry.endsWith(".ogg"));
  if (!loaded) fail("the demo never loaded");
  if (!demo.length)
    fail("the demo audio never reached the runtime cache: a fixture used once should work offline");
  else console.log(`runtime cache +${grown!.length - shell.length} entries (demo audio ${demo.join(" ")} included)`);

  const swPath = path.join(project, "dist/sw.js");
  const swBytes = await readFile(swPath, "utf8");
  try {
    await writeFile(swPath, `${swBytes}\n// update probe ${Date.now()}\n`);
    await session.ev(`
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
      return !!reg;
    `);
    const parked = await waitFor(
      "the new version parks in waiting",
      () =>
        session.ev<boolean>(`
          const reg = await navigator.serviceWorker.getRegistration();
          return !!reg?.waiting;
        `),
      8000,
    ).then(() => true, () => false);
    if (!parked)
      fail("the new Service Worker did not park in waiting: either it was not detected or it took over the live page");
    else console.log("update semantics: the new version waits while the old one keeps serving");
    if (!(await session.ev<boolean>(`return !!navigator.serviceWorker.controller;`)))
      fail("the page lost Service Worker control after the update check");
    const kept = await session.ev<string[]>(CACHED);
    for (const [what, at] of wanted)
      if (!kept.includes(at)) fail(`the shell lost ${what} after the update check (${at})`);
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
      `a missing asset did not take the SPA fallback (${ghostResp.status} ${ghostResp.type})` +
        ": the dev server and the deployment differ here, so the assertion below is vacuous",
    );
  else if (poisoned)
    fail(`the index.html produced by the SPA fallback froze into the runtime cache (${ghost}): one transient missing file becomes permanent rot`);
  else console.log("the SPA fallback stays out of the runtime cache: a missing asset returns the 200 HTML but is not frozen");

  console.log("shutting the HTTP server down: the origin is genuinely unreachable now");
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
  console.log(`offline probe (cache:reload bypasses the HTTP cache): ${JSON.stringify(probe)}`);
  if (probe.offline !== 0)
    fail(`the control address ${CONTROL} still answers ${probe.offline} offline: the offline half of this check is vacuous`);
  for (const key of ["html", "script", "style", "manifest", "kernel"])
    if (probe[key] !== 200) fail(`${key} is unreachable offline (${probe[key]})`);
  if (demo[0] && probe.demo !== 200) fail(`the demo audio is unreachable offline (${probe.demo})`);
  if (!probe.controlled) fail("the page lost Service Worker control while offline");

  const reloaded = await session.goto(APP, ".app").then(() => true, () => false);
  const cold = await session
    .ev<{ drop: boolean; params: boolean }>(`
      return { drop: !!document.querySelector('.drop'), params: !!document.querySelector('.params') };
    `)
    .catch(() => null);
  if (!reloaded || !cold) fail("reloading offline does not open: the app shell never landed");
  else if (!cold.drop || cold.params)
    fail("the first screen after an offline reload is wrong: it should be the empty drop zone only");
  else console.log("offline reload: the shell renders the empty state in full");
} finally {
  await session.stop();
  shutDown();
}

if (failures.length) {
  console.error(`\nfailed checks: ${failures.length}`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log("\nPWA and offline all passed");

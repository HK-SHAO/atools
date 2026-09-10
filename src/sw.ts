// 应用壳离线。壳是什么、缓存叫什么，全由 build.ts 注入的 __SHELL__ 决定：
// 入口产物 + index.html 直接引用到的资源 + manifest 自己引的图标。
// 音频解码器是动态分包（按需 import），不预缓存，改由运行期缓存兜住：
// 用过一次的格式此后离线可用，没用过的离线时优雅失败。
//
// 更新语义 = 下次启动接管：不发 skipWaiting，新版装好就停在 waiting，旧 Worker 与旧缓存
// 继续服务，等标签页全关掉、下次启动才 activate 并清旧缓存。发了 skipWaiting 的话，
// 新版一 activate 就清空旧缓存，而正在用的页面还揣着旧的 HTML —— 它剩下没加载过的
// 动态分包会连同旧缓存一起消失。首次安装没有旧 Worker，本来就直接 activate，
// 所以「首次访问即离线可用」不靠 skipWaiting，靠下面的 clients.claim。
declare const __SHELL__: { cache: string; home: string; files: string[] };

// ServiceWorkerGlobalScope、ExtendableEvent、FetchEvent 都住在 lib.webworker 里，
// 与本项目用的 lib.dom 不能同引，这里只声明用得到的那几个口子。
// sw.ts 是脚本不是模块，这几个接口因此是全局的 —— 名字取具体些，免得撞上将来补进 DOM 库的类型。
interface Lifecycle extends Event {
  waitUntil(task: Promise<unknown>): void;
}

interface Routed extends Lifecycle {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface WorkerScope {
  location: URL;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: Lifecycle) => void): void;
  addEventListener(type: "fetch", listener: (event: Routed) => void): void;
}

// 一次性解构：define 注入的是对象字面量，每用一次就整份内联一遍（实测 6 处 → 2.0 KB），
// 拆开后只剩这一处，产物回到 1.1 KB。
const { cache: CACHE, home, files } = __SHELL__;

const scope = self as unknown as WorkerScope;
const HOME = new URL(home, scope.location.href).href;
const SHELL = files.map(file => new URL(file, scope.location.href).href);

// 只碰同源 GET；带 Range 的不碰，免得把半截响应写进缓存
const usable = (request: Request): boolean =>
  request.method === "GET" &&
  !request.headers.has("range") &&
  new URL(request.url).origin === scope.location.origin;

// 部署端是 not_found_handling: single-page-application：任何不匹配实体文件的路径
// （包括 .js）都会拿回 200 的 index.html。这种响应绝不能进运行期缓存 ——
// 一次偶发的缺文件会被固化成永久坏死，此后每次取到的都是这份 HTML。
// index.html 归预缓存清单管，运行期这一支只收真正的资源。
const cacheable = (response: Response): boolean =>
  response.ok && !(response.headers.get("content-type") ?? "").startsWith("text/html");

// 壳资源少一样就不接管：Promise.all 让安装失败，旧 Worker 继续服役，浏览器下次导航再试。
// allSettled 会让缺一项的半壳照样激活，离线时才炸 —— 那时已经没人能告诉用户发生了什么。
scope.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => Promise.all(SHELL.map(url => cache.add(url)))),
  );
});

scope.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => scope.clients.claim()),
  );
});

scope.addEventListener("fetch", event => {
  const { request } = event;
  if (!usable(request)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(HOME).then(hit => hit ?? Response.error())));
    return;
  }

  // 其余同源 GET 缓存优先：哈希资源命中即生效，未入缓存的按需补齐
  event.respondWith(
    caches.match(request).then(
      hit =>
        hit ??
        fetch(request).then(response => {
          if (cacheable(response)) {
            const copy = response.clone();
            void caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

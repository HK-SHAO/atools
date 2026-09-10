// 应用壳离线。落点由 build.ts 决定：dist/index.html 直接引用到的资源就是壳，
// 由它注入 __PRECACHE__；JS/CSS 带内容哈希，改了哪块只换哪块。
// 音频解码器是动态分包（按需 import），不预缓存，改由运行期缓存兜住：
// 用过一次的格式此后离线可用，没用过的离线时优雅失败。
declare const __PRECACHE__: string[];
declare const __CACHE__: string;

interface Lifecycle extends Event {
  waitUntil(task: Promise<unknown>): void;
}

interface Routed extends Event {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

const scope = self as Window &
  typeof globalThis & {
    skipWaiting(): Promise<void>;
    clients: { claim(): Promise<void> };
  };

const HOME = new URL("index.html", scope.location.href).href;
const SHELL = __PRECACHE__.map(entry => new URL(entry, scope.location.href).href);

const usable = (request: Request): boolean =>
  request.method === "GET" &&
  !request.headers.has("range") &&
  new URL(request.url).origin === scope.location.origin;

// 壳资源少一样就不接管：Promise.all 让安装失败，旧 Worker 继续服役，浏览器下次导航再试。
// allSettled 会让缺一项的半壳照样激活，离线时才炸 —— 那时已经没人能告诉用户发生了什么。
scope.addEventListener("install", event => {
  (event as Lifecycle).waitUntil(
    caches
      .open(__CACHE__)
      .then(cache => Promise.all(SHELL.map(url => cache.add(url))))
      .then(() => scope.skipWaiting()),
  );
});

scope.addEventListener("activate", event => {
  (event as Lifecycle).waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== __CACHE__).map(key => caches.delete(key))))
      .then(() => scope.clients.claim()),
  );
});

scope.addEventListener("fetch", event => {
  const request = (event as Routed).request;
  if (!usable(request)) return;
  const respond = (event as Routed).respondWith.bind(event);

  // 导航网络优先：sw.js 每次导航都被重新校验，发新版即接管；断网才回落到壳
  if (request.mode === "navigate") {
    respond(fetch(request).catch(() => caches.match(HOME).then(hit => hit ?? Response.error())));
    return;
  }

  // 其余同源 GET 缓存优先：哈希资源命中即生效，未入缓存的按需补齐
  respond(
    caches.match(request).then(
      hit =>
        hit ??
        fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(__CACHE__).then(cache => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

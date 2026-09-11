// 应用壳离线。预缓存清单由 vite-plugin-pwa 在构建期 glob `dist/` 注入：带哈希的资源按 URL
// 版本化，`index.html` 与图标按内容摘要版本化 —— 不必再有「壳推导 + 内容指纹 + 槽位替换」那一套。
// 音频解码器是懒加载的动态分包（合计约 1.2 MB），刻意留在清单外，由运行期缓存按需兜住：
// 用过一次的格式此后离线可用，没用过的离线时优雅失败。

import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

// ServiceWorkerGlobalScope 住在 lib.webworker，与本项目用的 lib.dom 不能同引，于是只在使用点收窄。
const precache = (self as unknown as { __WB_MANIFEST: (string | PrecacheEntry)[] }).__WB_MANIFEST;

// 安装期一次配齐，少一项即安装失败、旧 Worker 继续服役（workbox 也是 Promise.all，不做半壳激活）；
// activate 自动清掉上一版的条目与上一版缓存名。
precacheAndRoute(precache);

// 更新语义 = 下次启动接管，刻意**不发 skipWaiting**：新版装好就停在 waiting，旧 Worker 与旧缓存继续服务，
// 等标签页全关掉、下次启动才 activate。发了的话，新版一 activate 就清掉旧的预缓存，而正在用的页面还揣着
// 旧的 HTML —— 它剩下没加载过的动态分包会连同旧缓存一起消失。

// 首次访问即受控（首次安装没有旧 Worker，本来就立即 activate），因此首次访问之后就离线可用 —— 不靠 skipWaiting。
clientsClaim();

// 导航：网络优先，离线回退预缓存里的 index.html，深链因此离线也能直达应用。
// 带扩展名的路径（.js/.png 等）与 `_` 前缀排除在外 —— 它们按 URL 精确命中预缓存，不该被回落成一份 HTML。
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/_/, /\/[^/?]+\.[^/]+$/],
  }),
);

// 其余同源资源（解码器分包、演示音频）：命中即用，未命中就补齐。过期策略防止旧的哈希分包
// 随每次部署无限堆积。
//
// cacheWillUpdate 挡住 SPA 回落：部署端把任何不存在的路径回成 200 的 index.html，这种响应一旦
// 写进缓存就永久坏死，此后每次取到的都是它。带 Range 的请求一律不碰，免得把半截响应写进缓存。
registerRoute(
  ({ request, url }) =>
    request.method === "GET" &&
    !request.headers.has("range") &&
    url.origin === self.location.origin,
  new CacheFirst({
    cacheName: "atools-assets",
    plugins: [
      new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      {
        cacheWillUpdate: async ({ response }) =>
          response.ok && !(response.headers.get("content-type") ?? "").startsWith("text/html")
            ? response
            : null,
      },
    ],
  }),
);

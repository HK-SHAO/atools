import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";
import { startKernel, wasmUrl } from "./lib/dsp";

/**
 * 主线程这一份内核。**读图链在主线程上**（要 canvas 与 `getImageData`），而它每一步都要问
 * 内核：票根的行数、解码、绘制（见 `app/lib/stub.ts`）。少了这一份，读图与质检会在
 * 「数值内核还没挂上」处当场失败 —— 而 worker 里那一份救不了它，wasm 实例不跨线程。
 *
 * `fft: false`：这一侧只用票根的整数逻辑，不建 FFT 的表组。
 *
 * 不 await：加载与 React 挂载并行。落点按**模块自身**的位置向上解析 —— 源码里是
 * `/app/frontend.tsx`、产物里是 `assets/index-*.js`，向上都是一级（与 worker 那条
 * `new URL("..", import.meta.url)` 同一条规则），也必须与 `index.html` 里那条 preload
 * 解到同一个 URL，否则预热白做（两条都由 `scripts/pwa.ts` 在构建期核对）。
 */
void startKernel(wasmUrl(new URL("..", import.meta.url).href), { fft: false });

const elem = document.getElementById("root")!;
createRoot(elem).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service Worker 只在**生产**注册。判据是 `import.meta.env.PROD` 而不是「有没有热更新运行时」：
// 本模块不导出组件，改它只能是整页重载，`import.meta.hot` 的存在与否与「生产/开发」无关。
//
// 静默失败：不支持的环境与隐私模式都会拒，那不该让首屏报错。dev 下没有 `sw.js` 这个文件
// （它是构建期产物），注册上去也只是 404。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

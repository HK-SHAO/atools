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
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// HMR 重跑本模块时复用同一个 root。
// 不能直接写 `import.meta.hot.data.root`：生产构建里 `import.meta.hot` 是 undefined
// （Bun 的打包器会把整个表达式折掉，Vite 不会），那样首屏就崩在取 .data 上。
const hot = import.meta.hot;
const root = hot?.data.root ?? createRoot(elem);
if (hot) hot.data.root = root;
root.render(app);

if (!hot && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

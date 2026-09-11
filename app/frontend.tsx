import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";

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

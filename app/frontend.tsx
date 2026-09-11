import "./styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startKernel } from "./lib/dsp";

void startKernel({ fft: false });

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

(import.meta.hot.data.root ??= createRoot(elem)).render(app);

if (!import.meta.hot && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

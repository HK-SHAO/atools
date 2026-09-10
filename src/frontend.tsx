import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";
import { App } from "./App";

if (process.env.NODE_ENV !== "production") {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/stylex.dev.css";
  document.head.append(link);
}

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

(import.meta.hot.data.root ??= createRoot(elem)).render(app);

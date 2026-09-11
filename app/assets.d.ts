declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.ogg" {
  const path: string;
  export default path;
}

declare module "*.css" {
  const path: string;
  export default path;
}

// `?worker` 由 `scripts/worker.ts` 这个打包器插件接管（Bun 自己完全不认 worker）。默认导出是能直接
// `new` 的 Worker：地址由插件按「相对当前文档」算出来，调用侧不必知道 worker 出在哪。
declare module "*?worker" {
  const Worker: new (options?: WorkerOptions) => Worker;
  export default Worker;
}

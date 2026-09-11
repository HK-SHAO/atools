import { existsSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";

/**
 * worker 产物的文件名：与源文件同名，只把扩展名换成 `.js`。
 * 三处共用这一个定义 —— `?worker` 的模块按它算地址，构建与 dev 服务器按它出文件。
 */
export const workerFile = (source: string): string => `${path.basename(source, path.extname(source))}.js`;

/**
 * `import PipelineWorker from "./pipeline.worker.ts?worker"` —— 默认导出的是能直接 `new` 的
 * Worker（与生态里 `?worker` 的语义一致），于是调用侧只知道「有个 worker」，不知道它出在哪、
 * 地址怎么算。
 *
 * 为什么得自己写：Bun 的打包器**完全不认** worker。实测（1.4.3）`new Worker(new URL("./w.ts",
 * import.meta.url))` 连同它的六种变体一律被**原样透传**，worker 文件根本不产出；`?url` / `?worker`
 * 后缀直接 `Could not resolve`；而 dev 下 `import.meta.url` 又被静态替换成源码的 `file://` 路径
 * —— 那条官方写法在 Bun 里两头都堵。
 *
 * 地址用 `document.baseURI` 而不用 `import.meta.url`：产物里 worker 与 index.html 同级
 * （dist 是扁平的），相对**文档**解析在子路径部署下也成立；dev 下 `scripts/serve.ts` 把它挂在
 * 与 dist 同名的那两条路径上。一个表达式，两边都对。
 */
const plugin: BunPlugin = {
  name: "worker",
  setup(build) {
    build.onResolve({ filter: /\?worker$/ }, args => {
      const source = path.resolve(args.resolveDir, args.path.replace(/\?worker$/, ""));
      if (!existsSync(source)) throw new Error(`${args.path}：没有这个 worker 源文件`);
      return { path: source, namespace: "worker" };
    });

    build.onLoad({ filter: /.*/, namespace: "worker" }, args => ({
      loader: "js",
      contents: `
export default class extends Worker {
  constructor(options) {
    super(new URL("./${workerFile(args.path)}", document.baseURI), { type: "module", ...options });
  }
}
`,
    }));
  },
};

export default plugin;

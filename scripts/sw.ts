import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { WASM_FILE } from "./moon.ts";

const OUT = "dist";
const MANIFEST = "public/manifest.webmanifest";
const MARKER = "__SHELL__";

/**
 * 数值流水线的产物名。`vite.config.ts` 的 `build.worker.rollupOptions.output.entryFileNames`
 * 用的就是这一份声明，改这里即改那里。
 *
 * 为什么不是从产物图里按**入口模块**认：Vite 的 worker 子构建把产物当 **asset** 交上来
 * （`type === "asset"`，没有 `facadeModuleId`），入口信息在交上来之前就丢了。所以规矩是
 * 「名字我们自己钉，产物照旧从图里推导」—— 漏了仍然当场失败，只是判据换了个来源。
 */
export const WORKER_FILE = "assets/pipeline.worker-[hash].js";

/** `[hash]` 之前那段就是产物名的前缀。 */
const WORKER_PREFIX = WORKER_FILE.slice(0, WORKER_FILE.indexOf("[hash]"));

// 压缩器会把 `"__SHELL__"` 改写成 `` `__SHELL__` ``（实测 oxc），所以不能按某一种引号去匹配：
// 连引号一起换掉，只认中间的标记名。
const SLOT = /(["'`])__SHELL__\1/;

/**
 * 应用壳 = 首屏必需的一切，**推出来的**而不是挑出来的。三处来源各自独立，取并集后排序
 * （排序是为了让指纹与清单稳定，打包器给产物的顺序不是契约）：
 *
 * ① `index.html` 里的 `./` 引用 —— 入口脚本、样式、图标、manifest，以及它自己。
 * ② manifest 引的图标 —— manifest 的内容不经过打包器改写，图标按字面路径原样复制，
 *    所以这一步漏掉就真的漏掉。
 * ③ 数值流水线那个 Worker 产物 —— 它只由 `new Worker(new URL(...))` 引到，
 *    HTML 里没有，而 Vite 交上来的是 asset（认不出入口），所以按**我们自己钉的产物名**认。
 *
 * 解码器是动态 import 的独立 chunk，HTML 不引，三头都不沾，天然留在壳外。
 * 代码型资源看静态/动态可达，URL 型资源只看 HTML 引没引。
 */
async function shellOf(root: string, worker: string): Promise<string[]> {
  const html = await readFile(path.join(root, OUT, "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as {
    icons: { src: string }[];
  };
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!);
  const icons = manifest.icons.map(icon => icon.src.replace(/^\.\//, ""));
  return [...new Set(["index.html", ...refs, ...icons, worker])].sort();
}

/** 壳的内容指纹：名字加字节一起喂。带哈希的资源改内容会连名字一起改，`index.html` 与图标不会。 */
async function fingerprintOf(root: string, shell: string[]): Promise<string> {
  const hash = createHash("sha256").update(shell.join("\n"));
  for (const entry of shell) hash.update(await readFile(path.join(root, OUT, entry)));
  return hash.digest("hex").slice(0, 8);
}

export function serviceWorker(): Plugin {
  // 产物图里认出来的 Worker 产物名。`generateBundle` 早于 `closeBundle`，同一插件实例里带着走。
  let worker = "";

  return {
    name: "sw-shell",
    apply: "build",
    generateBundle(_options, bundle) {
      // 认不出来就当场失败：漏进壳的代价是「断网之后按钮点不动」，那要等到离线才暴露。
      //
      // 这里查不了「入口代码引没引到它」：此刻引用还是 rolldown 的
      // `import.meta.ROLLDOWN_FILE_URL_<id>` 占位符，换成文件名要等这个钩子之后。
      const found = Object.keys(bundle).filter(name => name.startsWith(WORKER_PREFIX));
      if (found.length !== 1)
        throw new Error(
          `产物里以 ${WORKER_PREFIX} 开头的文件有 ${found.length} 个：流水线 Worker 没进产物，或者产物名改了（改了就把 vite.config.ts 里 worker 的 entryFileNames 一起改）`,
        );
      worker = found[0]!;
    },
    async closeBundle() {
      const root = process.cwd();
      // 渲染阶段失败时 Vite 也会走这里当清理，那时 dist 还没写出来。缺 index.html 不是本插件的事，
      // 在这里抛只会把真正的失败原因盖掉（实测：ENOENT 顶掉了原本的构建错误）。
      if (!(await stat(path.join(root, OUT, "index.html")).catch(() => null))) return;
      const shell = await shellOf(root, worker);

      // 数值内核必须在壳里：没有它，首次访问后断网就打不开任何音频。
      // 这条同时是「index.html 的 preload 路径 == 内核落点」的核对 —— 路径写错的表现
      // 只是那种资源静默不进壳，等断网才暴露。
      if (!shell.includes(WASM_FILE))
        throw new Error(`应用壳里没有 ${WASM_FILE}：index.html 的 preload 路径与 scripts/moon.ts 的 WASM_FILE 对不上`);

      // 壳里少一样就白屏，而写错的地方只让条目静默消失。构建期把它变成硬失败。
      for (const entry of shell)
        if (!(await stat(path.join(root, OUT, entry)).catch(() => null)))
          throw new Error(`应用壳里的 ${entry} 不在 dist/ 里：壳是推出来的，多半是引用或 manifest 图标路径写错了`);

      const cache = `atools-${await fingerprintOf(root, shell)}`;
      const swPath = path.join(root, OUT, "sw.js");
      const source = await readFile(swPath, "utf8");
      // 槽位在源码里是 `JSON.parse("__SHELL__")`，塞对象字面量进去会变成 JSON.parse({…})
      // —— 收到 "[object Object]"，运行期抛错，又被注册处的 .catch 吞掉，表现成「SW 没注册上」。
      // 换成双引号字符串字面量就杜绝了这类：JSON 的转义是 JS 字符串转义的子集，直接可用，
      // 也不必理会压缩器原来用的是哪种引号。
      const slot = SLOT.exec(source);
      if (!slot) throw new Error(`dist/sw.js 里找不到 ${MARKER}：占位符被改名或抹掉了`);
      const payload = JSON.stringify({ cache, home: "index.html", files: shell });
      await writeFile(swPath, source.replace(SLOT, JSON.stringify(payload)));

      // 补一道残留检查：替换是文本操作，键名写错不会让构建失败，只会在浏览器里炸。
      if ((await readFile(swPath, "utf8")).includes(MARKER))
        throw new Error(`dist/sw.js 里还留着 ${MARKER}：替换没生效`);

      this.info(`应用壳 ${shell.length} 项 · ${cache}`);
    },
  };
}

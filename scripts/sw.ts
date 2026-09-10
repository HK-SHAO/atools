import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { WASM_FILE } from "./moon.ts";

const OUT = "dist";
const MANIFEST = "public/manifest.webmanifest";
const MARKER = "__SHELL__";

// 压缩器会把 `"__SHELL__"` 改写成 `` `__SHELL__` ``（实测 oxc），所以不能按某一种引号去匹配：
// 连引号一起换掉，只认中间的标记名。
const SLOT = /(["'`])__SHELL__\1/;

/**
 * 应用壳 = 首屏必需的一切，**推出来的**而不是挑出来的。两处来源各自独立，取并集后排序
 * （排序是为了让指纹与清单稳定，打包器给产物的顺序不是契约）：
 *
 * ① `index.html` 里的 `./` 引用 —— 入口脚本、样式、图标、manifest，以及它自己。
 * ② manifest 引的图标 —— manifest 的内容不经过打包器改写，图标按字面路径原样复制，
 *    所以这一步漏掉就真的漏掉。
 *
 * 解码器是动态 import 的独立 chunk，HTML 不引，两头都不沾，天然留在壳外。
 * 代码型资源看静态/动态可达，URL 型资源只看 HTML 引没引。
 */
async function shellOf(root: string): Promise<string[]> {
  const html = await readFile(path.join(root, OUT, "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as {
    icons: { src: string }[];
  };
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!);
  const icons = manifest.icons.map(icon => icon.src.replace(/^\.\//, ""));
  return [...new Set(["index.html", ...refs, ...icons])].sort();
}

/** 壳的内容指纹：名字加字节一起喂。带哈希的资源改内容会连名字一起改，`index.html` 与图标不会。 */
async function fingerprintOf(root: string, shell: string[]): Promise<string> {
  const hash = createHash("sha256").update(shell.join("\n"));
  for (const entry of shell) hash.update(await readFile(path.join(root, OUT, entry)));
  return hash.digest("hex").slice(0, 8);
}

export function serviceWorker(): Plugin {
  return {
    name: "sw-shell",
    apply: "build",
    async closeBundle() {
      const root = process.cwd();
      const shell = await shellOf(root);

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

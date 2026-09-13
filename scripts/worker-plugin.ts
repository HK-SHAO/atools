import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const QUERY = "?worker&url";
const DEV_DIR = path.resolve(import.meta.dirname, "../node_modules/.tmp/dev-worker");

const INNER = `
const [entry, outdir, hashed] = process.argv.slice(1);
const done = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  naming: hashed === "1"
    ? { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" }
    : { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});
if (!done.success) {
  for (const log of done.logs) console.error(String(log));
  process.exit(1);
}
console.log(JSON.stringify(done.outputs.map(output => ({
  kind: output.kind,
  file: require("node:path").basename(output.path),
}))));
`;

interface Emitted {
  source: string;
  dir: string;
  files: Set<string>;
}

const emitted = new Map<string, Emitted>();

const buildWorker = async (
  source: string,
  outdir: string,
  hashed: boolean,
): Promise<{ entry: string; files: string[] }> => {
  const proc = Bun.spawn([process.execPath, "-e", INNER, source, outdir, hashed ? "1" : "0"]);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`Worker 构建失败：\n${stderr}`);
  const outputs = JSON.parse(stdout) as { kind: string; file: string }[];
  const entry = outputs.find(output => output.kind === "entry-point")?.file;
  if (!entry) throw new Error(`Worker ${source} 没有产出入口脚本`);
  return { entry, files: outputs.map(output => output.file) };
};

const plugin: BunPlugin = {
  name: "worker-url",
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, args => ({
      path: path.resolve(path.dirname(args.importer), args.path.slice(0, -QUERY.length)),
      namespace: "worker-url",
    }));

    build.onLoad({ filter: /.*/, namespace: "worker-url" }, async ({ path: source }) => {
      const buildMode = Boolean(build.config.outdir);
      const outdir = buildMode ? build.config.outdir! : DEV_DIR;
      const { entry, files } = await buildWorker(source, outdir, buildMode);
      emitted.set(entry, { source, dir: outdir, files: new Set(files) });
      const url = buildMode ? `new URL("./${entry}", import.meta.url).href` : `"/${entry}"`;
      return { contents: `export default ${url};`, loader: "js" };
    });
  },
};

export default plugin;

export const workerEntries = (): string[] => [...emitted.keys()].sort();

export const workerFiles = (): string[] =>
  [...new Set([...emitted.values()].flatMap(made => [...made.files]))].sort();

export function workerRoutes(): Record<string, (request: Request) => Promise<Response>> {
  const live = (): Set<string> =>
    new Set([...emitted.values()].flatMap(made => [...made.files]));

  const serve = async (file: string): Promise<Response | null> => {
    const made = [...emitted.values()].find(entry => entry.files.has(file));
    if (!made) return null;
    if (file.endsWith(".js")) {
      const fresh = await buildWorker(made.source, made.dir, false);
      emitted.set(file, { source: made.source, dir: made.dir, files: new Set(fresh.files) });
      for (const name of await readdir(made.dir))
        if (!live().has(name)) await unlink(path.join(made.dir, name)).catch(() => {});
    }
    return new Response(Bun.file(path.join(made.dir, file)), {
      headers: { "cache-control": "no-store" },
    });
  };

  return {
    "/:file": async request => {
      const response = await serve(decodeURIComponent(new URL(request.url).pathname.slice(1)));
      return response ?? new Response("not a worker asset\n", { status: 404 });
    },
  };
}

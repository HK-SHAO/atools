import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  await Bun.file(new URL("./sw.ts", import.meta.url)).text(),
);

function worker(offline = false) {
  const handlers = new Map<string, (event: any) => void>();
  const deleted: string[] = [];
  const reads: { cacheName: string }[] = [];
  const writes: string[] = [];
  const current = "atools:/tools/sw.js:version-2";
  runInNewContext(source, {
    PRECACHE: { cache: "version-2", home: "index.html", files: [] },
    self: {
      location: new URL("https://example.test/tools/sw.js"),
      clients: { claim: async () => {} },
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
    },
    caches: {
      keys: async () => [current, "atools:/tools/sw.js:version-1", "atools:/other/sw.js:version-1", "other-app"],
      delete: async (key: string) => { deleted.push(key); return true; },
      match: async (_request: unknown, options: { cacheName: string }) => {
        reads.push(options);
        return offline ? new Response("cached home") : undefined;
      },
      open: async (name: string) => ({ put: async () => { writes.push(name); } }),
    },
    fetch: async () => {
      if (offline) throw new TypeError("offline");
      return new Response("asset", { headers: { "content-type": "text/javascript" } });
    },
    URL, Request, Response,
  });
  return { handlers, deleted, reads, writes, current };
}

describe("service worker cache ownership", () => {
  test("activation removes only obsolete caches belonging to this deployment", async () => {
    const live = worker();
    let task: Promise<unknown> | undefined;
    live.handlers.get("activate")!({ waitUntil: (value: Promise<unknown>) => { task = value; } });
    await task;
    expect(live.deleted).toEqual(["atools:/tools/sw.js:version-1"]);
  });

  test("asset reads use the active cache and writes extend the event lifetime", async () => {
    const live = worker();
    let response: Promise<Response> | undefined;
    const tasks: Promise<unknown>[] = [];
    live.handlers.get("fetch")!({
      request: new Request("https://example.test/tools/app.js"),
      respondWith: (value: Promise<Response>) => { response = value; },
      waitUntil: (value: Promise<unknown>) => tasks.push(value),
    });
    expect(await (await response)!.text()).toBe("asset");
    await Promise.all(tasks);
    expect(live.reads).toEqual([{ cacheName: live.current }]);
    expect(tasks).toHaveLength(1);
    expect(live.writes).toEqual([live.current]);
  });

  test("offline navigation reads the current deployment's home", async () => {
    const live = worker(true);
    let response: Promise<Response> | undefined;
    live.handlers.get("fetch")!({
      request: { url: "https://example.test/tools/", method: "GET", headers: new Headers(), mode: "navigate" },
      respondWith: (value: Promise<Response>) => { response = value; },
    });
    expect(await (await response)!.text()).toBe("cached home");
    expect(live.reads).toEqual([{ cacheName: live.current }]);
  });
});

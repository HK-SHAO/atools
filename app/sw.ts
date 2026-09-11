declare const __SHELL__: { cache: string; home: string; files: string[] };

interface Lifecycle extends Event {
  waitUntil(task: Promise<unknown>): void;
}

interface Routed extends Lifecycle {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface WorkerScope {
  location: URL;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: Lifecycle) => void): void;
  addEventListener(type: "fetch", listener: (event: Routed) => void): void;
}

const { cache: CACHE, home, files } = __SHELL__;

const scope = self as unknown as WorkerScope;
const HOME = new URL(home, scope.location.href).href;
const SHELL = files.map(file => new URL(file, scope.location.href).href);

const usable = (request: Request): boolean =>
  request.method === "GET" &&
  !request.headers.has("range") &&
  new URL(request.url).origin === scope.location.origin;

const cacheable = (response: Response): boolean =>
  response.ok && !(response.headers.get("content-type") ?? "").startsWith("text/html");

scope.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: "reload" })))),
    ),
  );
});

scope.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => scope.clients.claim()),
  );
});

scope.addEventListener("fetch", event => {
  const { request } = event;
  if (!usable(request)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(HOME).then(hit => hit ?? Response.error())));
    return;
  }

  event.respondWith(
    caches.match(request).then(
      hit =>
        hit ??
        fetch(request).then(response => {
          if (cacheable(response)) {
            const copy = response.clone();
            void caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

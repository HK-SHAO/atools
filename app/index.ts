import index from "./index.html";
import { watchKernel } from "../scripts/moon.ts";
import { workerRoutes } from "../scripts/worker-plugin.ts";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "127.0.0.1",
  routes: { ...workerRoutes(), "/*": index },
  development: { hmr: true, console: true },
});

watchKernel();
console.log(`🚀 atools ${server.url}`);

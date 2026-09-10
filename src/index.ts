import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    "/stylex.dev.css": () =>
      new Response(Bun.file(".cache/stylex.dev.css"), { headers: { "content-type": "text/css" } }),
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);

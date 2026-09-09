# Cloudflare 部署（atools）

纯静态 assets 部署：无 Worker 源码、无 main、无 bindings。
`wrangler.jsonc` 的 `assets.directory` 指向 `../dist`（由根目录 `bun run build:web` 产出），相对本目录解析；
`not_found_handling: single-page-application` 兜底路由。本应用是单页，无服务端逻辑。

## 命令

| 命令 | 用途 |
|---|---|
| `bun run deploy`（根目录） | build:web → `wrangler deploy` |
| `bunx wrangler deploy --config cloudflare/wrangler.jsonc` | 仅部署（dist 须已构建） |

首次使用需 `bunx wrangler login`。`workers_dev` 默认开启，部署得 `*.workers.dev` 域名；
日后绑自定义域名时再设 `workers_dev: false` 并配 routes。

## 注意事项

- `upload_source_maps: false` 是刻意设置：一旦构建开启 sourcemap，会把源码公开上传
- wrangler 经 `bunx` 按需拉取，不进 dependencies、不动 bun.lock；遇破坏性升级在脚本里钉版本（如 `bunx wrangler@^4`）
- 无 bindings，无需 `wrangler types`

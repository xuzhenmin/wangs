# 深巷网站

基于 Next.js 的 Node.js 网站，使用本地 SQLite 保存用户明确授权的位置记录。
运行时不依赖 Cloudflare Workers、Wrangler、Miniflare 或 Docker，可在 glibc
2.32 的 Linux 服务器上运行。

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

生产环境需要配置管理员密码和会话签名密钥：

```bash
cp .env.example .env
# 编辑 .env 后启动
LOCAL_SITE_HOST=0.0.0.0 npm run local:start
```

默认端口为 `3217`。位置数据默认写入 `data/wangs.sqlite`。

文章原始导入图片保存在 `public/uploads/articles/`，不会提交到 Git。添加本站
水印后的发布图片保存在 `public/article-images/`，会随代码一起提交和部署。

## Runtime configuration

- `ADMIN_PASSWORD`: 后台登录密码，必须设置
- `ADMIN_SESSION_SECRET`: 会话签名密钥，必须设置为足够长的随机值
- `LOCATION_DB_PATH`: SQLite 文件路径，默认 `data/wangs.sqlite`
- `LOCAL_SITE_HOST`: 监听地址，默认 `127.0.0.1`；公网服务器可设置为 `0.0.0.0`
- `LOCAL_SITE_PORT`: 监听端口，默认 `3217`

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: 启动 Next.js 开发服务器
- `npm run build`: 构建 Next.js 生产版本
- `npm run local:start`: 构建并在后台启动 Node.js 服务，默认地址 `http://127.0.0.1:3217`
- `npm run local:pause`: safely pause the background site process
- `npm run local:status`: show whether the local site is running
- `npm run scrape -- https://example.com/article`: save one authorized page as cleaned text and JSON
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use a different port with `LOCAL_SITE_PORT=8080 npm run local:start`. To make the site
reachable from other devices on the same network, use
`LOCAL_SITE_HOST=0.0.0.0 npm run local:start` and allow the port through your firewall.
On macOS, the background process is managed by `launchd`, so it remains available
after the start command exits.

`npm run local:start` 会对比 `package.json` 和 `package-lock.json` 的内容；依赖清单
发生变化时会自动以低并发模式运行 `npm ci`，避免服务器更新代码后继续使用旧的
`node_modules`。生产构建也限制为单个构建工作进程，以适配小内存 Linux 服务器。

The page saver respects `robots.txt`, filters common ad containers, and does not
download images, video, scripts, forms, or watermarks. Run `npm run scrape` without
a URL for an interactive prompt. Results are written to `scraped-pages/` by default;
use `--output PATH` to choose another folder. Private or local development URLs are
blocked unless you explicitly add `--allow-private` for a host you control.

服务器直接对外提供服务时，还需要在安全组中开放对应端口。浏览器定位功能要求
HTTPS，正式环境建议在服务前配置 Nginx 和 TLS 证书。

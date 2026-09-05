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

超级管理员可在“授权记录”中撤销单个设备的位置授权。撤销会删除当前服务端位置记录并
阻止已有授权的后台自动刷新；该设备下次访问时必须再次点击站内授权按钮，成功定位后
才会恢复位置采集。浏览器自身已经授予的系统定位权限无法由网站重置。

文章原始导入图片保存在 `public/uploads/articles/`，不会提交到 Git。添加本站
水印后的发布图片保存在 `public/article-images/`，会随代码一起提交和部署。

## Runtime configuration

- `ADMIN_PASSWORD`: 后台登录密码，必须设置
- `ADMIN_SESSION_SECRET`: 会话签名密钥，必须设置为足够长的随机值
- `ARTICLE_SYNC_SECRET`: 本地和远端共用的文章同步密钥，至少 32 个字符，且不要与后台密码或会话密钥相同
- `ARTICLE_SYNC_ALLOW_PRIVATE`: 默认不设置；仅当目标是可信内网服务器时，在本地设置为 `true`
- `LOCATION_DB_PATH`: SQLite 文件路径，默认 `data/wangs.sqlite`
- `NEXT_PUBLIC_SITE_URL`: 网站对外访问地址，用于生成分享卡片和 canonical 的绝对链接，例如 `https://news.osfeng.cn`
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

`npm run local:start` 只检查依赖，不会安装或修改 `node_modules`。如果依赖缺失或
与 `package.json` 不一致，脚本会退出并提示手动运行低并发安装命令
`npm ci --no-audit --no-fund --maxsockets=1`。生产构建限制为单个构建工作进程，
以适配小内存 Linux 服务器。

通过 `scripts/install-node22.sh` 安装项目内置 Node.js 后，直接在终端运行 `npm`
仍可能调用系统旧版本。手动安装依赖前应按照脚本末尾提示，将
`.runtime/node/bin` 放到当前终端的 `PATH` 前面。

## 本地发布同步到远端

远端服务器的 `.env` 只需配置接收密钥：

```env
ARTICLE_SYNC_SECRET=使用-openssl-rand-hex-32-生成的独立密钥
```

本地服务的 `.env.local` 配置相同密钥：

```env
ARTICLE_SYNC_SECRET=与远端完全相同的密钥
```

“发布内容”或“发布更新”只保存到本地，不会连接远端。文章正式发布后，“全部文档”
列表会出现上传图标；点击图标，在弹窗中输入远端网站根地址或公网 IP 并确认，文章正文
和当前文章引用的本地图片才会上传。远端接口会按文章 ID 新增或更新内容，并将接收到的
图片保存到 `public/uploads/articles/`。弹窗会显示上传成功链接，或显示失败原因。

同步目标默认必须解析到公网 IP，且不允许 HTTP 重定向。如果两台服务只通过可信内网
通信，可仅在本地 `.env.local` 中显式配置 `ARTICLE_SYNC_ALLOW_PRIVATE=true`。

同步接口单次最多接收 20 张图片、每张最多 8 MB、请求总体最多 64 MB。Nginx 需要在
对应 `server` 或 `location` 中允许上传并延长代理超时，例如：

```nginx
client_max_body_size 64m;
proxy_read_timeout 240s;
proxy_send_timeout 240s;
```

The page saver respects `robots.txt`, filters common ad containers, and does not
download images, video, scripts, forms, or watermarks. Run `npm run scrape` without
a URL for an interactive prompt. Results are written to `scraped-pages/` by default;
use `--output PATH` to choose another folder. Private or local development URLs are
blocked unless you explicitly add `--allow-private` for a host you control.

服务器直接对外提供服务时，还需要在安全组中开放对应端口。浏览器定位功能要求
HTTPS，正式环境建议在服务前配置 Nginx 和 TLS 证书。

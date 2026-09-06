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
水印后的图片先保存在 `public/article-images/`；发布文章时，正文引用到的处理图会通过
OSS 传输加速 Endpoint 上传到 `article-images/{文章 UUID}/`，正文地址随即替换成固定的
OSS 公共 HTTPS 地址。远端文章同步只发送 JSON，不再重复上传图片。
每篇文章单次最多下载、处理和发布 50 张图片。

## Runtime configuration

- `ADMIN_PASSWORD`: 后台登录密码，必须设置
- `ADMIN_SESSION_SECRET`: 会话签名密钥，必须设置为足够长的随机值
- `ARTICLE_SYNC_SECRET`: 本地和远端共用的文章同步密钥，至少 32 个字符，且不要与后台密码或会话密钥相同
- `ARTICLE_SYNC_ALLOW_PRIVATE`: 默认不设置；仅当目标是可信内网服务器时，在本地设置为 `true`
- `OSS_ACCESS_KEY_ID`: 本地内容服务用于上传的 RAM AccessKey ID；不要放进浏览器代码或提交到 Git
- `OSS_ACCESS_KEY_SECRET`: 本地内容服务用于上传的 RAM AccessKey Secret；远端展示服务器不需要该凭证
- `OSS_BUCKET`: 公共读 Bucket 名称；本地和远端都需要，用于校验正文图片域名
- `OSS_REGION`: Bucket 所在地域，V4 签名格式，如 `oss-cn-hangzhou`
- `OSS_ENDPOINT`: 上传 Endpoint，默认 `https://oss-accelerate.aliyuncs.com`，不可包含 Bucket 名称
- `OSS_ARTICLE_IMAGE_PREFIX`: Object 前缀，默认 `article-images`
- `OSS_PUBLIC_BASE_URL`: 可选的固定公共域名或 CDN 域名；未设置时使用 `https://<bucket>.oss-accelerate.aliyuncs.com`
- `LOCATION_DB_PATH`: SQLite 文件路径，默认 `data/wangs.sqlite`
- `NEXT_PUBLIC_SITE_URL`: 网站对外访问地址，用于生成分享卡片和 canonical 的绝对链接，例如 `https://news.osfeng.cn`
- `LOCAL_SITE_HOST`: 监听地址，默认 `127.0.0.1`；公网服务器可设置为 `0.0.0.0`
- `LOCAL_SITE_PORT`: 监听端口，默认 `3217`

Bucket 必须先在 OSS 控制台开启传输加速，并允许匿名读取文章图片；上传应使用仅拥有目标
Bucket `article-images/*` 写权限的 RAM 身份。远端服务器只需配置 `OSS_BUCKET`、
`OSS_ARTICLE_IMAGE_PREFIX`，以及使用自定义域名时的 `OSS_PUBLIC_BASE_URL`。

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

远端服务器的 `.env` 配置接收密钥和 OSS 公共地址信息，不需要上传凭证：

```env
ARTICLE_SYNC_SECRET=使用-openssl-rand-hex-32-生成的独立密钥
OSS_BUCKET=你的Bucket名称
OSS_ARTICLE_IMAGE_PREFIX=article-images
# 如果正文使用自定义 CDN 域名，再设置：
# OSS_PUBLIC_BASE_URL=https://images.example.com
```

本地内容服务的 `.env.local` 除相同密钥外，还需要 OSS 上传凭证：

```env
ARTICLE_SYNC_SECRET=与远端完全相同的密钥
OSS_ACCESS_KEY_ID=RAM用户AccessKeyID
OSS_ACCESS_KEY_SECRET=RAM用户AccessKeySecret
OSS_BUCKET=你的Bucket名称
OSS_REGION=oss-cn-hangzhou
OSS_ENDPOINT=https://oss-accelerate.aliyuncs.com
OSS_ARTICLE_IMAGE_PREFIX=article-images
```

“发布内容”或“发布更新”会先把正文引用的处理后图片上传到 OSS，再把正文图片地址替换
为固定的 OSS HTTPS 地址并保存到本地。任一图片上传失败时文章不会发布。文章正式发布后，
“全部文档”列表会出现同步图标；点击图标，在弹窗中输入远端网站根地址或公网 IP 并确认，
系统只发送文章 JSON。远端接口按文章 ID 新增或更新内容，不再接收或保存图片。

同步目标默认必须解析到公网 IP，且不允许 HTTP 重定向。如果两台服务只通过可信内网
通信，可仅在本地 `.env.local` 中显式配置 `ARTICLE_SYNC_ALLOW_PRIVATE=true`。

发布时每篇文章最多上传 50 张图片，每张最多 8 MB；远端文章 JSON 同步请求最多 512 KB，
不再需要为文章同步调大 Nginx 上传体积限制。

The page saver respects `robots.txt`, filters common ad containers, and does not
download images, video, scripts, forms, or watermarks. Run `npm run scrape` without
a URL for an interactive prompt. Results are written to `scraped-pages/` by default;
use `--output PATH` to choose another folder. Private or local development URLs are
blocked unless you explicitly add `--allow-private` for a host you control.

服务器直接对外提供服务时，还需要在安全组中开放对应端口。浏览器定位功能要求
HTTPS，正式环境建议在服务前配置 Nginx 和 TLS 证书。

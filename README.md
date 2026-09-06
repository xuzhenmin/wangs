# 深巷网站

基于 Next.js 的 Node.js 网站，使用本地 SQLite 保存用户明确授权的位置记录。
运行时不依赖 Cloudflare Workers、Wrangler、Miniflare 或 Docker，可在 glibc
2.32 的 Linux 服务器上运行。

## Prerequisites

微信分享接入和小封面说明见 [微信分享配置](docs/wechat-sharing.md)。

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

文章原始导入图片保存在 `public/uploads/articles/`，添加本站水印后的图片先保存在
`public/article-images/`。两类目录都仅作为本地工作区，不提交到 Git（仅保留 `.gitkeep`）；
处理预览、`manifest.json` 和 `regions.json` 同样不提交。同步远端前，正文引用到的处理图会通过
OSS 传输加速 Endpoint 上传到 `article-images/{文章 UUID}/`，正文地址随即替换成固定的
OSS 公共 HTTPS 地址。远端文章同步只发送 JSON，不再重复上传图片。
每篇文章单次最多下载、处理和同步 50 张图片。

新增文章可以先保存草稿获得文章 UUID、导入原图并在本地发布；本地发布不执行图片处理校验，
也不要求 OSS 可用。外链和 Blob 仍需导入才能在公开内容页正常展示，原有页面安全过滤不变。
同步远端前必须完成水印处理并将正文引用替换为当前文章的 `/article-images/` 地址。
同步时先校验、上传 OSS 并回写正文，再发送文章 JSON；校验或上传失败不会影响已完成的本地发布，
也不会向远端发送未处理图片。OSS 上传成功但远端失败时保留 OSS 地址，重试不重复上传这些图片。
原图和成品仍保留在本地，需自行备份；OSS 保存的是正文引用到的成品。
旧抓取目录 `public/scraped-article/` 和旧静态文章插图也已停止 Git 跟踪，网站图标、
通用分享图和 SVG 界面资源仍随代码管理。

拉取这次清理提交前，如服务器还有引用 `/article-images/` 的旧文章，应先用现有文章同步
功能更新为已发布的 OSS 正文，否则 Git 删除生效后旧本地链接会失效。停止跟踪不等于清理
历史提交：旧图片仍可从历史版本找回，仓库历史体积不会因此立即缩小。

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
- `bash scripts/start-local.sh --skip-build`: 使用已有生产构建启动，适合代码和依赖未变更时恢复服务
- `bash scripts/install-low-memory.sh`: 以较低内存峰值安装完整构建依赖
- `npm run local:pause`: safely pause the background site process
- `npm run local:status`: show whether the local site is running
- `npm run scrape -- https://example.com/article`: save one authorized page as cleaned text and JSON
- `npm test`: 检查文章图片 Git 策略、构建网站并验证运行时及 OSS 发布/同步流程
- `npm run test:storage`: 检查文章图片不被 Git 跟踪，并模拟新文章生成文件后的 `git add`
- `node --test tests/local-scripts.test.mjs`: 隔离验证低内存安装与启动脚本，不安装依赖或启动真实网站
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use a different port with `LOCAL_SITE_PORT=8080 npm run local:start`. To make the site
reachable from other devices on the same network, use
`LOCAL_SITE_HOST=0.0.0.0 npm run local:start` and allow the port through your firewall.
On macOS, the background process is managed by `launchd`, so it remains available
after the start command exits.

`npm run local:start` 只检查依赖，不会安装或修改 `node_modules`。如果依赖缺失或
与 `package.json` 不一致，脚本会退出并提示运行 `bash scripts/install-low-memory.sh`。
生产构建限制为单个构建工作进程。仅恢复已有构建时，可使用 `--skip-build` 跳过构建；
更新代码或依赖之后仍需重新构建，跳过构建不会部署最新代码。

### 安装依赖时显示 Killed

`Killed` 表示进程被外部终止；结合内核日志中 `Out of memory: Killed process ... (npm ci)`
可确认是 OOM。先查看服务器资源与内核日志：

```bash
free -h
swapon --show
df -h /var/www
dmesg -T | tail -n 30
```

已有足够 Swap 时，优先限制 npm 的堆和安装并发，无需重复创建 Swap：

```bash
cd /var/www/wangs
bash scripts/install-low-memory.sh --check
bash scripts/install-low-memory.sh
LOCAL_BUILD_HEAP_MB=512 bash scripts/start-local.sh
```

安装脚本自动使用 `.runtime/node/bin` 下的 Node，将 npm 的 V8 老生代堆限制为 384 MiB，
降低线程池与原生编译并发，并在前台运行安装脚本。堆上限不等于进程总内存上限；
`--maxsockets=1` 只限制每个源的下载连接，不能解决 npm 自身的堆增长。
`LOCAL_BUILD_HEAP_MB=512` 只约束构建进程，不会传给启动后的服务。

脚本会保留构建需要的 dev 和 optional 依赖，包括 TypeScript、Tailwind 和当前平台的
原生模块；不要通过 `--omit=dev` 或 `--omit=optional` 规避内存问题后再在服务器执行构建。
`npm ci` 会重建 `node_modules`，中途被终止后应重新安装完成再启动。脚本不会自动停止
网站，也不会修改 Swap、系统内存策略或其他服务。

如果变成 `JavaScript heap out of memory`，说明达到了 Node 堆上限；在确认服务器余量后
可通过 `NPM_HEAP_MB=512` 增大安装堆。如果仍被系统 `Killed`，检查当时的内核日志、
其他进程的实际内存，以及 cgroup 的内存与 Swap 限制。也可在相同 Linux 架构的构建环境
准备部署产物，避免在小内存服务器安装和构建；不要直接复制 macOS 的原生依赖到 Linux。

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

“发布内容”或“发布更新”只保存本地文章并生成本地内容链接，不检查水印处理状态，也不上传 OSS。
本地发布后，“全部文档”列表会出现同步图标；点击图标，在弹窗中输入远端网站根地址或公网 IP 并确认，
系统才会检查图片处理状态，将处理后的本地图片上传 OSS，替换正文为固定的 OSS HTTPS 地址并保存。
若上传期间文章被修改，则停止本次同步，避免覆盖新编辑内容。检查和上传完成后只发送文章 JSON；
远端接口按文章 ID 新增或更新内容，仍严格拒绝原图、本地图片地址、外链和 Blob，不接收或保存图片文件。
图片校验、OSS 或远端请求失败都不会撤销本地发布；OSS 地址一旦成功回写便保留，方便再次同步。

同步目标默认必须解析到公网 IP，且不允许 HTTP 重定向。如果两台服务只通过可信内网
通信，可仅在本地 `.env.local` 中显式配置 `ARTICLE_SYNC_ALLOW_PRIVATE=true`。

同步时每篇文章最多上传 50 张图片，每张最多 8 MB；远端文章 JSON 同步请求最多 512 KB，
不再需要为文章同步调大 Nginx 上传体积限制。

The page saver respects `robots.txt`, filters common ad containers, and does not
download images, video, scripts, forms, or watermarks. Run `npm run scrape` without
a URL for an interactive prompt. Results are written to `scraped-pages/` by default;
use `--output PATH` to choose another folder. Private or local development URLs are
blocked unless you explicitly add `--allow-private` for a host you control.

服务器直接对外提供服务时，还需要在安全组中开放对应端口。浏览器定位功能要求
HTTPS，正式环境建议在服务前配置 Nginx 和 TLS 证书。

## 文章列表管理与访问统计

后台导航中的“文章列表管理”（`/ops-7q4m/articles`）与“内容管理”同级。
需要管理员会话，可查询全部文章，按标题搜索、按发布状态筛选，并按修改时间、创建时间或访问次数排序，每页 20 条。
列表显示创建/修改时间（北京时间）、页面访问次数（PV）及最近访问时间，支持跳转到指定文章的编辑页和已发布内容页。

访问统计从功能部署后开始，不补算历史访问。文章详情页在浏览器实际挂载后上报一次；刷新、重新打开会增加次数，后台预览及服务端预加载不计数。
同一上报事件重复提交仅计一次。统计不是独立访客数，也不是防刷流量统计；禁用 JavaScript、拦截请求或网络失败可能漏计。
事件仅保存随机事件 ID、文章 ID 和访问时间，不保存 IP、设备标识或定位信息。数据保存在当前部署的 SQLite `article_view_events` 表，启动时自动创建；文章同步不合并本地与远端的访问量。

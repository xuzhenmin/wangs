# 微信分享配置与专用小封面

首页、旧内容页和 `/articles/{id}` 已接入微信 JS-SDK。文章使用自己的标题、摘要和版本化小封面；用户在微信里通过右上角菜单分享时，SDK 设置发给朋友和朋友圈的分享信息。直接复制网址到聊天框仍可能是文本消息，接入 SDK 不保证将粘贴消息转换为卡片。

## 部署配置

在实际提供网页的服务器 `.env` 中设置：

```dotenv
NEXT_PUBLIC_SITE_URL=https://news.osfeng.cn
WECHAT_APP_ID=你的公众号AppID
WECHAT_APP_SECRET=你的公众号AppSecret
```

AppSecret 仅供服务端使用，不要加 `NEXT_PUBLIC_` 前缀，也不要提交 Git。未同时配置 AppID/AppSecret 时签名接口返回 `{"enabled":false}`，不加载微信 SDK，不影响页面或小封面。

1. 在微信公众平台确认公众号具备 **JS-SDK 分享接口** 权限。
2. 将 `news.osfeng.cn` 配置为 **JS 接口安全域名**，按微信要求完成域名验证。安全域名不填写协议或端口；官方要求域名备案，不支持 IP 地址。
3. 如果公众号要求服务器 IP 白名单，将部署服务器实际访问微信 API 的出口公网 IP 加入白名单。
4. 同步代码后手动安装锁文件依赖：`npm ci --no-audit --no-fund --maxsockets=1`。小封面使用已固定版本的 `sharp`，不要省略平台可选依赖。
5. 使用项目启动脚本重新构建并启动：`./scripts/pause-local.sh && ./scripts/start-local.sh`。启动脚本不会自动安装依赖；这次包含代码改动，不使用 `--skip-build`。
6. 用手机微信打开正式 HTTPS 文章链接，等待加载后，通过右上角“…”→“发送给朋友”测试；朋友圈另行测试。分享入口、客户端版本和微信平台策略仍可能影响最终卡片表现。

## 小封面

- 文章：`/api/share/cover/{文章UUID}?v={版本}`；默认站点：`/api/share/cover`。
- 服务端将正文第一个有效的当前文章本地图片或已配置 OSS 图片缩放到 **480×480 JPEG、最多 100 KB**，等比完整保留原图，空白处用深色背景填充，不修改原图。
- 文章无图、首图损坏或下载失败时退回站点默认图。动态图片只取第一帧。
- 仅已发布文章提供文章封面。接口不接受任意外链参数，不跟随 OSS 重定向。
- 正文图片变更或文章更新会改变分享图片 URL 中的版本参数。内存缓存最多 32 张，源图片下载最多 8 MB，同一进程最多同时生成两张封面；生成过程不写入 Git 或 OSS。
- 图片响应提供 ETag 和短期缓存。平台自身可能保留旧卡片缓存，需要从最新文章重新分享；已发送消息不会被网站自动修改。
- 分享图接口是公开 GET，不要求定位授权或管理员登录。反向代理应允许匿名访问这些接口。

## 诊断

```bash
curl -i 'https://news.osfeng.cn/api/wechat/config?url=https%3A%2F%2Fnews.osfeng.cn%2F'
curl -I 'https://news.osfeng.cn/api/share/cover'
```

启用后签名接口只返回 AppID、时间戳、随机串、签名及接口列表，不返回 AppSecret、access_token 或 jsapi_ticket。服务端使用 stable_token（不强制刷新），缓存 token 和 ticket 至过期前 5 分钟，并合并并发刷新；失败退避 30 秒。缓存按进程保存，多实例部署会各自刷新。

浏览器日志前缀为 `[wechat-share]`。常见问题：

| 结果 | 检查项 |
| --- | --- |
| `enabled:false` | 正式服务是否已加载 AppID 和 AppSecret，修改后是否重启 |
| `invalid_origin` | 当前访问域名/HTTPS 是否与 `NEXT_PUBLIC_SITE_URL` 完全一致 |
| `wechat_40164` | 公众号服务器出口 IP 白名单 |
| `wechat_40013` / `wechat_40125` | AppID / AppSecret 是否正确 |
| `wechat_48001` | 公众号接口权限 |
| `config:invalid url domain` | JS 接口安全域名和域名验证 |
| `config:invalid signature` | 签名页面 URL 必须保留查询参数、去掉 `#`；iOS 使用当前文档最初进入的 URL |
| 图片 404 | 是否为已发布文章，UUID 是否正确 |
| 图片 503 | 封面生成临时繁忙，稍后重试 |

微信官方说明：[JS-SDK](https://developers.weixin.qq.com/doc/subscription/guide/h5/jssdk.html)。完成服务器和公众号配置后，仍需在真实微信中验收，自动化测试不代表微信服务器验证通过。

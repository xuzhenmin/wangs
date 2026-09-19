# 私密视频：加密 OSS 存储与访问码播放

新上传的视频在应用服务器上用 FFmpeg 封装为 AES-128 HLS，OSS 仅保存加密分片。浏览器通过本站校验访问码，再取得播放清单、解密密钥和短期分片地址。原有已上传的公开 MP4 不迁移、不删除；新流程不会自动降级为公开 MP4。

这不是规避内容审核的保证，也不是 DRM。应用服务器、管理员、服务器托管环境以及已获准的观看者仍可能接触明文。访问码可以被转发；撤销后不能收回已经下载、解密、录屏或缓冲的内容。旧公开视频链接仍然公开。

## 配置与上线

1. 两端更新代码，手动运行 `npm ci --no-audit --no-fund`。启动脚本不会安装依赖。视频打包仍要求 FFmpeg/ffprobe，首版只接受 H.264 视频及 AAC 音频（也可以无音频），不自动转码。
2. 在**每个部署自己的项目目录**执行 `node scripts/setup-private-video-keys.mjs`。它为 `.env.local` 补充独立的 `PRIVATE_VIDEO_MASTER_KEY`（32 字节 Base64）和 `PRIVATE_VIDEO_SYNC_PRIVATE_KEY`（Base64 编码的 RSA PKCS#8 PEM），不输出密钥、不覆盖已有非空配置。环境文件权限设为 0600。可传入另一环境文件的路径，但须确保应用实际加载该文件。
3. 安全备份环境文件和 SQLite 数据库。**不要重新生成主密钥或直接复制另一部署的密钥**，否则已有资源可能无法播放；密钥轮换需专门的数据重加密流程。本功能不提供自动轮换。
4. 配置服务端 OSS 凭据、Bucket、地域与私密目录。上传端需要新目录的写入、读取和私有对象 ACL 权限；远端播放服务也需要该目录的读取/签名权限，不能只保留公开图片的域名配置。推荐为远端使用独立的最小权限 RAM 身份。
5. 核对下方 OSS 与 HTTPS 设置后，在**上传端**设置 `PRIVATE_VIDEO_UPLOAD_ENABLED=true`；接收/播放端无需开启上传。构建并在没有进行中的视频任务时重启服务。数据库表在首次访问时自动进行非破坏性创建，保留旧数据。

配置项：

| 配置 | 用途 |
| --- | --- |
| `PRIVATE_VIDEO_UPLOAD_ENABLED` | 新加密上传开关，默认关闭 |
| `PRIVATE_VIDEO_MASTER_KEY` | 当前服务器加密保存视频密钥；独立于 OSS 和文章同步凭据 |
| `PRIVATE_VIDEO_SYNC_PRIVATE_KEY` | 当前服务器解封来自其他部署的视频密钥包 |
| `PRIVATE_VIDEO_OSS_PREFIX` | 默认 `private-videos`，两端一致；不要与公开图片/视频目录重叠 |
| `OSS_BUCKET` / `OSS_REGION` | 两端指向同一私密视频存储位置 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 仅服务端使用；上传端可写，播放端可只读 |
| `ARTICLE_SYNC_SECRET` | 两端相同的现有接口认证密钥，不用于加密视频 |

所有真实凭据只放在忽略的环境文件/部署密钥管理中，不填写到 `.env.example`，不发给浏览器。主密钥与数据库必须一起备份；只备份其中一个无法恢复播放。

### OSS 权限与跨域

- 使用新私密目录和对象级 `private` ACL，不修改整个共享 Bucket 的公开读设置，避免破坏既有图片和视频。
- 不复用公开 CDN 地址；私密分片走 Bucket 的标准 HTTPS 地址与短时签名。若 Bucket Policy 仍强制公开新目录，应先修正该目录的策略；程序发现匿名可读会拒绝标记上传成功，不代替管理员修改云端策略。
- 新目录应允许授权 RAM 身份 GetObject、PutObject 和所需 ACL 操作；接收端只有读取即可。按实际 SDK 操作核对最小权限。
- 为**实际播放站点的完整 Origin**设置 OSS CORS：允许 GET、HEAD 和 Range 请求，暴露 Content-Length、Content-Range、Accept-Ranges、ETag；不要依赖向 OSS 传递本站登录 Cookie。若 native HLS 的匿名跨域请求 Origin 为 `null`，需在目标真机上核验兼容性，再按实际客户端行为配置。
- 签名地址默认 60 秒；清单中保存的是本站稳定分片路径，每次请求再签名。禁止在 CDN/Nginx 缓存访问码、清单、密钥和分片跳转接口。
- 失败或进程中断可能留下不可用的加密分片。不会删除本地原视频、旧公开对象或共享目录；清理前应核对数据库中的有效资源引用。

### HTTPS 和反向代理

生产观看和私密视频同步必须使用 HTTPS。Next 绑定回环地址，由 Nginx 终止 TLS，后端端口不对公网开放。反向代理应覆盖而非盲目信任客户端传来的头：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
client_max_body_size 2m;
proxy_read_timeout 480s;
```

`2m` 仅是视频资源描述同步的最低建议；原有其他上传接口如需更大体积，保留较大的配置。不要将该值用作整个站点的缩小限制。localhost HTTP 只用于开发验证，不作为部署方案。

## 操作流程

1. 后台“本地视频保存”完成下载后，点击加密上传。等待状态完成；原本地 MP4 保留。
2. 文章编辑器点击“视频”，选择已上传的私密视频。右侧预览可播放；保存草稿或发布仍是独立操作。
3. 后台视频页的访问码管理中，为观看者创建并复制访问码。原文仅创建时显示，丢失时新建一个并撤销旧码。
4. 观看者输入一次有效码后，可看当前站点全部私密视频；会话默认 30 天。访问码不自动到期、可以跨设备使用。会话到期后可重新输入仍有效的码。
5. 撤销访问码立即影响后续本站鉴权请求。已发出的分片签名还可能在短有效期内访问，已取得的内容无法召回。
6. 同步已发布文章时填写远端 **HTTPS** 地址。系统先认证远端能力，将视频密钥用远端公钥封装；远端核验私有对象可读后独立加密保存，再接收文章。远端不兼容、配置缺失或校验失败时停止，不发送公开替代地址。访问码和会话不随文章同步，需在实际播放站点创建。

## 验证

`npm run test:private-videos` 使用隔离的 SQLite、随机测试密钥、模拟 OSS 以及非敏感合成视频，不读取用户视频或真实凭据。运行时测试需先构建；可使用 `WANGS_BUILD_DIR=.runtime/private-video-build npm run build`，随后给测试设置相同变量，避免影响正在运行的网站构建。

上线验收还需使用自有测试 OSS 和 HTTPS 域名，实测 Chrome、Safari、iOS 微信和 Android 微信的首次授权、播放、拖动、长视频、断网恢复与撤销。自动化测试不能替代真实微信兼容性验证。

# 匿名访客统计

- 文章列表显示 PV（访问次数）与 UV（匿名浏览器访客数），支持按 UV 排序、查看每篇文章的分页访问明细：稳定匿名编号、次数、首次和最近访问时间。顶部 UV 跨文章去重，不等于每篇文章 UV 相加。
- 文章页面挂载后使用 `POST /api/articles/{id}/view` 申请访问，请求体只有一次访问的随机 `eventId`。服务端在同一写事务内检查额度、记录获准访问，返回经清洗的正文；受限请求返回 403，不增加 PV/UV。SSR、RSC 预加载不包含正文，也不消耗额度。服务端首次生成独立随机 UUID，通过同域 `shenxiang_article_visitor` Cookie 保存 30 天，不续期；后续请求由浏览器自动携带。无账号、无定位依赖，不读 localStorage 中的定位 deviceId，不采集 User-Agent、指纹、手机号或微信身份。IP 仅在服务端用于下述省市估算，不参与匿名编号或 UV 计算，不持久保存原始 IP。
- Cookie 使用 Path=/、HttpOnly、SameSite=Lax，HTTPS（含受信任反向代理传入的 X-Forwarded-Proto=https）加 Secure；不设置 Domain。部署代理应覆盖客户端提供的转发头，不原样信任任意客户端值。属性参考 [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。
- 数据库只保存带用途前缀的 SHA-256 派生编号，不保存或向后台输出 Cookie 原值。此编号不是认证凭据；访问明细仅向已登录超级管理员提供，并设置 no-store。
- 收到 DNT:1 或 Sec-GPC:1 时不关联访客，清除本 Cookie，仅保留不带访客编号的访问次数。
- 清除/禁用 Cookie、无痕、不同浏览器、到期或不同域名可能产生新访客；共用浏览器可能合并不同人。完全未建立 Cookie 时并行打开多个页面也可能短暂产生多个编号。因此 UV 是近似浏览器统计，不是真实人数或严格防刷计数。
- 30 天是浏览器编号的保存期限，不是访问事件自动删除期限。事件沿用现有累计保存方式。各部署环境的数据库分别统计；同步文章不传递访问记录。
- 启动读取数据库时，以写事务检测并增加 `article_view_events.visitor_key` 可空列及索引，不删除或重写原访问记录。历史记录保留 PV，不虚构历史 UV；明细显示“未识别访问”。Drizzle schema 同步描述字段；项目运行使用 `db/index.ts` 的幂等迁移，无需手动改库。

## 文章访问量管理

- 后台 `/ops-7q4m/articles` 显示每篇文章的访问状态、剩余 UV/PV 额度。点击“访问量管理”或“解除限制”，设置从保存时起剩余可访问的额度；UV、PV 可分别选择不限。0 表示立即限制访问。
- 默认每篇文章累计 UV 额度为 10，PV 不限，也适用于已有文章。第 10 位访客获得正文后耗尽额度，后续打开文章的所有访客（包括曾访问过的浏览器）均显示“访问受限”，直到管理员调整额度。已经加载的正文不会从读者浏览器中撤回。
- UV 额度用量 = 文章的累计匿名 UV + 未识别访问次数。隐私信号和历史记录中的未识别访问，每次占用 1 份 UV 额度，但不加入统计 UV；不额外识别这些访客。UV/PV 任一额度耗尽即受限。
- 解除时填写剩余 UV 为 5，会把上限设为保存瞬间已使用的 UV 额度 + 5。原访客在开放期间再次打开仅消耗 PV，新访客消耗 1 UV 和 1 PV。若 PV 已耗尽，也需同时增加 PV 或设为不限。历史记录不清空，额度不按天或按 Cookie 有效期重置。
- 额度与累计量保存在当前部署的 SQLite 中。`article_access_policies` 保存绝对上限及设置版本；启动自动建表并为访问记录添加 `access_revision`。文章编辑和同步不覆盖访问设置；不同部署分别累计和管理，新增同步文章采用默认额度。
- 额度检查、放行和事件写入使用 `BEGIN IMMEDIATE` 事务，多个服务进程共享数据库时不会超额放行。重复事件只计一次；同文章、同访客、同设置版本的已获准事件可在 60 秒内重试获取正文，包含刚用完最后一份额度的事件。历史事件、跨文章/跨访客事件不能作为通行凭据，管理员保存新设置会使旧事件失效。
- 后台设置接口 `GET/PUT /api/admin/articles/{id}/access` 仅限管理员，响应不缓存。PUT 传入 `{ remainingUv, remainingPv, revision }`，额度为非负整数或 `null`（不限）。版本冲突返回 409，防止旧表单或重复保存意外追加额度。
- 访问校验失败或网络异常时不显示正文，可以重试；打开受限页面不会触发正文定位流程。正文中的图片和分享封面沿用原有图片托管方式，本功能控制文章正文获取。

验证：构建后运行 `node --test tests/article-visitors.test.mjs tests/article-access-gate.test.mjs tests/article-access.test.mjs`。测试使用隔离数据库，覆盖旧库升级、匿名访客统计、双进程并发额度竞争、UV/PV 上限、管理员释放、权限和输入校验、正文保护、隐私信号、重试与弹窗。`ARTICLE_VISITORS_UI_REVIEW=1 node tests/article-visitors.test.mjs` 可保留临时页面供检查，完成后回车清理测试数据。

## 访客地区（IP 估算）

后台文章“访问明细”增加地区列，展示每个匿名访客在当前文章最近一次访问的省市，标明“高德 IP 估算”。只表示网络出口的大致归属地，不代表街道或住址。最近一次访问未识别、查询未完成或失败时显示“未知”，不拿之前访问的地区冒充当前地区；历史记录不回填。

新的获准访问提交计数事务后，通过 Next `after()` 在响应完成后异步查询高德 `/v3/ip`。只查询已识别匿名访客的访问；重试事件、受限请求、DNT/GPC 请求不查询。单次请求最多等待 2 秒，查询或落库失败不影响正文、PV/UV、访问额度及精确定位授权。单个进程对相同 IP 合并并发查询，结果缓存有效期 10 分钟、失败 1 分钟，缓存最多 512 条且不落盘。

启动自动创建 `article_view_regions`，按访问事件 ID 保存省份、城市、来源 `amap-ip` 与解析时间。原始 IP 只短暂用于服务端查询与内存缓存，不写入数据库、后台响应或应用日志。IP 粗定位与 `consented_locations` 精确定位独立，不新增定位授权，也不变更原有授权判断、隐私信号或内容流程。

接入时设置 `AMAP_WEB_SERVICE_KEY`（复用现有高德 Web 服务 Key）及 `ARTICLE_VISITOR_IP_HEADER`。高德基础 IP API 仅支持国内 IPv4；IPv6、私网、保留地址、海外或未收录 IP 显示未知。不传 IP 会定位到应用服务器，因此程序绝不省略该参数，也不使用服务器 IP 兜底。接口契约见 [高德 IP 定位文档](https://lbs.amap.com/api/webservice/guide/api/ipconfig)。

Next Request 不提供原始 TCP 连接地址，只能依赖部署入口给出的可信请求头，默认不猜测。选择以下与部署一致的方式：

- Nginx 直接接收访客请求：设置 `ARTICLE_VISITOR_IP_HEADER=x-real-ip`，Nginx 必须覆盖 `X-Real-IP` 为 `$remote_addr`。
- Cloudflare：设置 `ARTICLE_VISITOR_IP_HEADER=cf-connecting-ip`，保证请求必经 Cloudflare，限制源站入口，且中间代理正确保留该头。
- 使用 `X-Forwarded-For`：设置 `ARTICLE_VISITOR_IP_HEADER=x-forwarded-for` 和 `ARTICLE_VISITOR_PROXY_HOPS`。从右侧选择与可信代理层数对应的地址，默认 1；不盲信客户端可以伪造的最左侧值。各代理必须按既定链路附加真实上游地址。

仅适用于“访客直连 Nginx，无 CDN”的配置示例（合并到现有 `location` 块，不替换其他设置）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3217;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 保留本站现有的其他代理设置
}
```

同时将 Next 端口限制为只接受代理连接（例如仅监听回环地址），防止绕过代理伪造头部。若 Nginx 前还有 CDN，不直接套用此示例，否则会记录 CDN 出口地址。

验证：`node --test tests/article-visitor-region.test.mjs` 覆盖真实 IP 提取、未知地址、隐私信号、查询失败/超时、缓存去重、异步写入及最新访问地区。`tests/article-visitors.test.mjs` 在隔离的 Next 服务中使用模拟高德响应验证 `after()`；测试不会把真实访客 IP 发给外部服务。全量回归运行 `npm test`。

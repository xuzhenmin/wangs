# 匿名访客统计

- 文章列表显示 PV（访问次数）与 UV（匿名浏览器访客数），支持按 UV 排序、查看每篇文章的分页访问明细：稳定匿名编号、次数、首次和最近访问时间。顶部 UV 跨文章去重，不等于每篇文章 UV 相加。
- 文章页面挂载后沿用 `POST /api/articles/{id}/view`，请求体仍只有一次访问的随机 `eventId`。重复事件只计一次。服务端首次生成独立随机 UUID，通过同域 `shenxiang_article_visitor` Cookie 保存 30 天，不续期；后续请求由浏览器自动携带。无账号、无定位依赖，不读 localStorage 中的定位 deviceId，不采集 IP、User-Agent、指纹、手机号或微信身份。
- Cookie 使用 Path=/、HttpOnly、SameSite=Lax，HTTPS（含受信任反向代理传入的 X-Forwarded-Proto=https）加 Secure；不设置 Domain。部署代理应覆盖客户端提供的转发头，不原样信任任意客户端值。属性参考 [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。
- 数据库只保存带用途前缀的 SHA-256 派生编号，不保存或向后台输出 Cookie 原值。此编号不是认证凭据；访问明细仅向已登录超级管理员提供，并设置 no-store。
- 收到 DNT:1 或 Sec-GPC:1 时不关联访客，清除本 Cookie，仅保留不带访客编号的访问次数。
- 清除/禁用 Cookie、无痕、不同浏览器、到期或不同域名可能产生新访客；共用浏览器可能合并不同人。完全未建立 Cookie 时并行打开多个页面也可能短暂产生多个编号。因此 UV 是近似浏览器统计，不是真实人数或严格防刷计数。
- 30 天是浏览器编号的保存期限，不是访问事件自动删除期限。事件沿用现有累计保存方式。各部署环境的数据库分别统计；同步文章不传递访问记录。
- 启动读取数据库时，以写事务检测并增加 `article_view_events.visitor_key` 可空列及索引，不删除或重写原访问记录。历史记录保留 PV，不虚构历史 UV；明细显示“未识别访问”。Drizzle schema 同步描述字段；项目运行使用 `db/index.ts` 的幂等迁移，无需手动改库。

验证：构建后运行 `node --test tests/article-visitors.test.mjs tests/article-view-tracker.test.mjs`。测试使用隔离旧版数据库，覆盖迁移、重复事件、相同/不同浏览器、跨文章 UV、隐私信号、鉴权及分页。`ARTICLE_VISITORS_UI_REVIEW=1 node tests/article-visitors.test.mjs` 可保留临时页面供检查，完成后回车清理测试数据。

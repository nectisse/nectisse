# Peach 提取记录

来源：<https://github.com/peach-mitao/peach>。本工作区 `ref/peach` 快照的版本声明为 **0.46.1**，未附 Git 元数据，因此不虚构 commit。以下三个文件最初按字节提取；之后仅有工作区格式化变化（换行、import 排序、Python 3.14 except 写法），未修改传输与编号规则。表中保留原始快照哈希：

| 原路径 | 本地路径 | SHA-256 |
| --- | --- | --- |
| `src/peach/http.py` | `peach_core/http.py` | `5bb5dd4b8d8b10017bf1d5722e1792e6c0acccb860789b6a87b75e82460cade8` |
| `src/peach/user_agent.py` | `peach_core/user_agent.py` | `06d1580aa4cff6dbf0cf40254b58bada4b0ae5398e73d288450afc73ded350a2` |
| `src/peach/catalog_rules.py` | `peach_core/catalog_rules.py` | `5b4b771b423f6b521d9c0db9a7cb6b2283664510c2848aabb14158aac1b051bb` |

原许可证保存为 `PEACH-LICENSE`（AGPL-3.0-or-later）。`peach_core/__init__.py` 仅建立隔离命名空间；Nectisse 的工作者和进程管理是新增代码。

选择依据：网络传输模块保留 HTTPX 和 curl_cffi 两条传输路径、响应体上限、编码解析及重定向处理；编号规则模块只依赖标准库，其字符串路径规则不会执行磁盘扫描。`user_agent.py` 是前者的必要依赖，目前保留上游固定值，不代表当前设备或所有站点的最佳指纹组合。

当前格式化后的文件哈希（对应离线回归）：

- `http.py`：`588efcd9b90c00b731a0d2fe0df3ef18791e7ce6b30c0129bbc335b0d80d2be4`
- `user_agent.py`：`a934b84f8e6e19c34132802ad2cd4dcd796d3e2459314af24958c6141a2e8daa`
- `catalog_rules.py`：`7731338323b786663991a90e3010f246c1f5a9c2165a0094ee24ae3189531b59`

## 资料连接器提取（2026-10-23）

`scripts/extract-metadata.mjs` 从同一只读参考快照提取 `sources/dmm.py`、`sources/r18dev.py`、`sources/fc2.py`，替换其 Session / Page / SiteRecord / SourceFailure 导入，接到 Nectisse 的最小契约；不会导入 Peach 服务、数据库、任务或文件扫描。

r18.dev 额外兼容当前 `images.jacket_image` 的 large / large2 对象形态，跳过仅含空格的值，保留旧字符串兼容。DMM 与 FC2 解析内容保持上游规则；Nectisse 在自己的 `metadata/dmm.py` 再校验原生 CID 与 makerContentId 不能互相冲突。日文补全失败后的实际英文标题回退、角色划分和字段预算在 Nectisse 规范化层处理。

另从 `metadata.py` 提取 `IDENTITY_FIELDS` 至 `identifies_code`，从 `jav_cover_fetch.py` 提取 `_DMM_CID` 至 `is_cross_product_cover` 及宽度阈值常量，建立独立 `identity.py` / `cover_identity.py`。提取片段只替换必要 import，不搬入庞大的封面与库处理管线。完整上游与本地哈希见 `metadata-extraction.json`。

Nectisse 自行实现逐请求许可、超时 / 大小 / 域名预算、来源冷却、图片解码与缓存，不复用 Peach 的总 Session 或整体后端。当前图片只标记来源匹配，尚未复用完整图片互证、裁剪及人脸相关处理。

DMM 与 r18.dev 有独立应用的真实成功样本；FC2 仅离线解析通过，在线样本返回 404，不能当作已经验证接通。其余来源及 amane 的提取记录见“来源扩展”。浏览器验证运行时尚未提取。

## 订阅提取（2026-10-23）

`scripts/extract-follow.mjs` 提取以下纯解析实现，原始和本地 SHA-256 记录于 `follow-extraction.json`：

- `fanbox.py` 的纯正文解析模块，保持原实现；Nectisse 只使用实际文本摘要，不调用资源展开、下载或播放管线。
- `javdb.py` 的演员卡、姓名与原生身份解析，唯一修改是将 `name_key` import 指到独立提取的 `follow_primitives.py`。
- `social_links.name_key` 的名字比较片段，不导入社交发现模块其余部分。
- `feeds.py` 的演员目录正则、编号扫描、`FeedEntry` / `ParsedFeed` 和纯解析函数，提取边界到 `solo_works_url` 之前；没有 SQLite、账本或自动资料后继。

Nectisse 的 `follow.py` 按 Peach `follow_sources.FanboxConnector` 的 API、URL 身份与分页流程适配，用 `creator.get` 核对主页；公开正文使用原定 `chrome150` 指纹。标题、摘要与文字公告保留，受限帖仅保存接口实际给出的公开字段，不沿用资源交付或免费帖过滤。

Peach 的 `CurlCffiTransport` 会自动跟随重定向。本应用增加 `follow_transport.py`，保留 curl_cffi 的浏览器指纹能力，但改为逐跳校验 HTTPS / 允许域名、申请 TS 许可、计数，并去除跨来源的 Cookie 请求头。不能用普通 fetch 或 Electron Chromium 当作其等价替代。

凭据、SQLite、调度和取消由 Nectisse 的 TS 主进程管理；不复制 Peach `CredentialStore`、APScheduler、资源过滤、下载后继或媒体播放逻辑。FANBOX 查询和实际动态已成功验证；JavDB 官方 HTML 当前返回地区限制，在线成功仍待有可访问出口后核验。

## 来源扩展

- `extract-metadata.mjs` 提取全部直接资料解析器：DMM、r18.dev、一本道、FC2、FC2CMADB、FC2PPV-DB、JAVten、JavArchive、AVBase、JavBus、JavDB、三份 Seesaa Wiki 与 K-MIB。适配最小契约 import；JavDB 剔除资源与磁链方法，Wiki 剔除原取页／缓存类，搜索最多三条、厂牌补页最多一条，所有取页经过 Nectisse Session。
- `extract-follow.mjs` 另提取 Patreon / SubscribeStar 的公开卡片、日期与 URL 解析段至 `peach_core/official_posts.py`，由 `follow_official_support.py` 注入受限网络契约。归档三站与 Rule34Video 按原 API、身份和列表选择器适配，不调用详情资源展开，不按“交付资源”筛帖。
- `extract-amane.mjs` 从固定 revision `cc42cee6ecf290cf05af1caa347d2dc2d5aeffcd` 的 SHA-256 校验快照提取九个站点及十九个纯依赖文件，包入口替换为无副作用入口。完整爬虫文件保持原样；不存在上游聚合、数据库或服务的运行依赖。仅补充 parsel / pydantic / structlog 的锁定依赖；GPL 许可证与逐文件哈希随包保留。
- `metadata/amane.py` 的有界异步客户端将爬虫请求转回 Nectisse Session：保持 curl_cffi 指纹选择、逐跳域名检查、请求预算、取消与失败分类；不使用上游自动重试、下载或渲染器。Prestige 配信开始日单独保存，紧凑编号规范化后与其他来源归到同一作品。
- Seesaa 提取哈希含必要适配，其纯作品表解析、精确编号与不确定人物警告保留；K-MIB 仅读取用户指定的单片 URL，不引入列表采集或磁盘扫描。

支持矩阵在根目录 `SOURCE_SUPPORT.md`。在线成功样本与尚未完成的验收分开记录；源码存在、导入通过和真实查询成功是不同的验证等级。

## Sukebei 作品磁链查询

`nectisse_worker/magnets.py` 按参考快照 `src/peach/magnet_chain.py` 的 `Fetcher.sukebei` 表格选择器、磁链读取及编号核对流程适配；直接复用随包 `peach_core.catalog_rules` 的规范化与 `_jav_code_pattern` 边界片段，以及承接 Peach 传输的 `NetworkSession`。没有导入 `downloads`、`resource_search`、其他搜索来源或下载服务。

适配只读搜索首页，按站点顺序保留最多 20 条匹配记录并按 info hash 去重，补充独立名称链接、UTC 上传时间和完成次数；不使用整行文本充当标题，不逐条获取文件列表，也不采用原实现的 8 条候选上限或质量排序。日期式编号保持发行方分隔符，普通编号支持现有补零／紧凑写法并核验前后边界。明确空页和表格结构错误分开处理。

网络、站点限流、结果缓存、真实取消及进程回收继续由 Nectisse 管理；此次只增加磁链搜索与复制，不增加资源下载或磁链协议启动器。上游许可仍随 `PEACH-LICENSE` 保留。

# Nectisse

私人作品资料、封面收藏与创作者更新工具。产品方案见 [PLAN.md](PLAN.md)。

当前包含 **36 项来源配置、24 个资料来源与 8 个订阅来源的派发能力**。JavDB 同时提供资料与演员新作；另有 5 项因缺少前置条件或作者语义而只登记、不派发。来源可用性与在线验收分开显示，完整清单见 [SOURCE_SUPPORT.md](SOURCE_SUPPORT.md)。模拟方案保留在单独的“视觉演示”入口。

## 在 App 中使用

打开 `dist/mac-arm64/Nectisse.app`，或执行 `npm run dev`。若旧版还在运行，先 `⌘Q` 退出再打开新版。

1. 在“资料查询”输入 `SSIS-057` 等编号、标题关键词或支持的原站商品链接，再点击查询。打开 App 和点击示例不会自动发送请求。
2. 展开“资料来源”选择站点；灰色来源需先在设置中启用，也可选择全部已启用来源。编号按站点类型分流，标题目前仅由 DMM 返回最多 3 个候选。点击结果查看各站原值、获取时间、原文链接与封面尺寸。
3. 查询过程中可取消，切换页面后底栏仍显示任务。取消会停止后续请求、终止在途工作者并保存终态；已取消任务不会在重启后恢复。
4. “查询记录”可打开最近 20 项本地结果。相同查询 1 小时使用缓存；“重新采集”强制刷新，但仍遵守站点冷却。
5. 点击结果卡片的“收藏作品”，或在详情中选定封面后收藏。侧栏“作品收藏”可切换资料卡片与照片墙，点击封面打开本机资料详情。

支持 DMM 含原生 `id` / `cid` 的商品链接、r18.dev 的 `dvd_id` / `combined` 链接、FC2 商品链接、JavDB 单片链接、K-MIB 带 `idx` 的单片链接与一本道作品页。其他原站链接需含可可靠识别的编号，否则请改用编号。日期式编号须用原站链接确认发行方，或仅选择一本道；FC2 分段编号不当成整部商品。

右上角“视觉演示”保留原四页模拟交互；模拟数据与真实查询记录分开。创作者关注、已读、档案保存和人工字段修正在演示中只改变内存状态，没有接入真实业务。两种外观、`⌘K`、封面比较等设计仍保留。

## 作品收藏与照片墙

- 收藏保存各来源资料快照、原文链接、获取时间和选定封面的原图；不受最近 20 次查询或普通缓存清理影响，重启后可离线浏览。暂无封面的作品也可收藏，界面明确标记。
- 同编号重复收藏去重。查询不会自动覆盖已存快照，详情中的“更新收藏”才采用当前资料和预览封面，并保留首次收藏时间。未选封面仅保留来源信息，只有与选定封面使用同一图片哈希的候选可共用已保存原图。
- 卡片展示标题、人物和发行日期；照片墙突出封面和编号。支持本地搜索编号、标题、人物、厂牌与标签，按收藏时间、发行日期或编号排序；首次显示 60 部，按需显示更多，首版最多收藏 5000 部。
- 取消收藏需确认，只移除该收藏及不再被其他收藏引用的图片。已有查询和订阅保留。收藏库初始化失败可以在原进程重新检查，不要求重启 Python。
- 照片墙只浏览作品封面和资料。播放、视频及资源下载、下载资源搜索与媒体磁盘扫描均不在范围内。

## 真实关注与设置

- **创作者 → 添加关注 → FANBOX**：粘贴创作者主页或输入 FANBOX 账号 id，查询后核对候选并“确认关注”。当前支持主页 / 账号识别，不提供全站显示名搜索。初次检查首页最多 10 条，最多补充两篇新增公开帖正文，文字公告和进度同样收录。
- **创作者 → 添加关注 → JavDB**：按演员名或演员主页查询，核对演员卡的站内 id 与记录类型后订阅新作。同名创作者与演员不会自动合并；JavDB 地区限制、登录页、浏览器验证和解析失败分别处理。
- **其他创作者来源**：Patreon、SubscribeStar 使用主页／本站账号；Kemono、Pawchive、Coomer 使用主页或 `service/user_id`，不会在普通查找中下载全站索引；Rule34Video 使用作者／模特关联主页，并明确显示署名关系。只有 JavDB 提供演员新作查询。
- **设置 → 来源与账号**：按用途筛选或搜索 36 项来源，启停、配置各站 Cookie 与标准／指纹传输、查看访问状态、调整资料采用顺序。新增来源默认关闭，不会一次向所有站点发请求。Cookie 通过 Electron safeStorage 加密后存入 SQLite，原值不回显、不进入普通日志。
- **设置 → 订阅管理**：查看创作者动态 / 演员新作，暂停、恢复、取消关注、手动检查及设置频率。自动检查默认关闭，开启后创作者默认每小时、演员每 6 小时。取消任务会暂停该订阅的自动检查，需手动检查或恢复后继续。
- **设置 → 网络与存储**：系统代理、直接连接或不含认证信息的独立 HTTP / SOCKS 代理。各站传输方式在“来源与账号”配置；FANBOX 公开正文始终保留指纹传输，它不代替登录或浏览器验证。
- **更新**：真实动态 / 演员新作筛选、未读 / 全部、仅当前列表全部已读、来源原文及正文摘要。初次目录单独标记，发布时间、发行日期与发现时间分开。

可用 `⌘,` 打开设置。关注、条目、已读、偏好、冷却与取消状态在窗口关闭和 App 重启后保留；取消关注保留已经收录的内容。首次检查失败仍保留订阅及错误，不伪装成“没有动态”。

当前 JavDB 实际出口被站点地区限制，返回 HTTP 200 的限制页，已正确分类。需要可访问的出口继续在线验证；Cookie 或浏览器指纹不保证解决地区限制。App 不修改系统代理。

## 本轮能力与限制

| 来源 | 实现 | 本机验证 |
| --- | --- | --- |
| DMM / FANZA | 编号、关键词候选、原生 CID 链接；标题、人物/导演、厂牌、品牌、系列、发行日、标签、简介与封面 | `SSIS-057` 与 2184×1468 封面成功；关键词入口取得 3 个候选 |
| r18.dev | 编号与支持的作品链接；原始与日文 JSON，英文回退明确标记 | `SSIS-057` 与 800×538 封面成功 |
| FC2 | 商品 JSON-LD / DOM；SKU 核验、卖家角色、不推断出演人物 | 离线解析通过；在线样本返回 404，待验证 |
| FANBOX | 主页 / 账号查询、关注、公开动态及实际可见的受限摘要、有界增量与封面缓存 | 真实账号与 10 条动态、重复刷新、已读及取消已验证 |
| JavDB | 作品资料、演员名 / 主页查询、确认演员身份、订阅新作目录 | 成功流程离线验证；真实请求被当前出口地区限制 |
| AVBase、一本道 | 资料与封面候选 | 已有真实资料成功样本 |
| amane 九站 | 固定 0.20.0 的纯爬虫，统一有界网络 | S1 片商官网样例成功；其余尚未逐站在线验收 |
| SubscribeStar、Kemono | 真实身份、关注与首页动态 | 已分别取得 6 条与 50 条实际动态 |
| Patreon、Pawchive、Coomer、Rule34Video 及其余直接资料来源 | 对应连接器已接入，支持范围见矩阵 | 解析／身份与派发测试通过；没有逐站在线成功样本 |

字段仅显示来源实际提供的内容。默认 DMM → r18.dev 选择首个非空显示值，来源差异与原值独立保留。当前每个来源结果自动缓存第一张候选封面；保留 Peach 跨作品 URL 排除规则，额外验证图片解码、尺寸、格式和大小。仅标记“来源匹配”，尚未完成跨来源图片互证。

未接入自动浏览器登录 / 验证、手动资料修正或封面导出。Rule34 标签站、F95zone / SimpCity 论坛与 DUGA 仅登记边界条件。Cookie 由用户主动填写，不读取浏览器 Cookie 库。没有资源搜索/下载、媒体扫描或播放器。

## 运行、数据与网络

Electron / TS 管理窗口、单实例、受限 IPC、SQLite、调度、任务许可、来源冷却、查询记录和缓存；每个 Python 任务使用独立进程及有界 NDJSON 管道。Python 复用 Peach 来源、身份、FANBOX 正文与演员目录解析，Pillow 验证封面。FANBOX 详情使用 curl_cffi，逐次重定向重新校验并申请许可；普通 fetch 与 Electron Chromium 不被视为原传输或验证流程的等价替代。

双击先显示窗口，随后检查随包环境。关闭窗口保留后台任务，Dock 可唤回；`⌘Q` 中断任务并清理本应用工作者及其子进程。重启后旧运行任务标为中断，已请求取消的任务标为取消，不自动续跑。

默认数据目录为 `~/Library/Application Support/Nectisse/`：

- `nectisse.sqlite`：SQLite 保存设置、加密凭据、订阅、条目、已读、检查状态与任务；使用 Electron 内置 node:sqlite，无额外数据库服务。
- `metadata/state.json`：原子写入最近 20 项作品查询、来源快照、取消状态与站点冷却；不替代正式作品档案库。
- `library/library.sqlite` 和 `library/covers/`：正式作品收藏和选定封面，独立于查询记录；图片按 SHA-256 去重，长期保留，不参与普通缓存淘汰。
- `cache/covers/`：SHA-256 命名的原始封面、128 MiB 预算与独立临时目录。缓存清理仅访问这个应用目录。
- `cache/subscription-covers/`：动态封面和头像，共享 64 MiB 预算。自动补齐最近 500 条更新中来源实际提供的封面，受来源启停、订阅暂停、取消、站点限流和有限重试约束；图片不可用时仍保留正文。

真实资料查询、作品详情和封面候选以 `2184 : 1468`（约 `1.49 : 1`）横向画框展示，完整容纳原图；其他比例的图片保留留白，不裁切或拉伸。查询记录仍有 20 项上限，查询图片受缓存预算约束；需要长期保存的作品请加入“作品收藏”。

单个活动查询、每站至少 2 秒间隔（包括重定向与封面），每工作者最多 8 次请求 / 45 秒调度预算、连接与读取超时最多 12 秒，宿主在 60 秒终止工作者；整个查询最多 24 次请求，无自动重试。429、验证要求与临时网络故障分别冷却，状态跨重启保存。

网络按设置选择系统代理、直连或独立代理，再通过私有管道传给 Python；不继承宿主代理环境、不降低 TLS 校验。代理认证暂不支持，敏感响应和代理信息不进入普通日志；独立代理地址作为用户设置保存。渲染进程仅通过受限本地封面协议显示缓存图片。

## 开发和构建

当前验证平台为 macOS arm64。开发机需要 Node.js >= 22.12、npm、uv；最终用户无需安装这些工具或 Python。

```sh
npm ci
npm run dev
```

```sh
npm run python:prepare
npm run build
npm test
npm run test:python
npm run test:desktop
npm run package:mac
```

随包 CPython 3.14.9 与 wheel 在构建时准备，版本和哈希锁定在 `python/requirements.lock`；应用启动时不安装依赖。依赖变更后执行 `npm run python:lock` 和 `npm run python:prepare`。

正式应用图标位于 `resources/icons/`：`icon.png` 是 1024 × 1024 白底双瓣负形源图；`icon-macos.png` 用于运行时 Dock，`icon.icns` 用于 macOS 打包和 Finder。替换源图后运行 `npm run icons:build`；`package:mac` 会自动生成图标。详见 [图标资源说明](resources/icons/README.md)。

`package:mac` 在 `.build/packaging/` 中完成打包后，再替换 `dist/mac-arm64/Nectisse.app`，避免 Finder 的 `.DS_Store` 干扰。当前产物用于本机开发，尚未正式签名、公证或验证 Intel 与干净机器。

## 结构和复用记录

| 路径 | 作用 |
| --- | --- |
| `src/main/metadata-input.ts` | 输入身份和来源分流 |
| `src/main/metadata-service.ts` | 调度、取消、查询记录、缓存与来源冷却 |
| `src/main/subscription-store.ts` | SQLite 订阅、条目、已读、加密凭据与任务 |
| `src/main/subscriptions-service.ts` | 查找确认、关注、检查、TS 定时、取消及动态封面 |
| `src/main/python-host.ts` | 工作者管道、逐请求许可与进程组回收 |
| `src/preload/`、`src/shared/` | 受限 IPC 与双向结构校验 |
| `src/renderer/src/metadata/` | 真实查询、详情、来源差异与封面展示 |
| `src/renderer/src/subscriptions/` | 正式工作区、设置、创作者 / 演员和更新流 |
| `src/renderer/src/prototype/` | 保留的四页模拟预览 |
| `python/src/nectisse_worker/metadata/` | 来源契约、有界传输、严格 DMM 身份与图片验证 |
| `python/vendor/` | Peach 提取模块、许可证、修改与哈希记录 |
| `scripts/extract-metadata.mjs` | 从只读参考快照重现连接器和身份规则提取 |
| `scripts/extract-follow.mjs` | 重现 FANBOX 正文、JavDB 演员卡与目录的纯解析提取 |
| `scripts/extract-amane.mjs` | 校验固定快照并提取九个爬虫及其纯依赖 |
| `python/src/nectisse_worker/source_catalog.json` | TS、Python 与来源矩阵共用的 36 项能力登记 |

应用不导入 `ref/peach/`，也不启动 Peach 服务。提取记录见 [UPSTREAM.md](python/vendor/UPSTREAM.md)，许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 验证

本机验证包含 TS 类型检查与三端构建、32 项 TS / 工作者 / SQLite 测试、37 项 Python 离线测试，以及 Electron 正式设置、36 项来源筛选、8 类订阅入口、来源开关、主题、最小窗口与原有单实例／取消边界。在线成功样本包括 DMM、r18.dev、FANBOX、AVBase、一本道、amane 的 S1、SubscribeStar、Kemono；JavDB 成功流程用离线夹具核对，当前实际出口返回地区限制。

新的 arm64 `.app` 已生成。搬移后的打包副本通过来源配置、AVBase / amane 同一作品归组、AVBase 与一本道封面、SubscribeStar / Kemono 实际关注与 56 条更新、去重、已读、完整退出重启、单实例，以及启动故障展示与重试。解释器确认来自搬移后的包，报告在 `.test-output/packaged-sources/verification.json`。一次一本道查询未取得记录，包内工作者独立重试和完整桌面复测均成功，未复现稳定故障。既有 FANBOX 与 DMM / r18.dev 验收保留在其他报告中；JavDB 地区限制仍为待解决项。

默认 `test:desktop` 使用独立临时用户目录，检查正式设置、来源约束、四页演示、空查询入口、单实例和窗口生命周期，不发站点请求。真实联调需显式启用：

```sh
npm run test:desktop -- --live
npm run test:desktop -- --follow-live
node --import tsx scripts/probe-metadata.mjs all SSIS-057 --covers
node --import tsx scripts/probe-follow.mjs fanbox ffxivinitiala --check
```

这些脚本使用有界请求和临时数据，报告只保留字段覆盖与状态，不打印实际标题或响应正文。报告位于 `.test-output/`，不随 App 打包。真实联调包含实际来源访问，应避免无意义重复运行。

打包副本可在搬移后的目录验证：

```sh
npm run test:desktop -- .test-output/relocated-subscriptions/Nectisse.app --failure --live --follow-live
NECTISSE_TEST_PROXY=http://127.0.0.1:7890 npm run test:desktop -- --sources-live
```

`--failure` 仅允许在 `.test-output` 内的副本临时隐藏工作者，检查失败与重试后还原。测试缩小 PATH，工作者环境为空，并核对解释器来自搬移后的 App。这不能代替无开发环境设备与正式签名包的最终验收。

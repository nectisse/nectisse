# Nectisse 模块结构

渲染层由 Zustand 接收主进程持续推送的领域快照，TanStack Query 管理按需读取与部分命令的异步状态。主进程负责持久化、网络任务、取消和 Python 生命周期。页面不直接访问文件、数据库或站点。

## 目录与职责

采用轻量的 feature-based 结构：按用户功能聚合页面与样式，跨功能复用的业务展示放入 `entities`，通用控件与桌面通信放入渲染层 `shared`。不强制每个功能建立空的 `api`、`model` 或 `hooks` 目录。

```text
src/
├── main/
│   ├── index.ts               # 应用组装、窗口、IPC 与退出清理
│   ├── features/
│   │   ├── metadata/          # 资料采集与封面选择
│   │   ├── library/           # 作品收藏
│   │   ├── subscriptions/     # 设置存储、关注、更新与调度
│   │   └── magnets/           # 作品详情内的磁链搜索
│   └── platform/
│       ├── python/            # 运行时、任务宿主与浏览器会话
│       ├── network/           # 代理、站点限流与传输策略
│       ├── diagnostics/       # 本机诊断
│       └── lifecycle/         # 可重试初始化
├── preload/                   # 受限 DesktopBridge 与 IPC 校验
├── shared/                    # 跨进程协议、类型与纯策略（@shared/）
└── renderer/
    ├── index.html
    ├── main.tsx
    ├── app/                   # 应用入口、导航、跨功能组合与全局样式
    ├── features/
    │   ├── work-query/        # 资料查询、来源选择与查询记录
    │   ├── library/           # 收藏列表、照片墙与收藏按钮
    │   ├── subscriptions/     # 关注弹窗、演员与创作者主页
    │   ├── updates/           # 更新流筛选与分页
    │   └── settings/          # 来源、订阅、网络、外观与诊断设置
    ├── entities/
    │   ├── work/              # 共用作品详情、封面、人物、来源差异与磁链展示
    │   ├── subscription/      # 身份头像与检查任务反馈
    │   └── update/            # 更新条目、列表与详情弹窗
    ├── shared/
    │   ├── ui/                # shadcn 基础控件
    │   ├── components/        # 无业务依赖的空状态、页头、工具栏与状态控件
    │   ├── lib/               # 日期和样式工具
    │   └── desktop/           # IPC 适配、Zustand、Query 与公开 hooks
    └── demo/                  # 可选视觉演示与样本资源
```

- `@/` 直接定位 `src/renderer/`，不再嵌套第二个 `src`。渲染层的 `shared` 是界面基础设施；根目录 `src/shared` 是跨进程契约，两者职责不同。
- 应用层通过公开入口组合功能。查询页接收 `renderSaveAction` 插槽，由应用层注入收藏按钮；查询与收藏功能互不导入。作品详情接收回调和操作插槽，不依赖功能页面。
- 功能可依赖实体和共享层，实体可依赖其他实体及共享层。功能之间不直接导入；相同层发生共享需求时先提炼实体或在应用层组合，不建立转发整个内部实现的总入口。
- 每个功能、实体及主进程模块通过明确的 `index.ts` 导出对外能力。模块内部使用相对路径，外部不穿透 `ui`、`model` 等实现目录。
- 主进程业务功能使用平台能力，平台不依赖业务服务。站点闸门只接受 `source` / `saveSource` 存储接口，由入口传入现有订阅存储，避免平台反向依赖整个订阅模块。
- 桌面数据层保留统一连接与唯一数据所有者。功能分组不意味着给每个页面复制 store、QueryClient 或 IPC 监听。

Python 连接器保留 `python/src/nectisse_worker/` 与 `python/vendor/` 的既有布局，避免破坏 Peach / amane 的导入和许可登记。脚本留在 `scripts/`，TS 与 Python 测试分别留在 `tests/`、`python/tests/`。

## 样式归属

功能样式与功能页面放在一起；封面、人物、来源差异、动态条目与详情弹窗的样式归入对应实体；设置样式从订阅样式中拆出。`app/styles/index.css` 按原有层叠顺序统一导入，避免目录整理改变样式优先级。

`app/styles/foundation.css` 暂时保留共享视觉基础和早期演示样式，`workspace.css` 管理应用壳的页面约束。这轮不重写选择器和视觉规格；后续若继续拆基础样式，仍须验证双主题和不同窗口尺寸。

shadcn 的 `components.json` 已指向 `shared/ui`、`shared/lib/utils` 和新的样式入口，后续生成控件不会重新创建旧目录。

## 路径别名

别名统一定义在 `tsconfig.paths.json`，根、Node、Web 的 tsconfig 均继承此配置；Electron 的 main / preload / renderer 构建和依赖检查也读取同一份映射。

这份文件同时被构建工具导入和脚本用 `JSON.parse` 读取，必须保持严格 JSON，不能加入注释或尾逗号。其他 tsconfig 可以使用 TypeScript 支持的 JSONC。

- `@/` → `src/renderer/`，例如 `@/shared/desktop`、`@/entities/work`。
- `@shared/` → `src/shared/`，例如 `@shared/preferences`。
- 同目录模块保留 `./`；渲染层跨目录模块使用 `@/`。主进程、preload、测试和脚本引用共享协议统一使用 `@shared/`。
- 未打包的 TS 脚本继续通过 `node --import tsx` 运行，使运行时与编辑器使用相同映射。别名只改变寻址方式，依赖检查仍按解析后的实际文件限制跨层引用。

## 状态流

```text
页面 → useDesktopActions → DesktopBridge → 主进程的存储与任务模块
页面 ← 领域 selector ← Zustand ← 一次连接的 IPC 状态推送
页面 ← useQuery / useMutation ← 按需 IPC → 主进程
```

- `DesktopProvider` 只注入稳定的 store 实例；实时状态由 Zustand selector 订阅，Context 不再广播完整业务快照。
- 订阅、资料、收藏和运行环境各有独立 store。`usePreferences` 从订阅协议快照投影设置，不再保存第二份设置对象。
- `createDesktopState(bridge)` 接受通信依赖。创建 store 不触发 IPC；根入口显式连接和释放，同一实例的多个使用者共享连接，兼容 StrictMode 重挂载。
- 仅应用入口读取 `window.nectisse`。页面通过稳定的 actions 发起明确操作，不单独注册领域数据监听。
- 对完整 JSON 快照做结构共享，保留未变化的分支引用。过期 revision、释放后的读取与迟到失败不能覆盖较新的状态推送。
- 保留订阅读取的有限重试、超时、恢复入口和诊断。资料、收藏与运行环境的读取也有超时和释放处理。
- 输入草稿、当前页局部弹窗和展开状态留在组件中；应用导航由应用壳统一管理。

## Zustand 与 TanStack Query 的职责

| 数据或操作 | 所有者 | 页面入口 |
| --- | --- | --- |
| 设置、订阅身份、更新与已读状态、任务进度、收藏摘要、运行环境 | 主进程持久化，Zustand 保存已校验的推送快照 | `useSubscriptions`、`usePreferences`、`useLibrary`、`useMetadata`、`useRuntime` |
| 按作品 ID 读取的完整收藏详情 | TanStack Query 内存缓存 | `useSavedWork` |
| 打开弹窗后读取的诊断报告 | TanStack Query 内存缓存 | `useDiagnosticsReport` |
| 保存／更新／删除收藏、复制诊断、详情内的磁链搜索 | TanStack mutation 管理等待、错误和结果，主进程执行命令 | `useSaveWork`、`useRemoveWork`、`useCopyDiagnostics`、`useMagnetSearch` |
| 资料采集、关注、订阅检查及取消 | 主进程任务系统；Zustand 接收进度与终态 | `useDesktopActions` 与领域 selector |
| 表单、筛选、页码、当前弹窗和选中作品 | React 局部状态与应用壳 | 页面内部 |

`context.tsx` 为每个工作区创建一份 `DesktopState` 和 `QueryClient`。`react.tsx` 提供 Zustand selector，`query-react.ts` 提供按需读取与 mutation hooks，`magnet-search.ts` 管理详情 Tab 的搜索和取消。页面只从 `shared/desktop/index.ts` 导入，不直接创建 QueryClient 或注册数据监听。

- Query 只缓存完整收藏详情与诊断报告，不复制 Zustand 中的收藏列表、任务、订阅和设置。Query 与 Zustand 均不额外落盘；现有 SQLite、JSON 和图片文件继续作为本机持久化数据。
- 收藏详情按 ID 去重，在五分钟无使用后回收；未改动的详情可复用。现有单次 library IPC 连接收到新快照后，按作品身份和摘要内容使相关详情失效。排序及无关作品变化不重新读取当前详情。
- 明确保存成功也会使对应详情失效，覆盖完整资料改变但摘要没有变化的情况。删除成功会取消旧读取并将对应详情置为空；重新收藏同一身份时等待新读取，避免缓存中的空记录提前结束详情页。
- 诊断只在弹窗打开时读取，每次重新打开和手动刷新取得新报告。关闭弹窗会取消等待；刷新与复制响应交错时，保留生成时间较新的报告。
- 查询与 mutation 均不自动重试；Query 不因窗口聚焦或网络重连而刷新。本机 IPC 使用 `networkMode: 'always'`，断网仍可读取已收藏资料。站点超时、重试和冷却继续由主进程控制。
- `local-read.ts` 为只读 IPC 提供五秒等待上限。取消会停止等待并丢弃迟到响应，SQLite 调用本身仍由主进程完成。失败后的“重新检查”先恢复原服务，再明确重新读取详情。
- 磁链搜索采用 mutation，在进入详情 Tab 时启动，按钮明确刷新；不会因 Query 缓存失效、焦点或网络恢复自动重派。离开 Tab 及点击取消仍调用原来的主进程取消接口，持久化取消终态。磁链结果缓存和预算继续由 `magnet-service.ts` 管理。

依赖固定为 `@tanstack/react-query` 5.104.5。默认行为与取消语义参考 [官方默认值说明](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) 和 [取消说明](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)。

## 持久化与命令

- SQLite、资料缓存和图片文件的所有权仍在主进程；Zustand 不使用 `persist` 另建业务数据副本。
- `preferences-patch` 只携带明确修改的字段，主进程读取最新设置后合并、校验并保存。
- 磁链设置按子字段合并，来源传输按站点合并；来源开关使用 `source-enabled` 命令在主进程计算，避免页面提交过期的整个列表。
- 数组字段（资料顺序、封面顺序、查询勾选）表示完整的用户选择；空数组按各字段协议处理，查询来源全不选会保留。
- 旧完整 `preferences` 命令保留给既有集成，保持完整替换语义；正式设置页和主题按钮使用局部更新。
- 状态读取、store 重建和页面切换不会自动重新派发采集任务。任务取消仍通过主进程停止请求和工作者，并保存终态。

## 主进程与 Python

`src/main/index.ts` 是应用组装入口：建立单实例窗口、注册受信任 IPC 与图片协议，连接领域服务，并协调退出清理。业务规则放在服务和共享策略中。

| 模块 | 责任 |
| --- | --- |
| `subscription-store.ts` | SQLite 设置、关注身份、更新、凭据密文及订阅任务记录 |
| `subscriptions-service.ts` | 订阅命令入口、设置与关注操作、状态快照和事件发布 |
| `subscription-scheduler.ts` | 自动检查、唯一活动任务、请求许可、取消与退出清理 |
| `follow-runner.ts` | 身份查询、增量检查、来源校验、检查结果与头像绑定 |
| `image-backfill.ts` | 最近已收录动态的封面批次、URL 去重、进度与有限重试 |
| `image-cache.ts` | 图片取得、缓存读取、哈希校验、临时文件清理和容量淘汰 |
| `metadata-service.ts` | 查询计划执行、来源记录、封面选择与临时缓存 |
| `library-service.ts` | 收藏快照、列表摘要和长期保留的封面 |
| `magnet-service.ts` | 作品详情内的搜索、结果缓存和取消 |
| `site-gate.ts`、`source-policy.ts` | 站点级派发、冷却与传输策略 |
| `runtime.ts`、`python-host.ts` | 随包运行时检查、任务工作者和子进程回收 |
| `browser-session-host.ts` | FC2PPV-DB 串行浏览器会话与请求许可 |
| `initialization-step.ts`、`subscription-read.ts` | 可重试初始化、有限状态读取与故障归类 |

主窗口先显示，再准备本机服务和 Python 环境。关闭窗口保留应用；再次激活只唤回窗口。退出时停止任务与服务，再回收本应用拥有的工作者和浏览器进程组。

TS 与 Python 使用带版本和任务 id 的标准输入输出消息。普通任务使用独立工作者；FC2PPV-DB 通过单独的会话工作者复用实际 Chrome / Edge 与独立 profile。`worker-contracts.ts` 保存运行选项，`python-errors.ts` 保存公共错误，避免普通任务宿主和浏览器宿主互相引用。

站点网络与解析留在 Python，调度、取消、落盘和界面状态留在 TS。来源登记以 `python/src/nectisse_worker/source_catalog.json` 为准，TS 与 Python 共同读取；`scripts/write-source-matrix.mjs` 从该文件生成文档。

### 订阅模块内部

对外继续使用 `SubscriptionsService` 和既有 IPC。内部依赖方向为入口 → 调度 → 内容执行／封面补齐 → 图片缓存；执行模块可以读写现有 `SubscriptionStore`，不反向引用入口或调度实现。`task-context.ts` 保存执行约定和 Python 结果校验，避免类型循环。

- 调度模块独占活动任务、AbortController、定时器和命令计数。内容执行与封面补齐接收同一任务上下文，通过它检查任务是否有效、报告进度和申请请求许可，不另建工作循环或并发任务槽。
- 查询与检查最多使用 24 次请求，头像获取计入同一预算。动态封面使用独立的有限批次，范围仍是最近已收录的 500 条，不因图片补齐额外请求动态或历史页面。
- 头像与封面共用图片取得、临时文件和容量管理。图片由原 Python `follow.image` 获取，继续采用来源传输设置；TS 校验长度与哈希后才允许绑定。头像查询沿用已有文件存在检查，封面复用和对外图片读取验证哈希。
- 显式取消先保存 `cancelRequestedAt` 和整批取消状态，再中止工作者；迟到结果不能绑定。前台让位和订阅暂停保留中断原因，不写入用户取消意图，未完成图片退回队列且不耗重试预算。
- 退出先停止派发、等待当前执行与临时文件清理，再由应用入口关闭数据库。普通封面中断允许后续重新排队，显式取消和容量淘汰不会自动恢复。
- `SubscriptionStore` 中已有的重启恢复逻辑保留原位置与数据格式。图片补齐仅接收残留 loading 状态的恢复，不另建持久化队列。

依赖规则禁止图片缓存导入执行或调度模块、执行模块导入调度或入口、调度导入入口。回归仍从订阅公开行为验证取消、让位、恢复及缓存，避免只测试文件拆分后的内部方法。

## 本机数据位置

所有可写数据均相对于 Electron 的 `userData`，不写入 `.app`。

| 路径 | 内容 |
| --- | --- |
| `nectisse.sqlite` | 设置、订阅、更新、已读状态与加密凭据 |
| `metadata/state.json` | 查询记录、来源资料、图片索引与查询冷却 |
| `cache/covers/` | 普通查询封面缓存 |
| `cache/subscription-covers/` | 更新封面与人物头像缓存 |
| `library/library.sqlite`、`library/covers/` | 收藏快照与长期保留的封面 |
| `magnet-search/state.json` | 有上限的搜索结果与冷却 |
| `browser-sessions/fc2ppvdb/` | 独立的浏览器验证会话 |
| `diagnostics/subscription-read.jsonl` | 有上限、经过筛选的诊断事件 |

## 自动约束与验证

执行 `npm run check`，依次检查模块依赖、类型和 TS 测试；`npm run build` 同样先执行依赖和类型检查。

`.dependency-cruiser.cjs` 禁止循环与无法解析的依赖、渲染层访问 Node / 主进程、共享协议依赖平台、共享层反向依赖业务、实体依赖功能、功能互引、外部访问模块私有文件、平台反向依赖业务，以及正式功能依赖演示。

Zustand 和 TanStack Query 的直接依赖限定在 `src/renderer/shared/desktop/`。`npm run test:queries` 用隔离 Electron 配置验证缓存复用、失效、迟到响应、显式恢复和诊断弹窗生命周期。

当前 TypeScript 7 不在 dependency-cruiser 18 的默认解析器支持范围内，因此使用其支持的 SWC 解析器；SWC 仅为开发依赖。检查脚本核对全部 TS / TSX 文件的扫描覆盖，扫描遗漏也会失败。正向夹具验证合法的应用组合与公开入口，负向夹具验证真实的跨层导入和类型依赖确实被规则拦截。

回归测试使用隔离应用目录，不读取或修改正式用户的收藏、订阅和 Cookie。重点覆盖设置并发保存、来源选择、一次连接、版本竞争、超时恢复、冷启动、取消、收藏和更新分页。

## 后续整理边界

- 订阅入口中的设置与关注命令仍集中处理；后续如需继续拆分，优先按明确的业务操作提取，保留单一任务协调点及现有数据格式。
- `app/styles/foundation.css` 仍保留部分早期共用和演示样式。后续整理应按选择器使用方归属拆分，保持层叠顺序并验证布局，不为目录形式提前拆细。
- 增加数据读取时先确定唯一所有者：持续推送数据进入现有快照，按需读取进入 Query，采集任务保持明确派发与取消。新增 Query 不能另存完整订阅或任务列表。

## 项目资料

- [来源支持矩阵](docs/SOURCE_SUPPORT.md)：站点能力、连接方式与验证边界，由来源目录生成。
- [第三方组件说明](docs/THIRD_PARTY_NOTICES.md)：上游代码、运行时和依赖的许可证说明，随应用打包。

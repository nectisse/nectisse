# Nectisse 模块结构

渲染层用 Zustand 管理内存快照，主进程负责持久化、网络任务、取消和 Python 生命周期。页面不直接访问文件、数据库或站点。TanStack Query 留到下一阶段评估。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `src/shared/` | Zod 协议、数据类型、来源身份与纯策略；不依赖 Electron、Node 或界面 |
| `src/main/` | 本机存储、任务调度、网络预算、Python 与浏览器进程管理 |
| `src/preload/` | 受限的 DesktopBridge、IPC 校验与事件注销 |
| `src/renderer/src/app/` | 应用壳、导航、全局弹窗入口与快捷键 |
| `src/renderer/src/state/` | 四个领域 store、共享状态读取、IPC 连接与稳定操作接口 |
| `src/renderer/src/metadata/` | 查询表单、来源选择、查询记录和结果列表 |
| `src/renderer/src/works/` | 查询与收藏共用的作品详情、封面、人物、来源差异和磁链展示 |
| `src/renderer/src/library/` | 本机收藏列表、封面墙及收藏操作 |
| `src/renderer/src/subscriptions/` | 添加关注、演员与创作者主页及检查任务反馈 |
| `src/renderer/src/updates/` | 更新流、条目详情及主页共用的条目列表 |
| `src/renderer/src/settings/` | 设置页、来源配置、优先级与诊断弹窗 |
| `src/renderer/src/components/` | 正式通用控件与布局，底层沿用 shadcn |
| `src/renderer/src/prototype/` | 可选视觉演示；从应用壳进入，复用正式控件 |
| `python/src/nectisse_worker/` | 站点适配、资料与图片解析，以及标准连接、网络指纹和浏览器传输 |
| `python/vendor/` | Peach / amane 提取代码、上游版本、文件哈希与许可登记 |
| `scripts/` | Python 准备、打包、来源矩阵生成、在线探测与隔离桌面回归 |
| `tests/`、`python/tests/` | TS 领域与进程测试、Python 连接器与传输测试 |

`WorkDetail` 通过回调和操作插槽接受查询、收藏行为，避免为了共享详情而导入整个查询页。通用控件也不再从演示模块导出给正式页面。

## 路径别名

别名统一定义在 `tsconfig.paths.json`，根、Node、Web 的 tsconfig 均继承此配置；Electron 的 main / preload / renderer 构建和依赖检查也读取同一份映射。

这份文件同时被构建工具导入和脚本用 `JSON.parse` 读取，必须保持严格 JSON，不能加入注释或尾逗号。其他 tsconfig 可以使用 TypeScript 支持的 JSONC。

- `@/` → `src/renderer/src/`，例如 `@/state`、`@/works/WorkDetail`。
- `@shared/` → `src/shared/`，例如 `@shared/preferences`。
- 同目录模块保留 `./`；渲染层跨目录模块使用 `@/`。主进程、preload、测试和脚本引用共享协议统一使用 `@shared/`。
- 未打包的 TS 脚本继续通过 `node --import tsx` 运行，使运行时与编辑器使用相同映射。别名只改变寻址方式，依赖检查仍按解析后的实际文件限制跨层引用。

## 状态流

```text
页面 → useDesktopActions → DesktopBridge → 主进程的存储与任务模块
页面 ← 领域 selector ← Zustand ← 一次连接的 IPC 状态推送
```

- `DesktopProvider` 只注入稳定的 store 实例；实时状态由 Zustand selector 订阅，Context 不再广播完整业务快照。
- 订阅、资料、收藏和运行环境各有独立 store。`usePreferences` 从订阅协议快照投影设置，不再保存第二份设置对象。
- `createDesktopState(bridge)` 接受通信依赖。创建 store 不触发 IPC；根入口显式连接和释放，同一实例的多个使用者共享连接，兼容 StrictMode 重挂载。
- 仅应用入口读取 `window.nectisse`。页面通过稳定的 actions 发起明确操作，不单独注册领域数据监听。
- 对完整 JSON 快照做结构共享，保留未变化的分支引用。过期 revision、释放后的读取与迟到失败不能覆盖较新的状态推送。
- 保留订阅读取的有限重试、超时、恢复入口和诊断。资料、收藏与运行环境的读取也有超时和释放处理。
- 输入草稿、当前页局部弹窗和展开状态留在组件中；应用导航由应用壳统一管理。

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
| `subscriptions-service.ts` | 身份查询、关注、增量检查、自动调度及订阅图片补齐 |
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

`.dependency-cruiser.cjs` 禁止循环与无法解析的依赖、渲染层访问 Node / 主进程、共享协议依赖平台、状态模块依赖页面、通用控件依赖业务、正式页面依赖演示，以及页面互相导入。

当前 TypeScript 7 不在 dependency-cruiser 18 的默认解析器支持范围内，因此使用其支持的 SWC 解析器；SWC 仅为开发依赖。检查脚本核对全部 TS / TSX 文件的扫描覆盖，扫描遗漏也会失败。负向夹具验证真实的跨层导入和类型依赖确实被规则拦截。

回归测试使用隔离应用目录，不读取或修改正式用户的收藏、订阅和 Cookie。重点覆盖设置并发保存、来源选择、一次连接、版本竞争、超时恢复、冷启动、取消、收藏和更新分页。

## 后续整理边界

- `subscriptions-service.ts` 仍同时承担调度和图片缓存。后续可以按任务执行与图片队列拆分，保留取消、落盘和站点冷却的一致性。
- 页面模块已经拆开，但部分正式布局样式仍在 `prototype/styles.css`、`metadata/styles.css` 与 `subscriptions/styles.css` 中共享。拆样式时需保持层叠顺序，并跑双主题、多窗口尺寸的布局回归。
- TanStack Query 接入前先区分主进程推送快照与按需读取结果，避免为相同业务数据同时建立多份缓存。

## 项目资料

- [来源支持矩阵](docs/SOURCE_SUPPORT.md)：站点能力、连接方式与验证边界，由来源目录生成。
- [第三方组件说明](docs/THIRD_PARTY_NOTICES.md)：上游代码、运行时和依赖的许可证说明，随应用打包。

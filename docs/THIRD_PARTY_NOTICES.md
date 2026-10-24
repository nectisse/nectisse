# 第三方组件说明

## Peach

本项目包含 Peach 0.46.1 本地快照中的传输、编号规则、直接资料连接器、三个 Seesaa Wiki 与 K-MIB 解析，资料身份与跨作品封面判断片段，以及 FANBOX 正文、Patreon / SubscribeStar 公开卡片、JavDB 演员卡与目录解析。归档站与 Rule34Video 列表按照该快照适配，仅收集发布资料及封面。另包含 FC2PPV-DB 浏览器验证与会话复用所需的 Peach 浏览器传输片段，以及 Sukebei 表格查询适配中复用的编号规则。项目：<https://github.com/peach-mitao/peach>。

来源、格式化变化、适配修改与 SHA-256 见 `python/vendor/UPSTREAM.md`、`metadata-extraction.json`、`follow-extraction.json` 和 `browser-extraction.json`；AGPL-3.0-or-later 许可证全文见 `python/vendor/PEACH-LICENSE`。打包应用中对应文件位于 `Contents/Resources/python/app/vendor/`。进程边界不改变上游许可证义务；正式分发前应随交付提供适用许可证要求的对应源码和构建说明。

## Python 和网络依赖

Python 运行时由 uv 获取 python-build-standalone 的 CPython 3.14.9 发行物，随应用携带，不在用户启动时下载。运行时及其捆绑组件的许可证保留在 `Contents/Resources/python/runtime/`。

Python 依赖版本与完整性哈希锁定在 `python/requirements.lock`；包含 HTTPX、httpcore、curl_cffi、cffi、certifi、socksio、Beautiful Soup、Pillow 等。其 wheel 自带的许可证及元数据保留在 `Contents/Resources/python/dependencies/`，不裁剪 `.dist-info`。

## Electron 和界面依赖

Electron、React、Zustand、Tailwind CSS、shadcn/ui 组件及其他 JavaScript 依赖的固定版本见 `package.json` 与 `package-lock.json`。各依赖的许可证声明随安装包元数据保留；Electron 自带许可证位于 `.app/Contents/` 下。当前产物仅用于本机开发验证，尚未进行正式发布的签名、公证和完整分发材料整理。

## amane

包含 amane 0.20.0 固定 revision `cc42cee6ecf290cf05af1caa347d2dc2d5aeffcd` 中 Peach 实际开放的九个资料来源爬虫与纯模型依赖。项目：<https://github.com/sqzw-x/amane>，GPL-3.0。完整许可证保留于 `python/vendor/amane/LICENSE`；提取清单、快照与逐文件哈希见 `python/vendor/amane-extraction.json`。包入口替换为无服务、数据库与全站注册副作用的入口，爬虫文件保持原实现；运行时注入 Nectisse 的有界客户端。构建可通过 `scripts/extract-amane.mjs` 重现。

新增 parsel、lxml、pydantic、structlog 及其依赖均由 `python/requirements.lock` 固定版本和完整性哈希；各 wheel 的许可证与元数据一同打包。

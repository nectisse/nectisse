# 应用图标

正式图标资源统一保存在此目录。运行和打包不依赖设计稿目录。

- `icon.png`：已确认的 D「双瓣负形」原图，1024 × 1024，白底，紫色与蜜桃色双瓣围出白色蜜滴；主体在画布中央对齐，作为唯一编辑源。
- `icon-macos.png`：由原图生成，保留原图底色，增加 macOS 圆角、上沿高光、底部暗边、外侧透明留白和轻微底影，供开发和打包后的 Dock、窗口使用。
- `icon.icns`：同一 macOS 图标的 16–1024 px 多尺寸版本，供 `.app` 的 Finder、Dock 和系统应用图标使用。

替换 `icon.png` 后，在 macOS 执行 `npm run icons:build`，重新生成另外两个文件。此命令复用项目随包 Python 和 Pillow，无需额外安装图像工具。`npm run package:mac` 会自动先生成图标，再构建应用。

三个图像文件均需随源码保存，以便开发启动时直接使用。生成脚本位于 `scripts/build-icons.mjs` 与 `scripts/build-icons.py`。

当前原图采用 `previews/white-redesign-v1/d-negative.png`。历史预览保留用于比较，生成脚本只读取此目录下的 `icon.png`；底板高光由脚本绘制，不会重复叠加到源图。

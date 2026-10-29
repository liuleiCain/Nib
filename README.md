# Nib · 笔尖

一个以基础代码编辑和 Git 可视化为方向的轻量桌面编辑器。使用 Tauri 2、Rust、React、TypeScript、Vite 与 CodeMirror 6。

当前完成范围为**阶段一：可运行的编辑器骨架**。文件数据来自本地磁盘，没有演示文件或静态项目数据。Git 功能从阶段二开始实现。

## 环境要求

- Node.js 22.12+（推荐当前 LTS）或 24+；使用 Node 自带的 npm。
- Rust stable，通过 [rustup](https://rustup.rs/) 安装；确保 `cargo` 位于 `PATH`。
- macOS：Xcode Command Line Tools（`xcode-select --install`）。
- Windows：MSVC Rust 工具链、Visual Studio C++ Build Tools、WebView2。
- Linux：Tauri 2 所需 WebKitGTK 4.1 及系统依赖。参见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。
- 后续 Git 功能依赖本机 Git CLI 并沿用本机凭据配置。阶段一不调用 Git，非仓库文件夹也可使用。

## 安装与启动

```sh
npm ci
npm run desktop
```

如果刚安装 Rust 且当前终端尚未更新 `PATH`，先运行：

```sh
source "$HOME/.cargo/env"
```

`npm run desktop` 会启动 Vite 并打开原生 Tauri 窗口。点击「打开文件夹」，展开文件树，选择真实文本文件开始编辑。

```sh
npm run dev             # 仅浏览器预览；不具备本地项目访问能力
npm run typecheck       # TypeScript 检查
npm run format:check    # 前端、配置与文档格式检查
npm run build           # 前端类型检查与生产构建
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run desktop:build -- --bundles app   # macOS .app
npm run desktop:build                    # macOS .app 和 .dmg
```

macOS 产物位于 `src-tauri/target/release/bundle/`。本地构建默认没有开发者签名或公证；正式分发需另行配置。Windows、Linux 应在对应系统安装依赖后执行 `npm run desktop:build -- --bundles nsis` 或 `-- --bundles deb`；默认打包目标为 macOS，不能将本机验证视为跨平台验证。

## 阶段一功能

- 原生目录选择，可同时打开多个项目。macOS 上所有项目在同一个窗口内，以窗口顶部的原生标签切换（可拖出为独立窗口，或用“窗口 → 合并所有窗口”合并回来）；Windows/Linux 每个项目一个独立窗口。同一项目只打开一次，重复打开时切换到已有标签。
- 最近项目（最多 20 个）：欢迎页和工具栏项目菜单展示，可移除记录；目录已不存在时标记且不可打开。
- 启动时恢复上次退出时打开的所有项目，以及各项目上次打开的标签和当前标签（从磁盘重新读取，不含未保存内容）。记录保存在 `~/.nib/session.json`，退出 Nib 后删除 `~/.nib` 即可清空。
- 按展开层级加载文件树，目录优先排序；支持调整侧边栏宽度。
- 实时刷新：监听整个项目目录（忽略 `.git`、`node_modules`、`target`），外部程序或 AI 写入文件后约 0.2 秒内同步到文件树和已打开的标签。没有未保存编辑的标签就地更新内容，保留光标与滚动位置，外部写入不进入撤销历史；有未保存编辑且磁盘也被修改时标记冲突（标签圆点变橙色），暂停该文件自动保存，可从命令面板重新加载磁盘版本。
- 自动保存（默认开启，可在显示设置或命令面板关闭）：停止输入 1 秒、切换标签、窗口失去焦点时保存。仍按磁盘版本检查冲突，外部修改不会被覆盖；保存失败或冲突的文件暂停自动保存，改为手动保存。开启时关闭标签和退出不再逐个询问，只确认无法自动保存的文件。
- 多标签编辑、保存、全部保存、关闭标签、关闭其他标签；标签切换保留选区、滚动位置和撤销栈。
- 未保存圆点、未保存计数；关闭文件、切换项目和关闭原生窗口时可保存、放弃或返回编辑。
- 撤销、重做、当前文件查找与替换、行号、当前行高亮、括号匹配、缩进。
- Go、Rust、JavaScript/JSX、TypeScript/TSX、JSON、Markdown、YAML 高亮按语言加载。
- 深色主题、当前会话字号调整、自动换行、常用编辑命令面板。
- UTF-8（含 BOM）文本；保存保留 LF、CRLF 或 CR 风格和普通文件权限。
- 保存前检查磁盘 SHA-256 版本；有外部修改时停止保存，允许用户通过命令面板选择重新加载磁盘版本。

## 快捷键

macOS 使用 Command，Windows/Linux 使用 Ctrl。

| 操作               | macOS         | Windows / Linux       |
| ------------------ | ------------- | --------------------- |
| 打开文件夹         | Cmd+O         | Ctrl+O                |
| 新建项目标签       | Cmd+Shift+N   | Ctrl+Shift+N          |
| 切换项目标签       | Ctrl+Tab      | —                     |
| 保存               | Cmd+S         | Ctrl+S                |
| 全部保存           | Cmd+Shift+S   | Ctrl+Shift+S          |
| 关闭当前标签       | Cmd+W         | Ctrl+W                |
| 命令面板           | Cmd+Shift+P   | Ctrl+Shift+P          |
| 当前文件查找、替换 | Cmd+F         | Ctrl+F                |
| 撤销               | Cmd+Z         | Ctrl+Z                |
| 重做               | Cmd+Shift+Z   | Ctrl+Shift+Z / Ctrl+Y |
| 切换侧边栏         | Cmd+B         | Ctrl+B                |
| 增大 / 减小字号    | Cmd++ / Cmd+- | Ctrl++ / Ctrl+-       |
| 恢复默认字号       | Cmd+0         | Ctrl+0                |

自动换行、重新加载文件、关闭其他标签页、最近项目、关闭项目可通过命令面板执行。已有项目时打开文件夹或最近项目会新建项目标签；项目菜单中最近项目右侧的图标在当前标签替换项目。查找面板内展开替换输入。当前尚未提供 Cmd/Ctrl+P 快速打开和项目搜索。

## 架构与限制

详见 [架构说明](docs/architecture.md)、[阶段与已知限制](docs/roadmap.md) 和 [验证记录](docs/verification.md)。

本版本尚无异常退出恢复机制，请经常保存文件。自动保存可大幅缩短未保存窗口，但强制结束进程、系统崩溃或开发环境热重载仍可能丢失最近 1 秒内的编辑。设置持久化与未保存内容恢复在后续阶段实现，自动保存开关当前只在本次运行生效。

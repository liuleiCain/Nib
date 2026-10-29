# Nib · 笔尖

一个以基础代码编辑和 Git 可视化为方向的轻量桌面编辑器。使用 Tauri 2、Rust、React、TypeScript、Vite 与 CodeMirror 6。

当前完成范围为**阶段一：可运行的编辑器骨架**。文件数据来自本地磁盘，没有演示文件或静态项目数据。Git 功能从阶段二开始实现。

## 环境要求

- Node.js 22.12+（推荐当前 LTS）或 24+；pnpm 11。
- Rust stable，通过 [rustup](https://rustup.rs/) 安装；确保 `cargo` 位于 `PATH`。
- macOS：Xcode Command Line Tools（`xcode-select --install`）。
- Windows：MSVC Rust 工具链、Visual Studio C++ Build Tools、WebView2。
- Linux：Tauri 2 所需 WebKitGTK 4.1 及系统依赖。参见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。
- 后续 Git 功能依赖本机 Git CLI 并沿用本机凭据配置。阶段一不调用 Git，非仓库文件夹也可使用。

## 安装与启动

```sh
pnpm install --frozen-lockfile
pnpm desktop
```

如果刚安装 Rust 且当前终端尚未更新 `PATH`，先运行：

```sh
source "$HOME/.cargo/env"
```

`pnpm desktop` 会启动 Vite 并打开原生 Tauri 窗口。点击「打开文件夹」，展开文件树，选择真实文本文件开始编辑。

```sh
pnpm dev             # 仅浏览器预览；不具备本地项目访问能力
pnpm typecheck       # TypeScript 检查
pnpm format:check    # 前端、配置与文档格式检查
pnpm build           # 前端类型检查与生产构建
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm desktop:build --bundles app       # macOS .app
pnpm desktop:build                    # macOS .app 和 .dmg
```

macOS 产物位于 `src-tauri/target/release/bundle/`。本地构建默认没有开发者签名或公证；正式分发需另行配置。Windows、Linux 应在对应系统安装依赖后执行 `pnpm desktop:build --bundles nsis` 或 `--bundles deb`；默认打包目标为 macOS，不能将本机验证视为跨平台验证。

## 阶段一功能

- 原生目录选择，一个窗口管理一个项目。
- 按展开层级加载文件树，目录优先排序，手动刷新已展开目录；支持调整侧边栏宽度。
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

自动换行、重新加载文件、关闭其他标签页可通过命令面板执行。查找面板内展开替换输入。当前尚未提供 Cmd/Ctrl+P 快速打开和项目搜索。

## 架构与限制

详见 [架构说明](docs/architecture.md)、[阶段与已知限制](docs/roadmap.md) 和 [验证记录](docs/verification.md)。

本版本尚无异常退出恢复机制，请经常保存文件。正常关闭有未保存提示；强制结束进程、系统崩溃或开发环境热重载可能丢失未保存内容。文件监听、最近项目、配置持久化与会话恢复在后续阶段实现。

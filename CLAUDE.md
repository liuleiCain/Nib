# Nib 开发交接说明

更新时间：2026-11-02。本文供 Claude 在现有源码上继续开发，区分已实现、已验证和待完成事项。接手时先检查实际文件与工作区差异，后续开发同步更新本文和相关文档。

## 1. 产品与本次交接目标

Nib（笔尖）是一款轻量的**桌面代码编辑器**，核心是基础编辑和 Git 可视化。用户明确要求桌面应用；使用 Tauri 2 原生窗口与系统 WebView 承载界面，Rust 提供本地能力。优先 macOS，保持 Windows/Linux 架构兼容。

当前已完成阶段一编辑器骨架、阶段二 Git 核心闭环（GoLand 默认的勾选提交模式），以及阶段三（提交记录、分支、Fetch/Push/仅快进 Pull、应用户要求加入的合并与变基，快速打开、项目搜索、设置、窗口与侧边栏尺寸、未保存内容恢复）；下一步为阶段四。请在现有实现上继续，不要重新初始化或替换技术栈。真实中文输入法组合输入、Git 与阶段三界面的真实窗口交互、崩溃后的恢复流程仍待人工验收。

- 技术栈：Tauri 2、Rust、React、TypeScript、Vite、CodeMirror 6、Lucide、npm。
- React 管理界面、编辑器和交互状态，Rust 管理本地文件、未来的 Git/搜索/监听/配置。
- 目前没有状态管理库、数据库、完整组件库、项目索引或插件系统；按需求添加依赖（长列表虚拟化使用 `@tanstack/react-virtual`，固定版本）。
- 以克制的深色界面为基础，文件与 Git 将共用侧边栏，编辑与 Diff 使用主内容区。使用系统窗口能力。
- 原始完整需求保存在 [docs/product-spec.md](docs/product-spec.md)，后续范围以用户最新要求和原始需求为准。

## 2. 先读这些文件

1. 本文：项目现状、接续顺序和开发约束。
2. [README.md](README.md)：环境、启动、构建、功能与快捷键。
3. [docs/product-spec.md](docs/product-spec.md)：原始产品大纲和验收标准。
4. [docs/architecture.md](docs/architecture.md)：当前模块职责、文件保存策略及边界。
5. [docs/roadmap.md](docs/roadmap.md)：各阶段范围与已知限制。
6. [docs/verification.md](docs/verification.md)：此前实际验证的环境、命令与行为，不能将记录外的场景视为已通过。

若仓库或父目录存在适用的 `AGENTS.md` / `AGENTS.override.md`，先读取并遵守。本文不覆盖用户后续指令。

## 3. 启动与构建

在项目根目录执行：

```sh
npm ci
npm run desktop
```

如果 Rust 尚未进入当前终端 PATH：

```sh
source "$HOME/.cargo/env"
```

`npm run desktop` 运行 Tauri 开发窗口，Vite 仅在开发时提供界面资源。`npm run dev` 是浏览器界面预览，不能完成真实桌面文件功能的验收。打包后的应用直接启动，不需要单独运行 Vite 或网页服务。

```sh
npm run typecheck
npm run format:check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run desktop:build -- --bundles app
```

本机已生成的 macOS 应用位置：`src-tauri/target/release/bundle/macos/Nib.app`。修改代码后需重新构建，已有 `.app` 不会自动更新。默认打包配置为 macOS app/dmg；Windows/Linux 需要在对应系统检查依赖并选择实际打包目标。

此前验证环境：macOS 27.2 arm64、Node 25.7.0、pnpm 11.25.0（阶段一验证时使用，现已改用 npm 11.10.1）、Rust/Cargo 1.99.1、Xcode Command Line Tools。环境要求以 `package.json`、锁文件和平台要求为准。`Cargo.toml` 的 Rust 最低版本声明没有通过最低版本工具链实测。

## 4. 已完成的阶段一功能

### 项目与文件树

- 通过系统目录选择器打开真实本地项目，每个项目一个原生窗口；macOS 上并入同一窗口的原生标签组，顶部标签切换项目；同一项目重复打开时切换到已有标签。
- 最近项目（欢迎页和工具栏项目菜单）；启动时恢复上次打开的项目窗口及各项目标签与展开目录，记录存放在 `~/.nib/session.json`（阶段三提前交付，见 `docs/architecture.md`）。
- 文件树按展开层级加载、目录优先排序、折叠和手动刷新已展开目录。
- 侧边栏显示/隐藏和宽度调整，当前会话生效。
- 切换项目后通过工作区 id 和前端检查拒绝或丢弃旧请求。

### 编辑与交互

- CodeMirror 6 多标签编辑，整个窗口复用一个 `EditorView`。
- 每个标签保存独立 `EditorState`，切换保留撤销历史、选区与滚动位置，不重复读取磁盘。
- 保存、全部保存、关闭当前/其他标签、未保存圆点及计数。
- 关闭标签、切换项目、关闭窗口和正常退出时处理未保存内容，提供保存、放弃和返回编辑。
- 撤销/重做、当前文件查找/替换、行号、当前行高亮、括号匹配、缩进。
- Go、Rust、JavaScript/JSX、TypeScript/TSX、JSON、Markdown、YAML 高亮按需加载。
- 深色主题、会话内字号和自动换行、基础编辑命令面板、行列/语言/编码/换行状态栏。
- Cmd/Ctrl+O、Shift+N、S、Shift+S、W、B、Shift+P、F 等快捷键；完整列表见 README。

### 文件读写保护

- 支持 UTF-8（含 BOM），编辑器内部使用 LF，保存还原原有 LF/CRLF/CR 风格。
- 保存检查磁盘 SHA-256 版本；外部修改时停止保存并保留编辑内容。
- 在同目录写临时文件、保留普通权限、同步内容、再次检查版本后原子替换。
- 可从命令面板重新加载磁盘版本，丢弃未保存内容前再次确认。
- 拒绝绝对路径和 `..` 越界，解析链接后仍须在项目内；项目内文件链接保存到真实目标。
- 拒绝已知二进制、非 UTF-8、混合换行和超限文件，并给出错误说明。
- 磁盘操作使用 Rust 阻塞线程池，不在窗口事件循环内执行。

## 5. 当前代码入口

| 文件或目录                              | 职责                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `src/app/App.tsx`                       | 工作区、标签、保存流程、确认弹窗、快捷键、命令面板、布局 |
| `src/features/editor/Editor.tsx`        | 单一 CodeMirror 视图、标签状态切换、编辑锁定             |
| `src/features/editor/model.ts`          | 标签状态、语言加载、主题、未保存判定、换行序列化         |
| `src/features/explorer/`                | 文件树层级加载、展开与刷新，右键菜单与名称输入框         |
| `src/features/projects/ProjectMenu.tsx` | 最近项目列表与工具栏项目菜单                             |
| `src/features/git/`                     | 提交面板、提交记录、分支弹窗、推送确认、Diff、变更标记   |
| `src/features/search/`                  | 快速打开、项目搜索面板                                   |
| `src/features/settings/`                | 设置框（编辑器与 Git 显示设置）                          |
| `src/lib/backend.ts`                    | Tauri IPC 类型与命令调用                                 |
| `src/lib/virtual.ts`                    | 长列表虚拟化（只渲染视口附近的行）                       |
| `src/styles/global.css`                 | 主题变量和界面样式                                       |
| `src-tauri/src/lib.rs`                  | Tauri 注册、启动恢复窗口、窗口销毁、退出确认事件         |
| `src-tauri/src/window/mod.rs`           | 项目窗口创建、聚焦与销毁清理                             |
| `src-tauri/src/session/mod.rs`          | 最近项目、打开的项目、各项目标签的持久化                 |
| `src-tauri/src/watcher/mod.rs`          | 项目目录监听、事件合并，并推送给对应窗口                 |
| `src-tauri/src/git/mod.rs`              | Git CLI 调用、状态解析、HEAD 版本读取、勾选提交          |
| `src-tauri/src/git/history.rs`          | 提交记录分页、提交详情与历史 Diff                        |
| `src-tauri/src/git/remote.rs`           | 分支与分支操作、远程仓库管理，Fetch、Push、仅快进 Pull   |
| `src-tauri/src/git/merge.rs`            | 合并、变基，冲突标记已解决、完成/继续、跳过与中止        |
| `src-tauri/src/search/mod.rs`           | 快速打开文件列表、可取消的项目文本搜索                   |
| `src-tauri/src/settings/mod.rs`         | 用户设置的读写与校验；`fonts.rs` 读取系统字体列表        |
| `src-tauri/src/recovery/mod.rs`         | 未保存内容的恢复数据                                     |
| `src-tauri/src/common/mod.rs`           | 跨模块公共能力（数据文件原子写入）                       |
| `src-tauri/src/commands/mod.rs`         | 命令边界、阻塞任务调度                                   |
| `src-tauri/src/workspace/mod.rs`        | 按窗口的工作区注册表、项目根目录、工作区 id、路径校验    |
| `src-tauri/src/filesystem/mod.rs`       | 目录枚举、文本读取、版本检查与安全保存                   |
| `src-tauri/src/error.rs`                | 结构化错误码与中文说明                                   |
| `src-tauri/tauri.conf.json`             | 窗口、构建、打包及 CSP                                   |
| `src-tauri/capabilities/default.json`   | 目录选择与窗口能力权限                                   |

当前自定义命令：`window_startup`、`open_project`、`open_project_window`、`new_window`、`close_project`、`recent_projects`、`forget_project`、`save_tabs`、`save_expanded`、`cancel_quit`、`list_directory`、`read_file`、`save_file`、`git_status`、`git_diff`、`git_head_file`、`git_commit`、`git_restore`、`git_add`、`git_rollback`、`git_ignore`、`git_log`、`git_commit_detail`、`git_commit_diff`、`git_branches`、`git_create_branch`、`git_switch_branch`、`git_checkout_remote`、`git_rename_branch`、`git_delete_branch`、`git_delete_remote_branch`、`git_add_remote`、`git_set_remote_url`、`git_rename_remote`、`git_remove_remote`、`git_fetch`、`git_pull`、`git_push`、`git_outgoing`、`git_merge`、`git_rebase`、`git_resolve`、`git_continue`、`git_skip`、`git_abort`、`create_entry`、`rename_entry`、`trash_entry`、`reveal_entry`、`search_files`、`search_text`、`cancel_search`、`get_settings`、`save_settings`、`system_fonts`、`get_layout`、`save_sidebar_width`、`save_view`、`recovery_save`、`recovery_discard`、`recovery_list`。

## 6. 已执行的验证及边界

此前已通过：前端格式、TypeScript、生产构建、Rust 格式和 Clippy、macOS `.app` 打包。详细命令和结果见 `docs/verification.md`；接手后的更改需要重新执行对应检查。

真实桌面窗口已验证：打开本地文件树；中文文件名及中文文本保存后关闭重开；多标签切换后撤销重做；未保存关闭提示与返回编辑；外部修改导致保存冲突；确认后重新加载磁盘版本。

临时 Rust 程序直接引入项目模块，验证真实文件系统行为：目录排序和隐藏、中文/空格路径、BOM/CRLF、冲突、路径边界、内外链接、权限与只读文件、二进制/编码/混合换行/大小限制、旧工作区请求。临时程序和样本已删除，没有在仓库保留测试文件。

仍未验证：真实中文输入法候选词/组合输入、Windows/Linux、DMG 安装、分发签名公证、启动和总内存指标、长时间使用与复杂并发竞态。中文自动化粘贴不能代替 IME 验收。

## 7. 当前限制与需保留的保护

- 文件树右键：新建、重命名（已跟踪用 `git mv`）、移到废纸篓、复制路径、访达显示，以及回滚、加入版本控制、添加到 `.gitignore`。
- 项目目录实时监听（`src-tauri/src/watcher`），文件树与已打开标签自动刷新；自动保存默认开启，开关只在本次运行生效。冲突时暂停该文件自动保存，尚无对比合并界面；文件被删除时干净标签自动关闭，有未保存编辑的标签保留并提示。
- 用户设置（编辑器字体、字号、缩进、自动换行、自动保存，以及变更列表分组、Diff 视图）保存在 `~/.nib/settings.json`，入口为工具栏右上角齿轮或 Cmd/Ctrl+,；窗口尺寸、侧边栏宽度、侧边栏显示与当前面板保存在 `session.json` 的 `layout`，各项目文件树展开目录与标签一起保存；未保存内容每 1.5 秒内写入 `~/.nib/recovery/`，异常退出后打开项目时提示恢复（见 `docs/architecture.md`）。
- 文件可编辑上限 20 MiB，超过时只读预览开头 5 MiB（不可编辑、不保存）；二进制按开头 8 KiB 是否含 NUL 判断；超过 1,048,576 个 JavaScript 字符时禁用语法解析（这是当前实现阈值，不是精确字节阈值）。
- 最多 30 个打开/正在打开的标签，单目录最多展示 10,000 项；文件树、变更列表、提交记录、搜索结果、实时变更与推送文件列表已虚拟化（`src/lib/virtual.ts`）。
- 文件树隐藏 `.git`、`node_modules`、`target`、`.DS_Store`；这些规则独立于未来搜索的 `.gitignore` 规则。
- 项目外链接不打开，目录符号链接不展开，非 Unicode 文件名会跳过并提示计数。
- 原子保存仅保留普通权限，未保证 ACL、扩展属性、硬链接关系、所有者及断电持久化；最终检查与替换仍存在外部并发竞态。详见架构文档。
- 无终端、LSP、语义补全、重构、调试器；没有用无作用按钮宣称这些功能已完成。

## 8. 阶段二 Git 核心闭环（已实现）

按用户选择采用 GoLand 默认的勾选提交模式，不单独操作暂存区：变更列表合并展示相对 HEAD 的修改，勾选文件后用 `git commit --only` 只提交这些文件，其他文件的暂存状态不变。详细设计见 `docs/architecture.md` 的 Git 一节，已知限制见 `docs/roadmap.md`，验证范围见 `docs/verification.md`。

- 后台 `src-tauri/src/git`：参数数组调用本机 Git、`--literal-pathspecs`、禁止交互、读写超时、输出上限、按仓库串行提交；提交前用登录 shell 的 PATH，保证钩子能找到命令。
- 前端 `src/features/git`：提交面板、左右对比 / 统一 Diff、行号旁变更标记；文件树着色、状态栏分支在 `App.tsx` 和 `Explorer.tsx`。
- 提交前先保存勾选文件的未保存编辑；未勾选文件的未保存编辑会明确提示不会参与提交。

Git 实现约束（后续 Git 功能继续遵守）：

- 使用 Rust 进程 API 和独立参数数组，禁止拼接用户输入到 Shell；路径用 `--` 或 `--pathspec-from-file` 传入。
- 同一仓库的写操作串行，完成后刷新；读取有超时，写超时需要确认结果，不能自动重试。
- 限制状态、日志和 Diff 输出；避免旧项目或旧查询的迟到结果覆盖新状态。
- 仓库读取、搜索等任务不得阻塞界面；避免全项目预扫描和高频轮询。
- 不向前端开放任意 Shell 能力，优先通过受控 Rust 命令实现。
- 合并与变基只在已跟踪文件干净时开始，冲突时保留进行中的状态；拣选、还原等未实现的场景保留状态并明确说明限制。

## 9. 后续待做范围

### 阶段三：日常使用能力

- 已实现 Git 部分：提交记录分页与只读提交 Diff、本地与远程分支列表及 GoLand 式分支操作菜单（切换、从任意分支新建、检出远程分支、重命名、删除本地/远程分支）、远程地址与上游信息、远程仓库管理（添加、修改地址、重命名、删除）、Fetch / Push（推送前确认框列出待推送的提交与文件）/ 仅快进 Pull、合并与变基（冲突在编辑器中解决后标记已解决，可完成/继续、跳过、中止）（设计见 `docs/architecture.md` Git 一节，限制见 `docs/roadmap.md`，真实窗口交互待验收）。
- 已实现：Cmd/Ctrl+P 快速打开（模糊匹配、`路径:行号`）；Cmd/Ctrl+Shift+F 项目搜索（按文件分组、可取消、限制结果数、排除 `.git`、默认尊重 `.gitignore`）；命令面板补充已实现操作；字体、字号、缩进、自动换行、自动保存及 Git 显示设置（`~/.nib/settings.json`，带版本号，经 Rust 读写）；窗口与侧边栏尺寸恢复；未保存内容的本地恢复（`~/.nib/recovery/`，与配置、项目文件分开存储）。设计见 `docs/architecture.md`，限制见 `docs/roadmap.md`，真实窗口交互待验收。

### 阶段四：稳定性和性能

- 外部修改与未保存编辑冲突时的对比/合并界面；大仓库下监听性能测量（监听、事件合并和干净/未保存文件区分处理已提前实现）。
- 后台取消/超时/并发控制，大文件/仓库/Diff 降级（长列表虚拟化已交付）。
- 测量冷启动、已加载标签切换、输入滚动与空闲活动。记录机器和项目规模，不承诺未经测量的内存值。
- 分别测量空窗口、项目、多文件、大 Diff 时应用及 WebView 总内存，排查增长。
- 以冷启动可交互 2 秒内、已加载标签切换 100 毫秒内作为初始优化目标，不能当作已达成指标。
- macOS 打包和实际分发准备，Windows/Linux 对应系统构建验证并如实记录范围。

第一版暂不实现：按行/区块暂存、图形化冲突解决（三方合并视图）、交互式变基、Cherry-pick、Stash、强推、Reset/Clean（文件树回滚已按用户确认实现）、子模块/多工作区专门管理、内置终端、LSP 和调试器。

## 10. 接续开发规范

- 修改前阅读相关代码与调用链，保持目录结构、局部风格和最小改动；只为已明确需求建立模块。
- 核心模块、结构体和公共方法使用简洁准确的中文注释。跨模块公共能力按项目规范放在根目录 `common`，不要为尚不存在的功能提前建抽象。
- 如涉及生成产物，先更改源定义，再通过对应生成流程更新；不要手工补丁生成文件。
- 不新增、修改或保留测试文件、测试数据和测试脚本，除非用户明确要求；确需验证时使用临时目录，完成后清理。
- 每阶段执行与风险匹配的格式、类型、构建及真实行为验证；不要删除或跳过既有检查来掩盖失败。
- 禁止用静态假数据代替宣称完成的功能；未实现功能明确说明，不提供无作用入口。
- 用户未明确要求时，不创建 Git commit，也不要清理或覆盖已有工作区更改。若以后获准提交，使用简体中文 Conventional Commits。
- 常规技术选择自行处理；影响数据安全、产品范围或基础架构的重大调整再向用户确认。

## 11. 可直接给 Claude 的接续任务

> 请先阅读根目录 CLAUDE.md、docs/product-spec.md 和现有源码，遵守适用的 AGENTS.md。Nib 是 Tauri 2 桌面代码编辑器，继续现有项目，保留阶段一编辑能力。先复核桌面启动与已有验证，再按交接说明推进阶段二：仓库与分支识别、已暂存/未暂存/未跟踪状态、统一 Diff、暂存/取消暂存、仅提交暂存区的提交闭环。使用真实 Git CLI 与本地文件，不使用假数据。每步保持可运行，处理错误、取消、输出上限与迟到结果；完成后更新文档并运行验证。不擅自创建 Git commit，不在项目中新增测试文件。重大数据安全、产品范围或基础架构问题再提出确认。

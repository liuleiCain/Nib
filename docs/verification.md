# 阶段一验证记录

验证日期：2026-10-29。范围为 macOS arm64 本机构建与原生窗口；没有据此推断 Windows、Linux 或中文输入法组合输入已通过。

## 环境

| 工具     | 本机版本                  |
| -------- | ------------------------- |
| 系统     | macOS 27.2 / Darwin arm64 |
| Node.js  | 25.7.0                    |
| pnpm     | 11.25.0                   |
| Rust     | 1.99.1 stable             |
| Cargo    | 1.99.1                    |
| 原生依赖 | Xcode Command Line Tools  |

依赖由 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock` 固定。Tauri 前端 API、CLI 与 Rust 依赖均为 2.x，桌面构建通过了 Tauri 包版本兼容性检查。

## 构建与静态检查

以下命令均通过：

```sh
pnpm format:check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm desktop:build --bundles app
```

`pnpm build` 包含 TypeScript 类型检查。macOS 构建生成 `src-tauri/target/release/bundle/macos/Nib.app`，可直接启动。应用未配置分发签名或公证，本次未验证 DMG 安装流程。

## 原生窗口行为

在独立的临时项目中，通过真实 Tauri 窗口验证：

- 展示真实文件树，打开 Go 与 Markdown 文件并切换标签。
- 在中文文件名的 Go 文件中输入中文文本，执行 Cmd+S，核对磁盘内容，关闭标签再打开，内容一致。
- 修改后执行 Cmd+W，出现保存、放弃和返回编辑提示；返回后编辑内容及未保存标记保留。
- 标签切换后执行 Cmd+Z / Cmd+Shift+Z，撤销与重做历史保留，撤销至已保存内容时未保存标记消失。
- 外部程序修改磁盘文件后执行保存，界面显示冲突，编辑器内容和外部磁盘内容均保留；重新加载前再次提示未保存内容，选择放弃后读到外部版本。

上述中文文本输入使用自动化粘贴，不能替代真实中文输入法的候选词、组合输入和确认操作验收。

## 后台文件行为

临时 Rust 验证程序直接引入项目的 `workspace`、`filesystem` 和 `error` 模块，运行真实文件系统操作并断言结果。程序、依赖构建目录及样本均位于系统临时目录，验证后清理，不在项目中新增测试文件。

已通过：目录优先排序与隐藏规则；中文和空格路径；UTF-8 BOM 与 CRLF 读取；保存与重新读取；外部修改冲突；拒绝越界路径和项目外链接；项目内链接保存后保留链接；普通权限保留与只读拒绝；二进制、非 UTF-8、混合换行、超过 5 MiB 文件的明确错误；切换项目后拒绝旧工作区请求。

换行/BOM 的端到端序列化由前端保存适配实现，后台验证检查对应磁盘字节及返回信息。更广泛的编辑器操作、并发竞态、长时间使用和系统断电场景尚未覆盖。

## 待验收

- 真实 macOS 中文输入法组合输入；其他平台输入法。
- Windows、Linux 构建与交互。
- 启动时间、应用与 WebView 总内存、长期内存增长和大目录性能基线。
- 文件监听、崩溃恢复和后续阶段功能，详见 `roadmap.md`。

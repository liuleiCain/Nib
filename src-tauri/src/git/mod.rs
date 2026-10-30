use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    workspace::WorkspaceState,
};

mod history;
mod merge;
mod remote;

pub use history::{commit_detail, commit_diff, log, CommitDetail, LogPage};
pub use merge::{abort, merge, proceed, rebase, resolve, skip, Integration};
pub use remote::{
    branches, checkout_remote, create_branch, delete_branch, delete_remote_branch, fetch, pull,
    push, rename_branch, switch_branch, Branches, PullResult, PushResult,
};

/// 读取类命令的超时；超时后结束进程并提示。
const READ_TIMEOUT: Duration = Duration::from_secs(20);
/// 提交可能运行钩子（格式化、检查），给足时间；超时后结果未知，不自动重试。
const COMMIT_TIMEOUT: Duration = Duration::from_secs(300);
/// git status 输出上限，超出部分丢弃并标记截断。
const STATUS_LIMIT: usize = 16 * 1024 * 1024;
/// 变更列表最多展示的文件数，尚未做列表虚拟化。
const MAX_FILES: usize = 5_000;
/// Diff 单侧内容上限。
const DIFF_LIMIT: usize = 5 * 1024 * 1024;
/// 判断二进制时检查的开头字节数，与文件读取一致。
const SNIFF_BYTES: usize = 8 * 1024;
/// 错误输出只保留开头部分，避免钩子大量输出撑满提示。
const ERROR_LIMIT: usize = 64 * 1024;

/// 按仓库串行化写操作，避免两个窗口同时提交同一仓库。
#[derive(Clone, Default)]
pub struct GitLocks(Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>);

impl GitLocks {
    fn get(&self, repo: &Path) -> AppResult<Arc<Mutex<()>>> {
        let mut locks = self
            .0
            .lock()
            .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
        Ok(locks.entry(repo.to_path_buf()).or_default().clone())
    }
}

/// 项目的 Git 状态。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitStatus {
    /// 本机找不到可用的 Git。
    Unavailable { message: String },
    /// 项目不在任何 Git 仓库内，仍可正常编辑。
    NotRepository,
    /// 项目所属仓库的分支与变更。
    Repository(Repository),
}

/// 仓库分支信息与相对 HEAD 的全部变更（不区分暂存区，与 GoLand 默认提交模式一致）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    /// 仓库根目录。
    pub root: String,
    /// 当前分支；游离 HEAD 时为空。
    pub branch: Option<String>,
    /// HEAD 提交；尚无提交时为空。
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// 正在进行的合并、变基等操作，此时不支持部分提交。
    pub operation: Option<&'static str>,
    pub files: Vec<FileChange>,
    /// 变更过多，只返回了前一部分。
    pub truncated: bool,
}

/// 一个变更文件，路径相对项目根目录。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// 重命名前的路径。
    pub original: Option<String>,
    pub kind: ChangeKind,
    pub submodule: bool,
}

/// 合并暂存区与工作区后的文件状态。
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
    Untracked,
}

/// Diff 一侧的内容。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Side {
    /// 文本，换行已统一为 LF 并去掉 BOM，与编辑器一致。
    Text {
        content: String,
    },
    /// 该版本中不存在此文件。
    Missing,
    Binary,
    TooLarge,
    Unsupported {
        message: String,
    },
}

/// HEAD 版本与工作区版本。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSources {
    pub base: Side,
    pub current: Side,
}

/// 提交成功后的短哈希与标题。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
    pub summary: String,
}

struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

struct RepoInfo {
    top: PathBuf,
    prefix: String,
    git_dir: PathBuf,
}

/// 读取输出，超过上限后继续读取并丢弃，避免子进程因管道写满而阻塞。
fn read_capped(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut truncated = false;
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let room = limit.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..count.min(room)]);
        truncated |= count > room;
    }
    (kept, truncated)
}

/// 图形界面启动的应用拿不到登录 shell 的 PATH（Homebrew、nvm 等），提交钩子会找不到命令；首次调用时读取一次。
fn search_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let inherited = std::env::var("PATH").ok();
        // 登录 shell 的 PATH 在前，原有 PATH 兜底，shell 输出异常时仍能找到 Git。
        match (login_path(), inherited) {
            (Some(login), Some(inherited)) => Some(format!("{login}:{inherited}")),
            (login, inherited) => login.or(inherited),
        }
    })
    .as_deref()
}

#[cfg(unix)]
fn login_path() -> Option<String> {
    const MARK: &str = "__NIB_PATH__";
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())?;
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || read_capped(stdout, 64 * 1024).0);
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().ok()?.is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let text = String::from_utf8(reader.join().ok()?).ok()?;
    let start = text.find(MARK)? + MARK.len();
    let end = start + text[start..].find(MARK)?;
    Some(text[start..end].to_owned()).filter(|path| !path.is_empty())
}

#[cfg(not(unix))]
fn login_path() -> Option<String> {
    None
}

/// 以参数数组调用本机 Git，不经过 shell；禁止交互式认证与编辑器，超时后结束进程。
fn run(
    cwd: &Path,
    args: &[&str],
    input: Option<Vec<u8>>,
    limit: usize,
    timeout: Duration,
) -> AppResult<Output> {
    spawn(cwd, args, input, limit, timeout, false)
}

/// english 为真时使用英文输出，便于识别错误类型；会运行钩子的命令保持用户的语言环境。
fn spawn(
    cwd: &Path,
    args: &[&str],
    input: Option<Vec<u8>>,
    limit: usize,
    timeout: Duration,
    english: bool,
) -> AppResult<Output> {
    let mut command = Command::new("git");
    if english {
        command.env("LC_ALL", "C");
    }
    command
        .current_dir(cwd)
        .args(["--no-optional-locks", "--literal-pathspecs"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = search_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不弹出控制台窗口。
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                "GIT_MISSING",
                "未找到 Git。请安装 Git（macOS 可安装 Xcode Command Line Tools）后重试。",
            )
        } else {
            AppError::new("GIT", format!("无法启动 Git：{error}"))
        }
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = thread::spawn(move || stdout.map(|pipe| read_capped(pipe, limit)));
    let err = thread::spawn(move || stderr.map(|pipe| read_capped(pipe, ERROR_LIMIT)));
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        // 写完后关闭输入，Git 才会开始处理。
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(3));
    };
    let (stdout, truncated) = out.join().ok().flatten().unwrap_or_default();
    let (stderr, _) = err.join().ok().flatten().unwrap_or_default();
    let status = status.ok_or_else(|| {
        AppError::new(
            "GIT_TIMEOUT",
            format!("Git 超过 {} 秒未完成，已停止。", timeout.as_secs()),
        )
    })?;
    Ok(Output {
        success: status.success(),
        stdout,
        stderr,
        truncated,
    })
}

/// 把 Git 的错误输出转为可展示的说明。
fn failure(output: &Output) -> AppError {
    let text = String::from_utf8_lossy(&output.stderr);
    let text = text.trim();
    let mut message: String = text.chars().take(800).collect();
    if message.len() < text.len() {
        message.push('…');
    }
    if message.is_empty() {
        message = "Git 命令失败，未返回错误说明。".to_owned();
    }
    AppError::new("GIT", message)
}

fn lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::to_owned)
        .collect()
}

/// 项目所属仓库的根目录、项目在仓库内的前缀和 Git 目录；不在仓库内时返回空。
fn repo_info(root: &Path) -> AppResult<Option<RepoInfo>> {
    let output = spawn(
        root,
        &[
            "rev-parse",
            "--show-toplevel",
            "--show-prefix",
            "--absolute-git-dir",
        ],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
        true,
    )?;
    if !output.success {
        if String::from_utf8_lossy(&output.stderr).contains("not a git repository") {
            return Ok(None);
        }
        return Err(failure(&output));
    }
    let lines = lines(&output.stdout);
    let [top, prefix, git_dir] = lines.as_slice() else {
        return Err(AppError::new("GIT", "无法识别 Git 仓库信息。"));
    };
    Ok(Some(RepoInfo {
        top: PathBuf::from(top),
        prefix: prefix.clone(),
        git_dir: PathBuf::from(git_dir),
    }))
}

/// 根据 Git 目录中的标记文件判断正在进行的操作。
fn operation(git_dir: &Path) -> Option<&'static str> {
    [
        ("MERGE_HEAD", "合并"),
        ("rebase-merge", "变基"),
        ("rebase-apply", "变基"),
        ("CHERRY_PICK_HEAD", "拣选"),
        ("REVERT_HEAD", "还原"),
    ]
    .into_iter()
    .find(|(name, _)| git_dir.join(name).exists())
    .map(|(_, label)| label)
}

/// 仓库根目录相对路径转为项目根目录相对路径；项目外的路径用 ../ 表示。
fn project_path(prefix: &str, repo_path: &str) -> String {
    if let Some(inner) = repo_path.strip_prefix(prefix) {
        return inner.to_owned();
    }
    let depth = prefix.split('/').filter(|part| !part.is_empty()).count();
    format!("{}{repo_path}", "../".repeat(depth))
}

fn kind(xy: &str) -> ChangeKind {
    let mut codes = xy.chars();
    let (x, y) = (codes.next().unwrap_or('.'), codes.next().unwrap_or('.'));
    if x == 'A' || y == 'A' {
        ChangeKind::Added
    } else if x == 'D' || y == 'D' {
        ChangeKind::Deleted
    } else {
        ChangeKind::Modified
    }
}

/// 解析 `git status --porcelain=v2 -z --branch` 输出；路径以 NUL 分隔，可正确处理空格、中文和换行。
fn parse_status(info: &RepoInfo, output: &[u8], mut truncated: bool) -> Repository {
    let text = String::from_utf8_lossy(output);
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    let mut repository = Repository {
        root: info.top.to_string_lossy().into_owned(),
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        operation: operation(&info.git_dir),
        files: Vec::new(),
        truncated: false,
    };
    while let Some(record) = records.next() {
        let change = if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => repository.head = Some(value.to_owned()),
                "branch.head" if value != "(detached)" => {
                    repository.branch = Some(value.to_owned())
                }
                "branch.upstream" => repository.upstream = Some(value.to_owned()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(count) = part.strip_prefix('+') {
                            repository.ahead = count.parse().unwrap_or(0);
                        } else if let Some(count) = part.strip_prefix('-') {
                            repository.behind = count.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        } else if let Some(path) = record.strip_prefix("? ") {
            Some((path, None, ChangeKind::Untracked, false))
        } else if let Some(rest) = record.strip_prefix("1 ") {
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            (fields.len() == 8)
                .then(|| (fields[7], None, kind(fields[0]), fields[1].starts_with('S')))
        } else if let Some(rest) = record.strip_prefix("2 ") {
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            // 重命名记录后紧跟原路径；输出被截断时可能缺失。
            match (fields.len() == 9, records.next()) {
                (true, Some(original)) => Some((
                    fields[8],
                    Some(original),
                    ChangeKind::Renamed,
                    fields[1].starts_with('S'),
                )),
                _ => None,
            }
        } else if let Some(rest) = record.strip_prefix("u ") {
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            (fields.len() == 10).then(|| (fields[9], None, ChangeKind::Conflicted, false))
        } else {
            None
        };
        let Some((path, original, kind, submodule)) = change else {
            continue;
        };
        if repository.files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        repository.files.push(FileChange {
            path: project_path(&info.prefix, path),
            original: original.map(|original| project_path(&info.prefix, original)),
            kind,
            submodule,
        });
    }
    repository.truncated = truncated;
    repository
}

fn project_root(state: &WorkspaceState, id: u64) -> AppResult<PathBuf> {
    let root = state.lock()?.root_text(id)?;
    Ok(PathBuf::from(root))
}

/// 读取项目所属仓库的分支和变更；只统计项目目录内的文件。
pub fn status(state: &WorkspaceState, id: u64) -> AppResult<GitStatus> {
    let root = project_root(state, id)?;
    let info = match repo_info(&root) {
        Ok(Some(info)) => info,
        Ok(None) => return Ok(GitStatus::NotRepository),
        Err(error) if error.code == "GIT_MISSING" => {
            return Ok(GitStatus::Unavailable {
                message: error.message,
            })
        }
        Err(error) => return Err(error),
    };
    let output = run(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--",
            ".",
        ],
        None,
        STATUS_LIMIT,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    Ok(GitStatus::Repository(parse_status(
        &info,
        &output.stdout,
        output.truncated,
    )))
}

/// Git 路径参数只允许相对路径；重命名的原路径可能位于项目之外（../）。
fn checked(path: &str) -> AppResult<&str> {
    let invalid = path.is_empty()
        || path.contains('\0')
        || Path::new(path)
            .components()
            .any(|part| matches!(part, Component::RootDir | Component::Prefix(_)));
    if invalid {
        return Err(AppError::new("PATH", "Git 文件路径无效。"));
    }
    Ok(path)
}

/// 二进制、超限和编码检查后转为编辑器使用的文本。
fn side(bytes: Vec<u8>, truncated: bool) -> Side {
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return Side::Binary;
    }
    if truncated || bytes.len() > DIFF_LIMIT {
        return Side::TooLarge;
    }
    if bytes.contains(&0) {
        return Side::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(text) => {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            Side::Text {
                content: text.replace("\r\n", "\n").replace('\r', "\n"),
            }
        }
        Err(_) => Side::Unsupported {
            message: "此版本不是 UTF-8 编码，暂不显示 Diff。".to_owned(),
        },
    }
}

/// HEAD 中的文件内容，按仓库的换行和过滤规则转换为工作区形式。
fn head_side(root: &Path, path: &str) -> AppResult<Side> {
    blob_side(root, "HEAD", path)
}

/// 指定版本中的文件内容；revision 须为 HEAD 或已校验的提交哈希。
fn blob_side(root: &Path, revision: &str, path: &str) -> AppResult<Side> {
    let spec = format!("{revision}:./{}", checked(path)?);
    // 先确认对象类型：不存在（含尚无提交）时为新文件，子模块等非文件对象不显示内容。
    let kind = run(
        root,
        &["cat-file", "-t", &spec],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    if !kind.success {
        return Ok(Side::Missing);
    }
    if lines(&kind.stdout).first().map(String::as_str) != Some("blob") {
        return Ok(Side::Unsupported {
            message: "此路径在该版本中不是普通文件（如子模块），暂不显示 Diff。".to_owned(),
        });
    }
    let output = run(
        root,
        &["cat-file", "--filters", &spec],
        None,
        DIFF_LIMIT + 1,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    Ok(side(output.stdout, output.truncated))
}

/// 工作区中的文件内容；文件已删除时返回不存在。
fn current_side(state: &WorkspaceState, id: u64, path: &str) -> AppResult<Side> {
    let root = project_root(state, id)?;
    // 已删除的文件；悬空链接同样视为不存在。
    if std::fs::metadata(root.join(checked(path)?)).is_err() {
        return Ok(Side::Missing);
    }
    let resolved = state.lock()?.resolve(id, path)?;
    if !std::fs::metadata(&resolved)?.is_file() {
        return Ok(Side::Unsupported {
            message: "此路径不是普通文件，暂不显示 Diff。".to_owned(),
        });
    }
    let file = std::fs::File::open(&resolved)?;
    let (bytes, truncated) = read_capped(file.take(DIFF_LIMIT as u64 + 1), DIFF_LIMIT);
    Ok(side(bytes, truncated))
}

/// 编辑器行号旁变更标记使用的 HEAD 版本。
pub fn head_file(state: &WorkspaceState, id: u64, path: &str) -> AppResult<Side> {
    let root = project_root(state, id)?;
    head_side(&root, path)
}

/// HEAD 版本与工作区版本；重命名时 HEAD 侧读取原路径。
pub fn diff(
    state: &WorkspaceState,
    id: u64,
    path: &str,
    original: Option<&str>,
) -> AppResult<DiffSources> {
    let root = project_root(state, id)?;
    Ok(DiffSources {
        base: head_side(&root, original.unwrap_or(path))?,
        current: current_side(state, id, path)?,
    })
}

fn nul_joined(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for path in paths {
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0);
    }
    bytes
}

/// 只提交勾选的文件（git commit --only），不改变其他文件的暂存状态。
///
/// 未跟踪文件先以 intent-to-add 登记，提交失败时撤销登记，恢复为未跟踪。
pub fn commit(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    message: &str,
    paths: &[String],
    untracked: &[String],
) -> AppResult<CommitResult> {
    let summary = message.lines().next().unwrap_or("").trim().to_owned();
    if message.trim().is_empty() {
        return Err(AppError::new("COMMIT", "请填写提交信息。"));
    }
    if paths.is_empty() {
        return Err(AppError::new("COMMIT", "请至少勾选一个文件。"));
    }
    for path in paths.iter().chain(untracked) {
        checked(path)?;
    }
    let root = project_root(state, id)?;
    let info = repo_info(&root)?.ok_or_else(|| AppError::new("COMMIT", "项目不在 Git 仓库内。"))?;
    let lock = locks.get(&info.top)?;
    let _guard = lock
        .lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
    if let Some(operation) = operation(&info.git_dir) {
        return Err(AppError::new(
            "COMMIT",
            format!("仓库正在进行{operation}，Nib 暂不支持在此状态下提交。请先完成或中止后重试。"),
        ));
    }
    let pathspec = ["--pathspec-from-file=-", "--pathspec-file-nul"];
    if !untracked.is_empty() {
        let output = run(
            &root,
            &["add", "--intent-to-add", pathspec[0], pathspec[1]],
            Some(nul_joined(untracked)),
            ERROR_LIMIT,
            READ_TIMEOUT,
        )?;
        if !output.success {
            return Err(failure(&output));
        }
    }
    let message_arg = format!("--message={message}");
    let result = run(
        &root,
        &[
            "commit",
            "--only",
            "--quiet",
            &message_arg,
            pathspec[0],
            pathspec[1],
        ],
        Some(nul_joined(paths)),
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
    );
    match result {
        Ok(output) if output.success => {}
        Ok(output) => {
            rollback(&root, untracked);
            return Err(failure(&output));
        }
        // 超时后提交是否完成未知，不撤销登记，提示用户检查。
        Err(error) if error.code == "GIT_TIMEOUT" => {
            return Err(AppError::new(
                "GIT_TIMEOUT",
                format!(
                    "提交超过 {} 秒未完成，已停止等待。提交结果未知，请在终端检查仓库状态（可能残留 .git/index.lock）。",
                    COMMIT_TIMEOUT.as_secs()
                ),
            ))
        }
        Err(error) => {
            rollback(&root, untracked);
            return Err(error);
        }
    }
    let head = run(
        &root,
        &["rev-parse", "--short", "HEAD"],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    Ok(CommitResult {
        hash: lines(&head.stdout).into_iter().next().unwrap_or_default(),
        summary,
    })
}

/// 从 HEAD 恢复已删除的文件（git checkout HEAD -- 路径），同时恢复该路径的暂存状态。
///
/// 只用于工作区中已不存在的文件，不会覆盖任何现有内容。
pub fn restore(state: &WorkspaceState, locks: &GitLocks, id: u64, path: &str) -> AppResult<()> {
    let path = inside(path)?;
    let root = project_root(state, id)?;
    let info =
        repo_info(&root)?.ok_or_else(|| AppError::new("RESTORE", "项目不在 Git 仓库内。"))?;
    let lock = locks.get(&info.top)?;
    let _guard = lock
        .lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
    if let Some(operation) = operation(&info.git_dir) {
        return Err(AppError::new(
            "RESTORE",
            format!(
                "仓库正在进行{operation}，Nib 暂不支持在此状态下恢复文件。请先完成或中止后重试。"
            ),
        ));
    }
    // 持锁后再确认文件仍不存在，避免覆盖确认期间重新出现的文件。
    if std::fs::symlink_metadata(root.join(path)).is_ok() {
        return Err(AppError::new(
            "RESTORE",
            "文件已存在，未执行恢复。请刷新 Git 状态后查看。",
        ));
    }
    let spec = format!("HEAD:./{path}");
    let kind = run(
        &root,
        &["cat-file", "-t", &spec],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    if !kind.success || lines(&kind.stdout).first().map(String::as_str) != Some("blob") {
        return Err(AppError::new(
            "RESTORE",
            "HEAD 中没有此文件，或它不是普通文件（如子模块），无法恢复。",
        ));
    }
    match run(
        &root,
        &["checkout", "HEAD", "--", path],
        None,
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
    ) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err(failure(&output)),
        // 超时后写入是否完成未知，不重试，提示用户检查。
        Err(error) if error.code == "GIT_TIMEOUT" => Err(AppError::new(
            "GIT_TIMEOUT",
            format!(
                "恢复超过 {} 秒未完成，已停止等待。结果未知，请刷新 Git 状态或在终端检查（可能残留 .git/index.lock）。",
                COMMIT_TIMEOUT.as_secs()
            ),
        )),
        Err(error) => Err(error),
    }
}

/// 将未跟踪文件加入版本控制（git add），与 GoLand 的“添加到 VCS”一致；只登记文件，不提交。
pub fn add(state: &WorkspaceState, locks: &GitLocks, id: u64, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::new("ADD", "请至少选择一个文件。"));
    }
    for path in paths {
        inside(path)?;
    }
    let root = project_root(state, id)?;
    let info = repo_info(&root)?.ok_or_else(|| AppError::new("ADD", "项目不在 Git 仓库内。"))?;
    let lock = locks.get(&info.top)?;
    let _guard = lock
        .lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
    match run(
        &root,
        &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
        Some(nul_joined(paths)),
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
    ) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err(failure(&output)),
        // 超时后登记是否完成未知，不重试，提示用户检查。
        Err(error) if error.code == "GIT_TIMEOUT" => Err(AppError::new(
            "GIT_TIMEOUT",
            format!(
                "加入版本控制超过 {} 秒未完成，已停止等待。结果未知，请刷新 Git 状态或在终端检查（可能残留 .git/index.lock）。",
                COMMIT_TIMEOUT.as_secs()
            ),
        )),
        Err(error) => Err(error),
    }
}

/// 写操作只接受项目内的相对路径，拒绝 `..`、`.` 和绝对路径。
fn inside(path: &str) -> AppResult<&str> {
    let path = checked(path)?;
    if !Path::new(path)
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(AppError::new("PATH", "只能操作项目内的文件。"));
    }
    Ok(path)
}

/// 撤销 intent-to-add 登记，文件恢复为未跟踪，内容不受影响。
fn rollback(root: &Path, untracked: &[String]) {
    if untracked.is_empty() {
        return;
    }
    let _ = run(
        root,
        &[
            "rm",
            "--cached",
            "--quiet",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        Some(nul_joined(untracked)),
        ERROR_LIMIT,
        READ_TIMEOUT,
    );
}

/// 进入写操作：确认项目在仓库内，取得仓库锁，并拒绝进行中的合并、变基等。
fn write_guard(
    root: &Path,
    locks: &GitLocks,
    action: &str,
) -> AppResult<(RepoInfo, Arc<Mutex<()>>)> {
    let info = repo_info(root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    if let Some(operation) = operation(&info.git_dir) {
        return Err(AppError::new(
            "GIT",
            format!(
                "仓库正在进行{operation}，Nib 暂不支持在此状态下{action}。请先完成或中止后重试。"
            ),
        ));
    }
    let lock = locks.get(&info.top)?;
    Ok((info, lock))
}

/// 路径下是否有已跟踪文件（含已暂存的新增）；目录会检查其中所有文件。
fn tracked(root: &Path, path: &str) -> AppResult<bool> {
    let output = run(root, &["ls-files", "-z", "--", path], None, 1, READ_TIMEOUT)?;
    if !output.success {
        return Err(failure(&output));
    }
    Ok(!output.stdout.is_empty())
}

/// 写操作超时：结果未知，不重试。
fn write_timeout(action: &str) -> AppError {
    AppError::new(
        "GIT_TIMEOUT",
        format!(
            "{action}超过 {} 秒未完成，已停止等待。结果未知，请刷新 Git 状态或在终端检查（可能残留 .git/index.lock）。",
            COMMIT_TIMEOUT.as_secs()
        ),
    )
}

/// 按 NUL 分隔传入路径执行写命令；失败返回 Git 的说明，超时返回结果未知。
fn write(root: &Path, args: &[&str], paths: &[String], action: &str) -> AppResult<()> {
    let mut full = args.to_vec();
    full.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    match run(
        root,
        &full,
        Some(nul_joined(paths)),
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
    ) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout(action)),
        Err(error) => Err(error),
    }
}

/// 回滚文件的变更，与 GoLand 的 Rollback 一致：
///
/// - 修改、删除：暂存区和工作区都恢复为 HEAD 版本，修改内容被丢弃；
/// - 重命名：恢复原路径，移除新路径（工作区中的新文件一并删除）；
/// - 新增：只取消加入版本控制，文件保留为未跟踪。
///
/// 状态在持锁后重新读取，不信任前端传来的状态；未跟踪和冲突文件会被拒绝。
pub fn revert(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    paths: &[String],
) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::new("ROLLBACK", "请至少选择一个文件。"));
    }
    for path in paths {
        inside(path)?;
    }
    let root = project_root(state, id)?;
    let (info, lock) = write_guard(&root, locks, "回滚")?;
    let _guard = lock
        .lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
    let output = run(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
        None,
        STATUS_LIMIT,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    let repository = parse_status(&info, &output.stdout, output.truncated);
    let mut restore = Vec::new();
    let mut unstage = Vec::new();
    for path in paths {
        let Some(file) = repository.files.iter().find(|file| &file.path == path) else {
            return Err(AppError::new(
                "ROLLBACK",
                format!("{path} 已没有变更，请刷新 Git 状态后重试。"),
            ));
        };
        if file.submodule {
            return Err(AppError::new(
                "ROLLBACK",
                format!("{path} 是子模块，请在终端处理。"),
            ));
        }
        match file.kind {
            ChangeKind::Modified | ChangeKind::Deleted => restore.push(file.path.clone()),
            ChangeKind::Renamed => {
                restore.push(file.path.clone());
                restore.extend(file.original.clone());
            }
            ChangeKind::Added => unstage.push(file.path.clone()),
            ChangeKind::Untracked => {
                return Err(AppError::new(
                    "ROLLBACK",
                    format!("{path} 未被跟踪，HEAD 中没有可回滚的版本。"),
                ))
            }
            ChangeKind::Conflicted => {
                return Err(AppError::new(
                    "ROLLBACK",
                    format!("{path} 有冲突，请在终端解决冲突后再操作。"),
                ))
            }
        }
    }
    // restore 默认不保留 HEAD 中不存在的路径，重命名的新路径会从暂存区和工作区移除。
    if !restore.is_empty() {
        write(
            &root,
            &["restore", "--source=HEAD", "--staged", "--worktree"],
            &restore,
            "回滚",
        )?;
    }
    if !unstage.is_empty() {
        write(&root, &["restore", "--staged"], &unstage, "回滚")?;
    }
    Ok(())
}

/// 把未跟踪的文件或目录写入项目根目录的 .gitignore（以 / 开头锚定到项目根目录）。
///
/// 含已跟踪文件的路径会被拒绝：写入忽略规则对已跟踪文件无效，容易产生误解。
pub fn ignore(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    paths: &[String],
) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::new("IGNORE", "请至少选择一个文件。"));
    }
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "修改忽略规则")?;
    let _guard = lock
        .lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
    let mut rules = Vec::new();
    for path in paths {
        let path = inside(path)?;
        if path.contains(['\n', '\r']) {
            return Err(AppError::new(
                "IGNORE",
                "文件名含换行符，无法写入 .gitignore。",
            ));
        }
        if tracked(&root, path)? {
            return Err(AppError::new(
                "IGNORE",
                format!("{path} 中有已被 Git 跟踪的文件，忽略规则对它们无效，未写入。"),
            ));
        }
        let directory = std::fs::symlink_metadata(root.join(path))
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        rules.push(format!(
            "/{}{}",
            escape_rule(path),
            if directory { "/" } else { "" }
        ));
    }
    let file = state.lock()?.entry(id, ".gitignore")?;
    // 指向别处的链接可能把规则写到项目之外，只接受普通文件。
    if std::fs::symlink_metadata(&file).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(AppError::new(
            "IGNORE",
            ".gitignore 不是普通文件（可能是符号链接），未写入。",
        ));
    }
    let existing = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let text = String::from_utf8_lossy(&existing);
    let present: Vec<&str> = text.lines().map(str::trim_end).collect();
    rules.retain(|rule| !present.contains(&rule.as_str()));
    if rules.is_empty() {
        return Ok(());
    }
    // 沿用文件原有的换行风格，并补齐末尾缺失的换行。
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        addition.push_str(newline);
    }
    for rule in rules {
        addition.push_str(&rule);
        addition.push_str(newline);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)?
        .write_all(addition.as_bytes())?;
    Ok(())
}

/// 转义 .gitignore 中的通配符和末尾空格，让规则只匹配这个路径本身。
fn escape_rule(path: &str) -> String {
    let mut rule = String::new();
    for character in path.chars() {
        if matches!(character, '\\' | '*' | '?' | '[') {
            rule.push('\\');
        }
        rule.push(character);
    }
    let trimmed = rule.trim_end_matches(' ');
    let spaces = rule.len() - trimmed.len();
    format!("{trimmed}{}", "\\ ".repeat(spaces))
}

/// 重命名文件或目录，返回新路径。含已跟踪文件时用 git mv，提交面板显示为重命名；否则直接改名。
pub fn rename(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    path: &str,
    name: &str,
) -> AppResult<String> {
    let target = crate::filesystem::rename_target(state, id, path, name)?;
    let root = project_root(state, id)?;
    let info = match repo_info(&root) {
        Ok(info) => info,
        // 本机没有 Git 时按普通文件处理。
        Err(error) if error.code == "GIT_MISSING" => None,
        Err(error) => return Err(error),
    };
    let Some(info) = info else {
        crate::filesystem::rename(state, id, path, &target)?;
        return Ok(target);
    };
    let lock = locks.get(&info.top)?;
    let _guard = lock
        .lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))?;
    if !tracked(&root, path)? {
        crate::filesystem::rename(state, id, path, &target)?;
        return Ok(target);
    }
    if let Some(operation) = operation(&info.git_dir) {
        return Err(AppError::new(
            "GIT",
            format!("仓库正在进行{operation}，Nib 暂不支持在此状态下重命名已跟踪的文件。请先完成或中止后重试。"),
        ));
    }
    // 目标已存在时 git mv 会拒绝，不加 -f。
    match run(
        &root,
        &["mv", "--", path, &target],
        None,
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
    ) {
        Ok(output) if output.success => Ok(target),
        Ok(output) => Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout("重命名")),
        Err(error) => Err(error),
    }
}

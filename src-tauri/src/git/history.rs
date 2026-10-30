//! 提交记录：当前分支的分页列表、单个提交的详情与文件 Diff。

use std::path::Path;

use serde::Serialize;

use super::{
    blob_side, checked, failure, lines, project_root, repo_info, run, ChangeKind, DiffSources,
    Side, ERROR_LIMIT, MAX_FILES, READ_TIMEOUT, STATUS_LIMIT,
};
use crate::{
    error::{AppError, AppResult},
    workspace::WorkspaceState,
};

/// 每页提交数，前端按需加载下一页。
const PAGE_SIZE: usize = 100;
/// 一页提交记录的输出上限。
const LOG_LIMIT: usize = 4 * 1024 * 1024;
/// 提交信息的输出上限。
const MESSAGE_LIMIT: usize = 1024 * 1024;

/// 列表中的一个提交。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// 作者时间，Unix 秒。
    pub time: i64,
    pub subject: String,
    pub refs: Vec<CommitRef>,
}

/// 指向该提交的引用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub name: String,
    /// head 为当前分支，branch 本地分支，remote 远程分支，tag 标签。
    pub kind: &'static str,
}

/// 一页提交记录；more 表示还有更早的提交。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<CommitSummary>,
    pub more: bool,
}

/// 提交中变更的一个文件，路径相对项目根目录。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// 重命名前的路径。
    pub original: Option<String>,
    pub kind: ChangeKind,
}

/// 提交的完整信息与变更文件；合并提交与第一个父提交比较。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<CommitFile>,
    pub truncated: bool,
}

/// 提交哈希只接受十六进制，避免被当作选项或修订表达式解析。
fn hash(value: &str) -> AppResult<&str> {
    if (4..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(AppError::new("GIT", "提交哈希无效。"))
    }
}

/// 仓库是否已有提交；新仓库的 HEAD 尚未指向任何提交。
pub(super) fn has_commits(root: &Path) -> AppResult<bool> {
    let output = run(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    Ok(output.success)
}

/// 把 `%D`（--decorate=full）解析为分支、远程分支和标签。
fn parse_refs(text: &str) -> Vec<CommitRef> {
    let mut refs = Vec::new();
    for item in text.split(", ").filter(|item| !item.is_empty()) {
        let (name, kind) = if let Some(branch) = item.strip_prefix("HEAD -> refs/heads/") {
            (branch, "head")
        } else if let Some(tag) = item.strip_prefix("tag: refs/tags/") {
            (tag, "tag")
        } else if let Some(branch) = item.strip_prefix("refs/heads/") {
            (branch, "branch")
        } else if let Some(branch) = item.strip_prefix("refs/remotes/") {
            // origin/HEAD 只是远程默认分支的别名，不单独显示。
            if branch.ends_with("/HEAD") {
                continue;
            }
            (branch, "remote")
        } else {
            // 游离 HEAD、stash 等不显示。
            continue;
        };
        refs.push(CommitRef {
            name: name.to_owned(),
            kind,
        });
    }
    refs
}

/// 当前 HEAD 的提交记录，只包含涉及项目目录的提交；skip 为已加载的数量。
pub fn log(state: &WorkspaceState, id: u64, skip: usize) -> AppResult<LogPage> {
    let root = project_root(state, id)?;
    repo_info(&root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    if !has_commits(&root)? {
        return Ok(LogPage {
            commits: Vec::new(),
            more: false,
        });
    }
    let count = format!("--max-count={}", PAGE_SIZE + 1);
    let skip = format!("--skip={skip}");
    let output = run(
        &root,
        &[
            "log",
            "-z",
            "--no-color",
            "--decorate=full",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D",
            &count,
            &skip,
            "HEAD",
            "--",
            ".",
        ],
        None,
        LOG_LIMIT,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut records: Vec<&str> = text.split('\0').filter(|item| !item.is_empty()).collect();
    // 输出被截断时最后一条可能不完整。
    if output.truncated {
        records.pop();
    }
    let mut commits = Vec::new();
    for record in records {
        let fields: Vec<&str> = record.split('\u{1f}').collect();
        let [hash, parents, author, email, time, subject, refs] = fields.as_slice() else {
            continue;
        };
        commits.push(CommitSummary {
            hash: (*hash).to_owned(),
            parents: parents.split_whitespace().map(str::to_owned).collect(),
            author: (*author).to_owned(),
            email: (*email).to_owned(),
            time: time.parse().unwrap_or(0),
            subject: (*subject).to_owned(),
            refs: parse_refs(refs),
        });
    }
    let more = commits.len() > PAGE_SIZE || output.truncated;
    commits.truncate(PAGE_SIZE);
    Ok(LogPage { commits, more })
}

/// 第一个父提交；根提交返回空。
fn first_parent(root: &Path, commit: &str) -> AppResult<Option<String>> {
    let output = run(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{commit}^1^{{commit}}"),
        ],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    Ok(output
        .success
        .then(|| lines(&output.stdout).into_iter().next())
        .flatten())
}

/// 确认哈希指向一个提交，返回完整哈希。
fn resolve(root: &Path, commit: &str) -> AppResult<String> {
    let output = run(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{}^{{commit}}", hash(commit)?),
        ],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    output
        .success
        .then(|| lines(&output.stdout).into_iter().next())
        .flatten()
        .ok_or_else(|| AppError::new("GIT", "找不到该提交，可能已被移除。"))
}

/// 提交的完整信息，以及涉及项目目录的变更文件。
pub fn commit_detail(state: &WorkspaceState, id: u64, commit: &str) -> AppResult<CommitDetail> {
    let root = project_root(state, id)?;
    repo_info(&root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    let commit = resolve(&root, commit)?;
    let output = run(
        &root,
        &[
            "show",
            "--no-patch",
            "--no-color",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B",
            &commit,
        ],
        None,
        MESSAGE_LIMIT,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let fields: Vec<&str> = text.splitn(8, '\u{1f}').collect();
    let [hash, parents, author, email, time, committer, commit_time, message] = fields.as_slice()
    else {
        return Err(AppError::new("GIT", "无法识别提交信息。"));
    };
    let parent = first_parent(&root, &commit)?;
    // 与第一个父提交比较；--relative 只列出项目目录内的文件，路径相对项目根目录。
    let mut args = vec![
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--name-status",
        "--find-renames",
        "--relative",
    ];
    match &parent {
        Some(parent) => args.push(parent),
        None => args.push("--root"),
    }
    args.push(&commit);
    let tree = run(&root, &args, None, STATUS_LIMIT, READ_TIMEOUT)?;
    if !tree.success {
        return Err(failure(&tree));
    }
    let tree_text = String::from_utf8_lossy(&tree.stdout);
    let mut items = tree_text.split('\0').filter(|item| !item.is_empty());
    let mut files = Vec::new();
    let mut truncated = tree.truncated;
    while let Some(status) = items.next() {
        let (kind, renamed) = match status.chars().next() {
            Some('A') => (ChangeKind::Added, false),
            Some('D') => (ChangeKind::Deleted, false),
            Some('R') => (ChangeKind::Renamed, true),
            // 复制按新增显示，原文件未变化。
            Some('C') => (ChangeKind::Added, true),
            _ => (ChangeKind::Modified, false),
        };
        let first = items.next();
        let second = if renamed { items.next() } else { None };
        let (path, original) = match (renamed, first, second) {
            (false, Some(path), _) => (path, None),
            (true, Some(original), Some(path)) => (
                path,
                (kind == ChangeKind::Renamed).then(|| original.to_owned()),
            ),
            _ => break,
        };
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        files.push(CommitFile {
            path: path.to_owned(),
            original,
            kind,
        });
    }
    Ok(CommitDetail {
        hash: (*hash).to_owned(),
        parents: parents.split_whitespace().map(str::to_owned).collect(),
        author: (*author).to_owned(),
        email: (*email).to_owned(),
        time: time.trim().parse().unwrap_or(0),
        committer: (*committer).to_owned(),
        commit_time: commit_time.trim().parse().unwrap_or(0),
        message: message.trim_end().to_owned(),
        files,
        truncated,
    })
}

/// 提交中一个文件相对第一个父提交的变化；original 为重命名前的路径。
pub fn commit_diff(
    state: &WorkspaceState,
    id: u64,
    commit: &str,
    path: &str,
    original: Option<&str>,
) -> AppResult<DiffSources> {
    let root = project_root(state, id)?;
    let commit = resolve(&root, commit)?;
    checked(path)?;
    let base = match first_parent(&root, &commit)? {
        Some(parent) => blob_side(&root, &parent, original.unwrap_or(path))?,
        None => Side::Missing,
    };
    Ok(DiffSources {
        base,
        current: blob_side(&root, &commit, path)?,
    })
}

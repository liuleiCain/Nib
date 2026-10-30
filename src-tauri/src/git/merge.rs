//! 合并与变基：把其他分支合并到当前分支、把当前分支变基到其他分支，以及冲突后的标记解决、完成、跳过与中止。
//!
//! 只在没有未提交修改时开始（Nib 不提供 Stash），保证中止时能完整恢复到开始前的状态。
//! 冲突文件保留冲突标记，在编辑器中修改后标记为已解决；不提供图形化的三方合并界面。

use std::{io::Read, path::Path};

use serde::Serialize;

use super::{
    failure,
    history::has_commits,
    inside, operation, project_path, project_root, read_capped,
    remote::{current_branch, first_line, guard, is_ancestor, ref_exists},
    repo_info, run, write, write_guard, write_timeout, GitLocks, Output, RepoInfo, COMMIT_TIMEOUT,
    DIFF_LIMIT, ERROR_LIMIT, READ_TIMEOUT, STATUS_LIMIT,
};
use crate::{
    error::{AppError, AppResult},
    workspace::WorkspaceState,
};

/// 暂停结果中最多列出的冲突文件数。
const MAX_LISTED: usize = 20;

/// 合并、变基、继续或跳过的结果。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Integration {
    /// 当前分支已包含目标分支，无需操作。
    UpToDate,
    /// 已完成；hash 为完成后 HEAD 的短哈希。
    Done { hash: String },
    /// 因冲突或钩子失败而暂停，仓库保留在进行中的状态。
    Stopped {
        /// 未解决冲突的文件（相对项目根目录），最多列出 MAX_LISTED 个。
        files: Vec<String>,
        /// 未解决冲突的文件总数。
        total: usize,
        /// 没有冲突时 Git 给出的停止原因。
        message: Option<String>,
    },
}

/// 仓库中未解决冲突的文件，路径相对项目根目录；项目外的文件以 ../ 开头。
fn conflicts(root: &Path, info: &RepoInfo) -> AppResult<Vec<String>> {
    let output = run(
        root,
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-relative",
            "--diff-filter=U",
        ],
        None,
        STATUS_LIMIT,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| project_path(&info.prefix, path))
        .collect())
}

/// 命令失败后：仓库仍在合并或变基中时返回暂停结果，否则返回 Git 的错误说明。
fn stopped(root: &Path, info: &RepoInfo, output: &Output) -> AppResult<Integration> {
    if operation(&info.git_dir).is_none() {
        return Err(failure(output));
    }
    let files = conflicts(root, info)?;
    Ok(Integration::Stopped {
        total: files.len(),
        message: files.is_empty().then(|| failure(output).message),
        files: files.into_iter().take(MAX_LISTED).collect(),
    })
}

fn head(root: &Path) -> AppResult<String> {
    let output = run(
        root,
        &["rev-parse", "--short", "HEAD"],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    Ok(first_line(&output).unwrap_or_default())
}

/// 开始前要求已跟踪文件没有未提交的修改（未跟踪文件不影响），保证中止时能完整恢复。
fn ensure_clean(top: &Path, action: &str) -> AppResult<()> {
    let output = run(
        top,
        &["status", "--porcelain", "-z", "--untracked-files=no"],
        None,
        1,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    if !output.stdout.is_empty() {
        return Err(AppError::new(
            "DIRTY",
            format!("仓库有未提交的修改，请先提交后再{action}。Nib 暂不提供暂存（Stash），这样中止{action}时能完整恢复到开始前的状态。"),
        ));
    }
    Ok(())
}

/// 合并或变基的目标：本地或远程分支的完整引用名，不能是当前分支。
fn checked_target<'a>(root: &Path, target: &'a str) -> AppResult<&'a str> {
    let valid = (target.starts_with("refs/heads/") || target.starts_with("refs/remotes/"))
        && ref_exists(root, target)?;
    if !valid {
        return Err(AppError::new(
            "MERGE",
            "目标分支不存在，请刷新分支列表后重试。",
        ));
    }
    if let Some(current) = current_branch(root)? {
        if target == format!("refs/heads/{current}") {
            return Err(AppError::new("MERGE", "不能与当前分支自身合并或变基。"));
        }
    }
    Ok(target)
}

/// 执行合并或变基类命令：失败时仍在进行中则返回暂停结果；超时后结果未知，不重试。
fn integrate(root: &Path, info: &RepoInfo, args: &[&str], action: &str) -> AppResult<Integration> {
    // 会运行钩子，保持用户的语言环境。
    match run(root, args, None, ERROR_LIMIT, COMMIT_TIMEOUT) {
        Ok(output) if output.success => Ok(Integration::Done { hash: head(root)? }),
        Ok(output) => stopped(root, info, &output),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout(action)),
        Err(error) => Err(error),
    }
}

/// 把目标分支合并到当前分支：能快进时快进，否则生成合并提交（使用 Git 默认的合并信息）。
/// 有冲突时保留合并状态，返回冲突文件。
pub fn merge(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    target: &str,
) -> AppResult<Integration> {
    let root = project_root(state, id)?;
    let (info, lock) = write_guard(&root, locks, "合并")?;
    let _guard = guard(&lock)?;
    if !has_commits(&root)? {
        return Err(AppError::new("MERGE", "仓库还没有提交，无法合并。"));
    }
    let target = checked_target(&root, target)?;
    ensure_clean(&info.top, "合并")?;
    if is_ancestor(&root, target, "HEAD")? {
        return Ok(Integration::UpToDate);
    }
    let message = format!("--message={}", merge_message(&root, target)?);
    integrate(
        &root,
        &info,
        &[
            "merge",
            "--no-edit",
            "--no-autostash",
            "--quiet",
            &message,
            target,
        ],
        "合并",
    )
}

/// 与 Git 默认格式一致的合并信息，使用分支短名（传完整引用名时 Git 会把它写进信息）；
/// 不直接传短名，避免同名标签优先被解析。
fn merge_message(root: &Path, target: &str) -> AppResult<String> {
    let source = match target.strip_prefix("refs/heads/") {
        Some(name) => format!("branch '{name}'"),
        None => format!(
            "remote-tracking branch '{}'",
            target.strip_prefix("refs/remotes/").unwrap_or(target)
        ),
    };
    Ok(match current_branch(root)? {
        Some(current) if current != "main" && current != "master" => {
            format!("Merge {source} into {current}")
        }
        _ => format!("Merge {source}"),
    })
}

/// 把当前分支中目标分支没有的提交依次重放到目标分支之上。有冲突时停在该提交，返回冲突文件。
pub fn rebase(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    target: &str,
) -> AppResult<Integration> {
    let root = project_root(state, id)?;
    let (info, lock) = write_guard(&root, locks, "变基")?;
    let _guard = guard(&lock)?;
    if !has_commits(&root)? {
        return Err(AppError::new("MERGE", "仓库还没有提交，无法变基。"));
    }
    let target = checked_target(&root, target)?;
    ensure_clean(&info.top, "变基")?;
    if is_ancestor(&root, target, "HEAD")? {
        return Ok(Integration::UpToDate);
    }
    integrate(
        &root,
        &info,
        &["rebase", "--no-autostash", "--quiet", target],
        "变基",
    )
}

fn repository(root: &Path) -> AppResult<RepoInfo> {
    repo_info(root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))
}

/// 进行中的操作（合并或变基）；须在持有仓库锁后调用。
fn in_progress(info: &RepoInfo, action: &str) -> AppResult<&'static str> {
    match operation(&info.git_dir) {
        Some(kind @ ("合并" | "变基")) => Ok(kind),
        Some(kind) => Err(AppError::new(
            "MERGE",
            format!("仓库正在进行{kind}，Nib 暂不支持在此状态下{action}，请在终端处理。"),
        )),
        None => Err(AppError::new(
            "MERGE",
            "仓库没有进行中的合并或变基，请刷新 Git 状态。",
        )),
    }
}

/// 文件中是否仍有成对的冲突标记（<<<<<<< 与 >>>>>>>）；只检查开头 DIFF_LIMIT 字节。
fn has_markers(state: &WorkspaceState, id: u64, path: &str) -> AppResult<bool> {
    let root = project_root(state, id)?;
    // 已删除的文件（如保留删除来解决冲突）没有标记。
    if std::fs::metadata(root.join(path)).is_err() {
        return Ok(false);
    }
    let resolved = state.lock()?.resolve(id, path)?;
    if !std::fs::metadata(&resolved)?.is_file() {
        return Ok(false);
    }
    let file = std::fs::File::open(&resolved)?;
    let (bytes, _) = read_capped(file.take(DIFF_LIMIT as u64), DIFF_LIMIT);
    let mut opened = false;
    for line in String::from_utf8_lossy(&bytes).lines() {
        if line.starts_with("<<<<<<< ") {
            opened = true;
        } else if opened && line.starts_with(">>>>>>> ") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 把冲突文件标记为已解决（git add --all，已删除的文件记为删除）。
///
/// 文件中仍有冲突标记时返回 CONFLICT_MARKERS，由用户确认后 force 标记。
pub fn resolve(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    paths: &[String],
    force: bool,
) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::new("MERGE", "请至少选择一个文件。"));
    }
    for path in paths {
        inside(path)?;
    }
    let root = project_root(state, id)?;
    let info = repository(&root)?;
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    in_progress(&info, "标记冲突")?;
    let remaining = conflicts(&root, &info)?;
    for path in paths {
        if !remaining.contains(path) {
            return Err(AppError::new(
                "MERGE",
                format!("{path} 没有未解决的冲突，请刷新 Git 状态。"),
            ));
        }
        if !force && has_markers(state, id, path)? {
            return Err(AppError::new(
                "CONFLICT_MARKERS",
                format!("{path} 中仍有冲突标记（<<<<<<< … >>>>>>>），可能还没有解决完。"),
            ));
        }
    }
    write(&root, &["add", "--all"], paths, "标记为已解决")
}

/// 冲突都已解决后完成合并（生成合并提交）或继续变基（应用下一个提交）。
///
/// 已跟踪文件的修改一并纳入：开始前要求没有未提交的修改，这些修改都来自解决冲突。
pub fn proceed(state: &WorkspaceState, locks: &GitLocks, id: u64) -> AppResult<Integration> {
    let root = project_root(state, id)?;
    let info = repository(&root)?;
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    let kind = in_progress(&info, "继续")?;
    let remaining = conflicts(&root, &info)?;
    if !remaining.is_empty() {
        return Ok(Integration::Stopped {
            total: remaining.len(),
            files: remaining.into_iter().take(MAX_LISTED).collect(),
            message: None,
        });
    }
    // add --update 不带路径时作用于整个仓库，与当前目录无关。
    match run(
        &info.top,
        &["add", "--update"],
        None,
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
    ) {
        Ok(output) if output.success => {}
        Ok(output) => return Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => return Err(write_timeout("继续")),
        Err(error) => return Err(error),
    }
    if kind == "合并" {
        integrate(
            &root,
            &info,
            &["commit", "--no-edit", "--quiet"],
            "完成合并",
        )
    } else {
        integrate(&root, &info, &["rebase", "--continue"], "继续变基")
    }
}

/// 变基时跳过当前停下的提交（git rebase --skip），丢弃它的修改和已做的冲突解决。
pub fn skip(state: &WorkspaceState, locks: &GitLocks, id: u64) -> AppResult<Integration> {
    let root = project_root(state, id)?;
    let info = repository(&root)?;
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    if in_progress(&info, "跳过提交")? != "变基" {
        return Err(AppError::new("MERGE", "只有变基可以跳过提交。"));
    }
    integrate(&root, &info, &["rebase", "--skip"], "跳过提交")
}

/// 中止合并或变基，仓库恢复到开始前的状态，已做的冲突解决会丢失。
pub fn abort(state: &WorkspaceState, locks: &GitLocks, id: u64) -> AppResult<()> {
    let root = project_root(state, id)?;
    let info = repository(&root)?;
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    let kind = in_progress(&info, "中止")?;
    let args = if kind == "合并" {
        ["merge", "--abort"]
    } else {
        ["rebase", "--abort"]
    };
    match run(&root, &args, None, ERROR_LIMIT, COMMIT_TIMEOUT) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout(&format!("中止{kind}"))),
        Err(error) => Err(error),
    }
}

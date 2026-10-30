//! 分支与远程：本地与远程分支列表，新建、切换、检出、重命名、删除分支，远程仓库的添加、改地址、重命名、删除，
//! Fetch、Push 和仅快进的 Pull。

use std::{path::Path, time::Duration};

use serde::Serialize;

use super::{
    failure, history::has_commits, lines, project_root, repo_info, run, spawn, write_guard,
    write_timeout, GitLocks, Output, COMMIT_TIMEOUT, ERROR_LIMIT, READ_TIMEOUT,
};
use crate::{
    error::{AppError, AppResult},
    workspace::WorkspaceState,
};

/// 网络操作的超时；超时后结束 Git 进程。
const REMOTE_TIMEOUT: Duration = Duration::from_secs(180);
/// 分支弹窗最多列出的远程分支数，超出时前端提示用搜索缩小范围。
const MAX_REMOTE_BRANCHES: usize = 2_000;

/// 一个本地分支及其上游。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// 上游分支已在远程删除。
    pub gone: bool,
    /// 最新提交时间，Unix 秒。
    pub time: i64,
}

/// 远程仓库；地址中的密码已隐藏。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// 本地记录的远程分支（refs/remotes），获取后更新。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// 显示名，如 origin/feature/x。
    pub name: String,
    pub remote: String,
    /// 远程仓库中的分支名，如 feature/x。
    pub branch: String,
    pub time: i64,
}

/// 当前分支、本地分支、远程分支与远程仓库。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    /// 当前分支；游离 HEAD 时为空，尚无提交的新仓库也会返回分支名。
    pub current: Option<String>,
    pub local: Vec<LocalBranch>,
    pub remote_branches: Vec<RemoteBranch>,
    /// 远程分支过多，只返回了前一部分。
    pub remote_truncated: bool,
    pub remotes: Vec<Remote>,
}

/// Pull 拉取的提交数，0 表示已是最新。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub upstream: String,
    pub commits: u32,
}

/// Push 的目标上游分支。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub upstream: String,
}

pub(super) fn guard(lock: &std::sync::Mutex<()>) -> AppResult<std::sync::MutexGuard<'_, ()>> {
    lock.lock()
        .map_err(|_| AppError::new("GIT", "Git 暂时不可用，请重新启动 Nib。"))
}

pub(super) fn first_line(output: &Output) -> Option<String> {
    output
        .success
        .then(|| lines(&output.stdout).into_iter().next())
        .flatten()
        .filter(|line| !line.is_empty())
}

/// 当前分支名；游离 HEAD 时返回空。
pub(super) fn current_branch(root: &Path) -> AppResult<Option<String>> {
    let output = run(
        root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    Ok(first_line(&output))
}

/// 当前分支的上游（如 origin/main）；未设置时返回空。
fn upstream(root: &Path) -> AppResult<Option<String>> {
    let output = run(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    Ok(first_line(&output))
}

/// 分支配置的上游（branch.<名称>.remote / merge）；上游已在远程删除时 @{upstream} 无法解析，但配置仍在。
fn configured_upstream(root: &Path, branch: &str) -> AppResult<Option<String>> {
    let read = |key: String| -> AppResult<Option<String>> {
        let output = run(
            root,
            &["config", "--get", &key],
            None,
            ERROR_LIMIT,
            READ_TIMEOUT,
        )?;
        Ok(first_line(&output))
    };
    let remote = read(format!("branch.{branch}.remote"))?;
    let merge = read(format!("branch.{branch}.merge"))?;
    Ok(match (remote, merge) {
        (Some(remote), Some(merge)) => Some(format!(
            "{remote}/{}",
            merge.strip_prefix("refs/heads/").unwrap_or(&merge)
        )),
        _ => None,
    })
}

/// 已配置的远程仓库名。
fn remote_names(root: &Path) -> AppResult<Vec<String>> {
    let output = run(root, &["remote"], None, ERROR_LIMIT, READ_TIMEOUT)?;
    if !output.success {
        return Err(failure(&output));
    }
    Ok(lines(&output.stdout)
        .into_iter()
        .filter(|name| !name.is_empty())
        .collect())
}

/// 隐藏地址中的密码或令牌（https://user:token@host → https://user:***@host）。
fn redact(url: &str) -> String {
    let Some(scheme) = url.find("://") else {
        return url.to_owned();
    };
    let start = scheme + 3;
    let authority_end = url[start..]
        .find('/')
        .map_or(url.len(), |index| start + index);
    let Some(at) = url[start..authority_end]
        .rfind('@')
        .map(|index| start + index)
    else {
        return url.to_owned();
    };
    match url[start..at].find(':') {
        Some(colon) => format!("{}:***{}", &url[..start + colon], &url[at..]),
        None => url.to_owned(),
    }
}

/// 解析 `%(upstream:track,nobracket)`，如 "ahead 2, behind 1"、"gone"。
fn track(text: &str) -> (u32, u32, bool) {
    let (mut ahead, mut behind) = (0, 0);
    for part in text.split(", ") {
        if let Some(count) = part.strip_prefix("ahead ") {
            ahead = count.parse().unwrap_or(0);
        } else if let Some(count) = part.strip_prefix("behind ") {
            behind = count.parse().unwrap_or(0);
        }
    }
    (ahead, behind, text == "gone")
}

/// 本地分支（当前分支在前，其余按名称排序）和远程仓库。
pub fn branches(state: &WorkspaceState, id: u64) -> AppResult<Branches> {
    let root = project_root(state, id)?;
    repo_info(&root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    let output = run(
        &root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%1f%(refname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)",
            "refs/heads",
        ],
        None,
        ERROR_LIMIT * 16,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    let mut local = Vec::new();
    for line in lines(&output.stdout) {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        let [head, refname, upstream, tracking, time] = fields.as_slice() else {
            continue;
        };
        let Some(name) = refname.strip_prefix("refs/heads/") else {
            continue;
        };
        let (ahead, behind, gone) = track(tracking);
        local.push(LocalBranch {
            name: name.to_owned(),
            current: *head == "*",
            upstream: (!upstream.is_empty()).then(|| (*upstream).to_owned()),
            ahead,
            behind,
            gone,
            time: time.parse().unwrap_or(0),
        });
    }
    local.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.cmp(&b.name)));
    let output = run(&root, &["remote", "-v"], None, ERROR_LIMIT, READ_TIMEOUT)?;
    if !output.success {
        return Err(failure(&output));
    }
    let mut remotes: Vec<Remote> = Vec::new();
    for line in lines(&output.stdout) {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let Some(url) = rest.strip_suffix(" (fetch)") else {
            continue;
        };
        if !remotes.iter().any(|remote| remote.name == name) {
            remotes.push(Remote {
                name: name.to_owned(),
                url: redact(url),
            });
        }
    }
    let output = run(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(symref)%1f%(committerdate:unix)",
            "refs/remotes",
        ],
        None,
        ERROR_LIMIT * 16,
        READ_TIMEOUT,
    )?;
    if !output.success {
        return Err(failure(&output));
    }
    let mut remote_branches = Vec::new();
    let mut remote_truncated = output.truncated;
    for line in lines(&output.stdout) {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        let [refname, symref, time] = fields.as_slice() else {
            continue;
        };
        // origin/HEAD 是指向默认分支的别名，不单独列出。
        let Some(name) = refname.strip_prefix("refs/remotes/") else {
            continue;
        };
        if !symref.is_empty() {
            continue;
        }
        // 远程名可能含 /，按已配置的远程中最长的前缀匹配；已删除远程的残留记录不列出。
        let Some(remote) = remotes
            .iter()
            .filter(|remote| name.starts_with(&format!("{}/", remote.name)))
            .max_by_key(|remote| remote.name.len())
        else {
            continue;
        };
        if remote_branches.len() >= MAX_REMOTE_BRANCHES {
            remote_truncated = true;
            break;
        }
        remote_branches.push(RemoteBranch {
            name: name.to_owned(),
            remote: remote.name.clone(),
            branch: name[remote.name.len() + 1..].to_owned(),
            time: time.parse().unwrap_or(0),
        });
    }
    Ok(Branches {
        current: current_branch(&root)?,
        local,
        remote_branches,
        remote_truncated,
        remotes,
    })
}

/// 校验新分支名：不能以 - 开头，并须符合 Git 的引用命名规则。
fn branch_name<'a>(root: &Path, name: &'a str) -> AppResult<&'a str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new("BRANCH", "请输入分支名。"));
    }
    let invalid = name.starts_with('-')
        || name.chars().any(char::is_control)
        || !run(
            root,
            &["check-ref-format", &format!("refs/heads/{name}")],
            None,
            ERROR_LIMIT,
            READ_TIMEOUT,
        )?
        .success;
    if invalid {
        return Err(AppError::new(
            "BRANCH",
            "分支名不符合 Git 的命名规则（不能含空格、~ ^ : ? * [ \\、连续的点，不能以 - 或 / 开头）。",
        ));
    }
    Ok(name)
}

fn branch_exists(root: &Path, name: &str) -> AppResult<bool> {
    ref_exists(root, &format!("refs/heads/{name}"))
}

/// 完整引用名（refs/...）是否存在。
pub(super) fn ref_exists(root: &Path, refname: &str) -> AppResult<bool> {
    if refname.starts_with('-') || refname.chars().any(char::is_control) {
        return Ok(false);
    }
    Ok(run(
        root,
        &["show-ref", "--verify", "--quiet", refname],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?
    .success)
}

/// 新分支的起点：本地分支或远程分支的完整引用名；为空时从当前 HEAD 开始。
fn start_point(root: &Path, start: Option<&str>) -> AppResult<Option<String>> {
    let Some(start) = start else {
        return Ok(None);
    };
    let valid = (start.starts_with("refs/heads/") || start.starts_with("refs/remotes/"))
        && ref_exists(root, start)?;
    if !valid {
        return Err(AppError::new(
            "BRANCH",
            "起点分支不存在，请刷新分支列表后重试。",
        ));
    }
    Ok(Some(start.to_owned()))
}

/// 执行会写入仓库的本地命令；超时后结果未知，不重试。
fn local_write(root: &Path, args: &[&str], action: &str) -> AppResult<()> {
    match run(root, args, None, ERROR_LIMIT, COMMIT_TIMEOUT) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout(action)),
        Err(error) => Err(error),
    }
}

/// 新建本地分支并切换过去；返回分支名。
///
/// start 为空时从当前 HEAD 新建，不改动工作区文件；指定起点（本地或远程分支的完整引用名）时
/// 工作区切换到起点，未提交的修改冲突时由 Git 拒绝。从远程分支新建时不设置上游。
pub fn create_branch(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
    start: Option<&str>,
) -> AppResult<String> {
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "新建分支")?;
    let _guard = guard(&lock)?;
    let name = branch_name(&root, name)?;
    if !has_commits(&root)? {
        return Err(AppError::new(
            "BRANCH",
            "仓库还没有提交，请先提交一次再新建分支。",
        ));
    }
    if branch_exists(&root, name)? {
        return Err(AppError::new("BRANCH", format!("分支 {name} 已存在。")));
    }
    match start_point(&root, start)? {
        Some(start) => local_write(
            &root,
            &["switch", "--no-track", "--create", name, &start],
            "新建分支",
        )?,
        None => local_write(&root, &["switch", "--create", name], "新建分支")?,
    }
    Ok(name.to_owned())
}

/// 切换到已有的本地分支；未提交的变更与目标分支冲突时由 Git 拒绝，不会覆盖。
pub fn switch_branch(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
) -> AppResult<()> {
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "切换分支")?;
    let _guard = guard(&lock)?;
    if name.starts_with('-') || !branch_exists(&root, name)? {
        return Err(AppError::new(
            "BRANCH",
            format!("本地分支 {name} 不存在，请刷新分支列表。"),
        ));
    }
    if current_branch(&root)?.as_deref() == Some(name) {
        return Ok(());
    }
    // --no-guess：只切换本地分支，不按远程分支自动新建。
    local_write(&root, &["switch", "--no-guess", name], "切换分支")
}

/// 检出远程分支：新建同名本地分支跟踪它并切换过去，返回本地分支名。
///
/// 同名本地分支已存在且跟踪该远程分支时直接切换；跟踪其他分支时拒绝，请改用“从此分支新建”。
pub fn checkout_remote(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    remote: &str,
    branch: &str,
) -> AppResult<String> {
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "检出分支")?;
    let _guard = guard(&lock)?;
    if !remote_names(&root)?.iter().any(|name| name == remote) {
        return Err(AppError::new(
            "BRANCH",
            format!("远程仓库 {remote} 不存在。"),
        ));
    }
    let refname = format!("refs/remotes/{remote}/{branch}");
    if branch.is_empty() || !ref_exists(&root, &refname)? {
        return Err(AppError::new(
            "BRANCH",
            format!("远程分支 {remote}/{branch} 不存在，请先获取（Fetch）。"),
        ));
    }
    let local = branch_name(&root, branch)?;
    if branch_exists(&root, local)? {
        let output = run(
            &root,
            &[
                "for-each-ref",
                "--format=%(upstream)",
                &format!("refs/heads/{local}"),
            ],
            None,
            ERROR_LIMIT,
            READ_TIMEOUT,
        )?;
        if first_line(&output).as_deref() != Some(refname.as_str()) {
            return Err(AppError::new(
                "BRANCH",
                format!("本地已有分支 {local}，且未跟踪 {remote}/{branch}。可在该远程分支上选择“从此分支新建”，使用其他名称。"),
            ));
        }
        if current_branch(&root)?.as_deref() != Some(local) {
            local_write(&root, &["switch", "--no-guess", local], "检出分支")?;
        }
        return Ok(local.to_owned());
    }
    local_write(
        &root,
        &["switch", "--track", "--create", local, &refname],
        "检出分支",
    )?;
    Ok(local.to_owned())
}

/// 重命名本地分支（git branch -m），上游配置随之保留；目标名已存在时拒绝。
pub fn rename_branch(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
    target: &str,
) -> AppResult<String> {
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "重命名分支")?;
    let _guard = guard(&lock)?;
    if name.starts_with('-') || !branch_exists(&root, name)? {
        return Err(AppError::new(
            "BRANCH",
            format!("本地分支 {name} 不存在，请刷新分支列表。"),
        ));
    }
    let target = branch_name(&root, target)?;
    if target == name {
        return Ok(target.to_owned());
    }
    if branch_exists(&root, target)? {
        return Err(AppError::new("BRANCH", format!("分支 {target} 已存在。")));
    }
    local_write(&root, &["branch", "--move", name, target], "重命名分支")?;
    Ok(target.to_owned())
}

/// 删除本地分支。默认只删除已合并的分支，未合并时返回 NOT_MERGED，由用户确认后 force 删除；不能删除当前分支。
pub fn delete_branch(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
    force: bool,
) -> AppResult<()> {
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "删除分支")?;
    let _guard = guard(&lock)?;
    if name.starts_with('-') || !branch_exists(&root, name)? {
        return Err(AppError::new(
            "BRANCH",
            format!("本地分支 {name} 不存在，请刷新分支列表。"),
        ));
    }
    if current_branch(&root)?.as_deref() == Some(name) {
        return Err(AppError::new(
            "BRANCH",
            "不能删除当前分支，请先切换到其他分支。",
        ));
    }
    let flag = if force { "-D" } else { "-d" };
    // 英文输出用于识别“未合并”，删除分支不运行钩子。
    match spawn(
        &root,
        &["branch", flag, name],
        None,
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
        true,
    ) {
        Ok(output) if output.success => Ok(()),
        Ok(output) if String::from_utf8_lossy(&output.stderr).contains("not fully merged") => {
            Err(AppError::new(
                "NOT_MERGED",
                format!("分支 {name} 有尚未合并到当前分支或其上游的提交，删除后这些提交只能通过 reflog 找回。"),
            ))
        }
        Ok(output) => Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout("删除分支")),
        Err(error) => Err(error),
    }
}

/// 删除远程仓库中的分支（git push <远程> --delete <分支>），同时移除本地的远程分支记录。
pub fn delete_remote_branch(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    remote: &str,
    branch: &str,
) -> AppResult<()> {
    let root = project_root(state, id)?;
    let info = repo_info(&root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    if !remote_names(&root)?.iter().any(|name| name == remote)
        || branch.is_empty()
        || !ref_exists(&root, &format!("refs/remotes/{remote}/{branch}"))?
    {
        return Err(AppError::new(
            "BRANCH",
            format!("远程分支 {remote}/{branch} 不存在，请刷新分支列表。"),
        ));
    }
    let target = format!("refs/heads/{branch}");
    // 推送会运行 pre-push 钩子，保持用户的语言环境。
    let output = remote_run(
        &root,
        &["push", "--quiet", remote, "--delete", &target],
        false,
        Some("删除远程分支"),
    )?;
    if !output.success {
        return Err(remote_failure(&output));
    }
    Ok(())
}

/// 校验远程仓库名：规则与 Git 一致（refs/remotes/<名称>/x 须是合法引用），不能以 - 开头。
fn remote_name<'a>(root: &Path, name: &'a str) -> AppResult<&'a str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new("REMOTE", "请输入远程仓库名。"));
    }
    let invalid = name.starts_with('-')
        || name.chars().any(char::is_control)
        || !run(
            root,
            &["check-ref-format", &format!("refs/remotes/{name}/x")],
            None,
            ERROR_LIMIT,
            READ_TIMEOUT,
        )?
        .success;
    if invalid {
        return Err(AppError::new(
            "REMOTE",
            "远程仓库名不符合 Git 的命名规则（不能含空格、~ ^ : ? * [ \\、连续的点，不能以 - 开头）。",
        ));
    }
    Ok(name)
}

/// 校验远程仓库地址；列表中显示的地址隐藏了密码，不能原样写回。
fn remote_url(url: &str) -> AppResult<&str> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::new("REMOTE", "请输入远程仓库地址。"));
    }
    if url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(AppError::new(
            "REMOTE",
            "远程仓库地址不能以 - 开头，也不能包含换行等控制字符。",
        ));
    }
    if url.contains("://") && url.contains(":***@") {
        return Err(AppError::new(
            "REMOTE",
            "地址中的密码已隐藏为 ***，请输入完整的密码或令牌，或改用不含密码的地址（配合凭据助手）。",
        ));
    }
    Ok(url)
}

/// 已配置的远程仓库中是否有该名称，没有时返回错误。
fn existing_remote(root: &Path, name: &str) -> AppResult<()> {
    if remote_names(root)?.iter().any(|item| item == name) {
        return Ok(());
    }
    Err(AppError::new(
        "REMOTE",
        format!("远程仓库 {name} 不存在，请刷新后重试。"),
    ))
}

/// 获取远程仓库锁；配置远程不受进行中的合并或变基影响，只与同仓库的其他操作串行。
fn remote_guard(root: &Path, locks: &GitLocks) -> AppResult<std::sync::Arc<std::sync::Mutex<()>>> {
    let info = repo_info(root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    locks.get(&info.top)
}

/// 添加远程仓库（git remote add），只写配置，不连接远程；返回远程仓库名。
pub fn add_remote(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
    url: &str,
) -> AppResult<String> {
    let root = project_root(state, id)?;
    let lock = remote_guard(&root, locks)?;
    let _guard = guard(&lock)?;
    let name = remote_name(&root, name)?;
    let url = remote_url(url)?;
    if remote_names(&root)?.iter().any(|item| item == name) {
        return Err(AppError::new("REMOTE", format!("远程仓库 {name} 已存在。")));
    }
    local_write(&root, &["remote", "add", "--", name, url], "添加远程仓库")?;
    Ok(name.to_owned())
}

/// 修改远程仓库的地址（git remote set-url）；单独配置的推送地址（pushurl）保持不变。
pub fn set_remote_url(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
    url: &str,
) -> AppResult<()> {
    let root = project_root(state, id)?;
    let lock = remote_guard(&root, locks)?;
    let _guard = guard(&lock)?;
    existing_remote(&root, name)?;
    let url = remote_url(url)?;
    local_write(
        &root,
        &["remote", "set-url", "--", name, url],
        "修改远程仓库地址",
    )
}

/// 重命名远程仓库（git remote rename），远程分支记录和本地分支的上游配置随之改名；返回新名称。
pub fn rename_remote(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
    target: &str,
) -> AppResult<String> {
    let root = project_root(state, id)?;
    let lock = remote_guard(&root, locks)?;
    let _guard = guard(&lock)?;
    existing_remote(&root, name)?;
    let target = remote_name(&root, target)?;
    if target == name {
        return Ok(target.to_owned());
    }
    if remote_names(&root)?.iter().any(|item| item == target) {
        return Err(AppError::new(
            "REMOTE",
            format!("远程仓库 {target} 已存在。"),
        ));
    }
    local_write(
        &root,
        &["remote", "rename", "--", name, target],
        "重命名远程仓库",
    )?;
    Ok(target.to_owned())
}

/// 删除远程仓库配置（git remote remove）及本地的远程分支记录，跟踪它的本地分支失去上游；远程服务器不受影响。
pub fn remove_remote(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    name: &str,
) -> AppResult<()> {
    let root = project_root(state, id)?;
    let lock = remote_guard(&root, locks)?;
    let _guard = guard(&lock)?;
    existing_remote(&root, name)?;
    local_write(&root, &["remote", "remove", "--", name], "删除远程仓库")
}

/// 网络操作的错误说明：常见的认证、主机密钥和网络问题附加处理建议。
fn remote_failure(output: &Output) -> AppError {
    let error = failure(output);
    let text = String::from_utf8_lossy(&output.stderr);
    let hint = if text.contains("Permission denied (publickey")
        || text.contains("terminal prompts disabled")
        || text.contains("Authentication failed")
        || text.contains("could not read Username")
        || text.contains("could not read Password")
    {
        Some("认证失败。Nib 不会弹出密码输入，请先在终端执行一次该操作完成认证（如配置 SSH 密钥或凭据助手），再回来重试。")
    } else if text.contains("Host key verification failed") {
        Some("无法确认远程主机的密钥。请先在终端连接一次该主机并确认密钥后重试。")
    } else if text.contains("Could not resolve host")
        || text.contains("Could not resolve hostname")
        || text.contains("Connection refused")
        || text.contains("timed out")
        || text.contains("Network is unreachable")
    {
        Some("无法连接远程仓库，请检查网络或远程地址。")
    } else {
        None
    };
    match hint {
        Some(hint) => AppError::new(error.code, format!("{hint}\n{}", error.message)),
        None => error,
    }
}

/// 执行网络操作：禁止交互式认证；english 为真时使用英文输出，便于识别错误。
///
/// writes 为真表示超时后远程或本地状态可能已改变，结果未知，不能自动重试。
fn remote_run(
    root: &Path,
    args: &[&str],
    english: bool,
    writes: Option<&str>,
) -> AppResult<Output> {
    let mut full = vec!["-c", "credential.interactive=never"];
    full.extend_from_slice(args);
    match spawn(root, &full, None, ERROR_LIMIT, REMOTE_TIMEOUT, english) {
        Err(error) if error.code == "GIT_TIMEOUT" => Err(match writes {
            Some(action) => AppError::new(
                "GIT_TIMEOUT",
                format!(
                    "{action}超过 {} 秒未完成，已停止等待。结果未知，请刷新后检查分支状态，不要直接重复操作。",
                    REMOTE_TIMEOUT.as_secs()
                ),
            ),
            None => AppError::new(
                "GIT_TIMEOUT",
                format!(
                    "连接远程仓库超过 {} 秒未完成，已停止。请检查网络后重试。",
                    REMOTE_TIMEOUT.as_secs()
                ),
            ),
        }),
        result => result,
    }
}

/// 从所有远程仓库获取更新，只更新远程分支，不改动本地分支和工作区。
pub fn fetch(state: &WorkspaceState, locks: &GitLocks, id: u64) -> AppResult<()> {
    let root = project_root(state, id)?;
    let info = repo_info(&root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    if remote_names(&root)?.is_empty() {
        return Err(AppError::new(
            "REMOTE",
            "仓库没有配置远程仓库，可在分支弹窗的“远程仓库”中添加。",
        ));
    }
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    let output = remote_run(&root, &["fetch", "--all", "--quiet"], true, None)?;
    if !output.success {
        return Err(remote_failure(&output));
    }
    Ok(())
}

/// 提交是否是另一个提交的祖先（含相同）。
pub(super) fn is_ancestor(root: &Path, ancestor: &str, descendant: &str) -> AppResult<bool> {
    Ok(run(
        root,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?
    .success)
}

/// HEAD 与上游各自独有的提交数。
fn ahead_behind(root: &Path) -> AppResult<(u32, u32)> {
    let output = run(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        None,
        ERROR_LIMIT,
        READ_TIMEOUT,
    )?;
    let line = first_line(&output).unwrap_or_default();
    let mut counts = line
        .split_whitespace()
        .map(|count| count.parse().unwrap_or(0));
    Ok((counts.next().unwrap_or(0), counts.next().unwrap_or(0)))
}

/// 获取当前分支的上游并仅快进更新；本地与上游分叉时不合并，说明原因。
pub fn pull(state: &WorkspaceState, locks: &GitLocks, id: u64) -> AppResult<PullResult> {
    let root = project_root(state, id)?;
    let (_, lock) = write_guard(&root, locks, "拉取")?;
    let _guard = guard(&lock)?;
    let Some(branch) = current_branch(&root)? else {
        return Err(AppError::new(
            "PULL",
            "当前处于游离 HEAD，没有可拉取的分支。请先切换到一个本地分支。",
        ));
    };
    let Some(target) = upstream(&root)? else {
        return Err(AppError::new(
            "PULL",
            format!("分支 {branch} 没有设置上游分支，无法拉取。可先推送并设置上游。"),
        ));
    };
    let remote = target.split('/').next().unwrap_or_default().to_owned();
    if remote_names(&root)?.contains(&remote) {
        let output = remote_run(&root, &["fetch", "--quiet", &remote], true, None)?;
        if !output.success {
            return Err(remote_failure(&output));
        }
    }
    if upstream(&root)?.is_none() {
        return Err(AppError::new(
            "PULL",
            format!("上游分支 {target} 已不存在（可能已在远程删除）。"),
        ));
    }
    if is_ancestor(&root, "@{upstream}", "HEAD")? {
        return Ok(PullResult {
            upstream: target,
            commits: 0,
        });
    }
    if !is_ancestor(&root, "HEAD", "@{upstream}")? {
        let (ahead, behind) = ahead_behind(&root)?;
        return Err(AppError::new(
            "PULL",
            format!(
                "本地分支与 {target} 已分叉（本地独有 {ahead} 个提交，远程独有 {behind} 个），无法快进。可在分支弹窗中把 {target} 合并到当前分支，或把当前分支变基到 {target}。"
            ),
        ));
    }
    let (_, commits) = ahead_behind(&root)?;
    // 只快进；工作区中未提交的修改与更新冲突时由 Git 拒绝，不会覆盖。
    match spawn(
        &root,
        &[
            "merge",
            "--ff-only",
            "--no-autostash",
            "--quiet",
            "@{upstream}",
        ],
        None,
        ERROR_LIMIT,
        COMMIT_TIMEOUT,
        false,
    ) {
        Ok(output) if output.success => Ok(PullResult {
            upstream: target,
            commits,
        }),
        Ok(output) => Err(failure(&output)),
        Err(error) if error.code == "GIT_TIMEOUT" => Err(write_timeout("拉取")),
        Err(error) => Err(error),
    }
}

/// 推送当前分支。已有上游时按 Git 配置推送；否则推送到 remote 并设为上游。
pub fn push(
    state: &WorkspaceState,
    locks: &GitLocks,
    id: u64,
    remote: Option<&str>,
) -> AppResult<PushResult> {
    let root = project_root(state, id)?;
    let info = repo_info(&root)?.ok_or_else(|| AppError::new("GIT", "项目不在 Git 仓库内。"))?;
    let lock = locks.get(&info.top)?;
    let _guard = guard(&lock)?;
    let Some(branch) = current_branch(&root)? else {
        return Err(AppError::new(
            "PUSH",
            "当前处于游离 HEAD，没有可推送的分支。请先切换到一个本地分支。",
        ));
    };
    if !has_commits(&root)? {
        return Err(AppError::new("PUSH", "仓库还没有提交，没有可推送的内容。"));
    }
    let existing = match upstream(&root)? {
        Some(target) => Some(target),
        // 上游已在远程删除：按原配置推送，重新建立远程分支。
        None => configured_upstream(&root, &branch)?,
    };
    let (args, target) = match (&existing, remote) {
        (Some(target), _) => (vec!["push", "--quiet"], target.clone()),
        (None, Some(remote)) => {
            if !remote_names(&root)?.iter().any(|name| name == remote) {
                return Err(AppError::new("PUSH", format!("远程仓库 {remote} 不存在。")));
            }
            (
                vec!["push", "--quiet", "--set-upstream"],
                format!("{remote}/{branch}"),
            )
        }
        (None, None) => {
            return Err(AppError::new(
                "NO_UPSTREAM",
                format!("分支 {branch} 没有设置上游分支，请选择要推送到的远程仓库。"),
            ))
        }
    };
    let refspec = format!("HEAD:refs/heads/{branch}");
    let mut args = args;
    if let (None, Some(remote)) = (&existing, remote) {
        args.extend([remote, refspec.as_str()]);
    }
    // 推送会运行 pre-push 钩子，保持用户的语言环境。
    let output = remote_run(&root, &args, false, Some("推送"))?;
    if !output.success {
        let text = String::from_utf8_lossy(&output.stderr);
        if text.contains("[rejected]") || text.contains("non-fast-forward") {
            let error = failure(&output);
            return Err(AppError::new(
                "PUSH",
                format!(
                    "远程分支有本地没有的提交，推送被拒绝。请先拉取（仅快进）；分叉时可在分支弹窗中合并上游分支。Nib 不提供强制推送，变基过已推送的提交后无法推送。\n{}",
                    error.message
                ),
            ));
        }
        return Err(remote_failure(&output));
    }
    Ok(PushResult { upstream: target })
}

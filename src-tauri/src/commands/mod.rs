use std::{path::Path, sync::Arc};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    error::{AppError, AppResult},
    filesystem::{self, Directory, Document},
    git::{
        self, Branches, CommitDetail, CommitResult, DiffSources, GitLocks, GitStatus, Integration,
        LogPage, Outgoing, PullResult, PushResult, Side,
    },
    recovery::{RecoveryEntry, RecoveryStore},
    search::{self, FileList, SearchOptions, SearchResult, Searches},
    session::{Layout, ProjectTabs, SessionStore},
    settings::{
        fonts::{self, FontFamily},
        Settings, SettingsStore,
    },
    watcher::Watchers,
    window,
    workspace::{self, Project, Workspaces},
};

/// 在当前窗口打开项目的结果。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenResult {
    /// 已在当前窗口打开，附带上次的标签；会话记录写入失败时附带说明。
    Opened {
        project: Project,
        tabs: ProjectTabs,
        warning: Option<String>,
    },
    /// 项目已在其他窗口打开，已切换到该窗口。
    Focused,
}

/// 最近项目及其目录当前是否仍可访问。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub root: String,
    pub name: String,
    pub available: bool,
}

/// 磁盘任务统一进入阻塞线程池，避免阻塞窗口事件循环。
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| AppError::new("TASK", "后台任务意外中止，请重试。"))?
}

#[tauri::command]
/// 返回窗口创建时指定的项目；页面重新加载时返回窗口当前项目。
pub async fn window_startup(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
) -> AppResult<Option<String>> {
    let workspaces = workspaces.inner().clone();
    let label = window.label().to_owned();
    blocking(move || workspaces.startup(&label)).await
}

#[tauri::command]
/// 在当前窗口打开项目；项目已在其他窗口打开时切换到该窗口。
pub async fn open_project(
    app: AppHandle,
    workspaces: State<'_, Workspaces>,
    sessions: State<'_, Arc<SessionStore>>,
    watchers: State<'_, Watchers>,
    window: WebviewWindow,
    path: String,
) -> AppResult<OpenResult> {
    let workspaces = workspaces.inner().clone();
    let sessions = sessions.inner().clone();
    let watchers = watchers.inner().clone();
    let label = window.label().to_owned();
    let handle = app.clone();
    let (result, other) = blocking(move || {
        let (root, root_text) = workspace::canonical_root(&path)?;
        if let Some(other) = workspaces.find(&root)?.filter(|other| *other != label) {
            return Ok((OpenResult::Focused, Some(other)));
        }
        let state = workspaces.get(&label)?;
        let previous = state.lock()?.current_root();
        let project = workspace::open(&state, root.clone(), root_text)?;
        // 项目已切换，会话记录与监听失败只影响恢复和实时刷新，不回滚打开操作。
        let mut warnings = Vec::new();
        if let Some(Err(error)) = previous
            .filter(|previous| *previous != project.root)
            .map(|previous| sessions.closed(&previous))
        {
            warnings.push(format!("最近项目记录保存失败：{}", error.message));
        }
        if let Err(error) = sessions.opened(&project.root, &project.name) {
            warnings.push(format!("最近项目记录保存失败：{}", error.message));
        }
        watchers.stop(&label);
        if let Err(error) = watchers.watch(&handle, &label, project.id, &root) {
            warnings.push(format!("{}外部修改不会自动刷新。", error.message));
        }
        let tabs = sessions.tabs(&project.root)?;
        Ok((
            OpenResult::Opened {
                project,
                tabs,
                warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
            },
            None,
        ))
    })
    .await?;
    if let Some(other) = other {
        window::focus(&app, &other)?;
    }
    Ok(result)
}

#[tauri::command]
/// 在新窗口打开项目；项目已打开时切换到对应窗口。
pub async fn open_project_window(
    app: AppHandle,
    workspaces: State<'_, Workspaces>,
    path: String,
) -> AppResult<()> {
    let registry = workspaces.inner().clone();
    let (existing, root) = blocking(move || {
        let (root, root_text) = workspace::canonical_root(&path)?;
        Ok((registry.find(&root)?, root_text))
    })
    .await?;
    match existing {
        Some(label) => window::focus(&app, &label),
        None => window::create(&app, Some(root)),
    }
}

#[tauri::command]
/// 打开一个未加载项目的新窗口。
pub async fn new_window(app: AppHandle) -> AppResult<()> {
    window::create(&app, None)
}

#[tauri::command]
/// 关闭当前窗口的项目，下次启动不再恢复。
pub async fn close_project(
    workspaces: State<'_, Workspaces>,
    sessions: State<'_, Arc<SessionStore>>,
    watchers: State<'_, Watchers>,
    window: WebviewWindow,
) -> AppResult<()> {
    let workspaces = workspaces.inner().clone();
    let sessions = sessions.inner().clone();
    let watchers = watchers.inner().clone();
    let label = window.label().to_owned();
    blocking(move || {
        watchers.stop(&label);
        let state = workspaces.get(&label)?;
        match workspace::close(&state)? {
            Some(root) => sessions.closed(&root),
            None => Ok(()),
        }
    })
    .await
}

#[tauri::command]
/// 返回最近项目，并检查各项目目录是否仍然存在。
pub async fn recent_projects(
    sessions: State<'_, Arc<SessionStore>>,
) -> AppResult<Vec<RecentEntry>> {
    let sessions = sessions.inner().clone();
    blocking(move || {
        Ok(sessions
            .recent()?
            .into_iter()
            .map(|item| RecentEntry {
                available: Path::new(&item.root).is_dir(),
                root: item.root,
                name: item.name,
            })
            .collect())
    })
    .await
}

#[tauri::command]
/// 从最近项目中移除，不删除任何项目文件。
pub async fn forget_project(sessions: State<'_, Arc<SessionStore>>, root: String) -> AppResult<()> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.forget(&root)).await
}

#[tauri::command]
/// 记录当前项目打开的标签，供下次打开项目时恢复。
pub async fn save_tabs(
    workspaces: State<'_, Workspaces>,
    sessions: State<'_, Arc<SessionStore>>,
    window: WebviewWindow,
    project_id: u64,
    tabs: Vec<String>,
    active: Option<String>,
) -> AppResult<()> {
    let workspaces = workspaces.inner().clone();
    let sessions = sessions.inner().clone();
    let label = window.label().to_owned();
    blocking(move || {
        let root = workspaces.get(&label)?.lock()?.root_text(project_id)?;
        sessions.save_tabs(&root, tabs, active)
    })
    .await
}

#[tauri::command]
/// 记录当前项目文件树展开的目录，供下次打开项目时恢复。
pub async fn save_expanded(
    workspaces: State<'_, Workspaces>,
    sessions: State<'_, Arc<SessionStore>>,
    window: WebviewWindow,
    project_id: u64,
    expanded: Vec<String>,
) -> AppResult<()> {
    let workspaces = workspaces.inner().clone();
    let sessions = sessions.inner().clone();
    let label = window.label().to_owned();
    blocking(move || {
        let root = workspaces.get(&label)?.lock()?.root_text(project_id)?;
        sessions.save_expanded(&root, expanded)
    })
    .await
}

#[tauri::command]
/// 用户取消退出后恢复正常关闭语义，并按仍打开的窗口校正恢复列表。
pub async fn cancel_quit(
    workspaces: State<'_, Workspaces>,
    sessions: State<'_, Arc<SessionStore>>,
) -> AppResult<()> {
    let workspaces = workspaces.inner().clone();
    let sessions = sessions.inner().clone();
    blocking(move || {
        sessions.set_quitting(false);
        sessions.retain_open(&workspaces.roots()?)
    })
    .await
}

#[tauri::command]
/// 只枚举指定层级，避免打开项目时扫描整棵目录树。
pub async fn list_directory(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
) -> AppResult<Directory> {
    let state = workspaces.get(window.label())?;
    blocking(move || filesystem::list(&state, project_id, &path)).await
}

#[tauri::command]
/// 校验工作区和文件类型后返回文本及磁盘版本。
pub async fn read_file(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
) -> AppResult<Document> {
    let state = workspaces.get(window.label())?;
    blocking(move || filesystem::read(&state, project_id, &path)).await
}

#[tauri::command]
/// 在目录下新建空文件或目录，返回新条目的路径。
pub async fn create_entry(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    parent: String,
    name: String,
    directory: bool,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    blocking(move || filesystem::create(&state, project_id, &parent, &name, directory)).await
}

#[tauri::command]
/// 重命名文件或目录，返回新路径；已跟踪的条目使用 git mv。
pub async fn rename_entry(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
    name: String,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::rename(&state, &locks, project_id, &path, &name)).await
}

#[tauri::command]
/// 将文件或目录移到系统废纸篓。
pub async fn trash_entry(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    blocking(move || filesystem::trash(&state, project_id, &path)).await
}

#[tauri::command]
/// 在系统文件管理器中显示条目；路径为空时显示项目根目录。
pub async fn reveal_entry(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    blocking(move || filesystem::reveal(&state, project_id, &path)).await
}

#[tauri::command]
/// 回滚文件的 Git 变更：修改与删除恢复为 HEAD，新增取消加入版本控制。
pub async fn git_rollback(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    paths: Vec<String>,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::revert(&state, &locks, project_id, &paths)).await
}

#[tauri::command]
/// 把未跟踪的文件或目录写入项目根目录的 .gitignore。
pub async fn git_ignore(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    paths: Vec<String>,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::ignore(&state, &locks, project_id, &paths)).await
}

#[tauri::command]
/// 读取项目所属仓库的分支和变更。
pub async fn git_status(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<GitStatus> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::status(&state, project_id)).await
}

#[tauri::command]
/// 返回文件 HEAD 版本与工作区版本，供 Diff 视图比较。
pub async fn git_diff(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
    original: Option<String>,
) -> AppResult<DiffSources> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::diff(&state, project_id, &path, original.as_deref())).await
}

#[tauri::command]
/// 返回文件的 HEAD 版本，供编辑器行号旁的变更标记比较。
pub async fn git_head_file(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
) -> AppResult<Side> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::head_file(&state, project_id, &path)).await
}

#[tauri::command]
/// 只提交勾选的文件；未跟踪文件随提交一并加入版本库。
pub async fn git_commit(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    message: String,
    paths: Vec<String>,
    untracked: Vec<String>,
) -> AppResult<CommitResult> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::commit(&state, &locks, project_id, &message, &paths, &untracked)).await
}

#[tauri::command]
/// 将未跟踪文件加入版本控制，不提交。
pub async fn git_add(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    paths: Vec<String>,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::add(&state, &locks, project_id, &paths)).await
}

#[tauri::command]
/// 从 HEAD 恢复工作区中已删除的文件。
pub async fn git_restore(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::restore(&state, &locks, project_id, &path)).await
}

#[tauri::command]
/// 按读取时的磁盘版本保存，冲突时保留原文件。
pub async fn save_file(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
    content: String,
    expected_revision: String,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    blocking(move || filesystem::save(&state, project_id, &path, &content, &expected_revision))
        .await
}

#[tauri::command]
/// 当前分支的一页提交记录；skip 为已加载的提交数。
pub async fn git_log(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    skip: usize,
) -> AppResult<LogPage> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::log(&state, project_id, skip)).await
}

#[tauri::command]
/// 提交的完整信息与变更文件。
pub async fn git_commit_detail(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    commit: String,
) -> AppResult<CommitDetail> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::commit_detail(&state, project_id, &commit)).await
}

#[tauri::command]
/// 提交中一个文件相对第一个父提交的两侧内容。
pub async fn git_commit_diff(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    commit: String,
    path: String,
    original: Option<String>,
) -> AppResult<DiffSources> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::commit_diff(&state, project_id, &commit, &path, original.as_deref()))
        .await
}

#[tauri::command]
/// 本地分支与远程仓库。
pub async fn git_branches(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<Branches> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::branches(&state, project_id)).await
}

#[tauri::command]
/// 新建分支并切换过去；start 为起点分支的完整引用名，为空时从当前 HEAD 新建。返回分支名。
pub async fn git_create_branch(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
    start: Option<String>,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::create_branch(&state, &locks, project_id, &name, start.as_deref())).await
}

#[tauri::command]
/// 检出远程分支为跟踪它的本地分支；返回本地分支名。
pub async fn git_checkout_remote(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    remote: String,
    branch: String,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::checkout_remote(&state, &locks, project_id, &remote, &branch)).await
}

#[tauri::command]
/// 重命名本地分支；返回新名称。
pub async fn git_rename_branch(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
    target: String,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::rename_branch(&state, &locks, project_id, &name, &target)).await
}

#[tauri::command]
/// 删除本地分支；force 为真时删除未合并的分支。
pub async fn git_delete_branch(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
    force: bool,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::delete_branch(&state, &locks, project_id, &name, force)).await
}

#[tauri::command]
/// 删除远程仓库中的分支。
pub async fn git_delete_remote_branch(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    remote: String,
    branch: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::delete_remote_branch(&state, &locks, project_id, &remote, &branch)).await
}

#[tauri::command]
/// 添加远程仓库；返回远程仓库名。
pub async fn git_add_remote(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
    url: String,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::add_remote(&state, &locks, project_id, &name, &url)).await
}

#[tauri::command]
/// 修改远程仓库地址。
pub async fn git_set_remote_url(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
    url: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::set_remote_url(&state, &locks, project_id, &name, &url)).await
}

#[tauri::command]
/// 重命名远程仓库；返回新名称。
pub async fn git_rename_remote(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
    target: String,
) -> AppResult<String> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::rename_remote(&state, &locks, project_id, &name, &target)).await
}

#[tauri::command]
/// 删除远程仓库配置。
pub async fn git_remove_remote(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::remove_remote(&state, &locks, project_id, &name)).await
}

#[tauri::command]
/// 切换到已有的本地分支。
pub async fn git_switch_branch(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    name: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::switch_branch(&state, &locks, project_id, &name)).await
}

#[tauri::command]
/// 从所有远程仓库获取更新。
pub async fn git_fetch(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::fetch(&state, &locks, project_id)).await
}

#[tauri::command]
/// 拉取当前分支的上游，仅快进。
pub async fn git_pull(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<PullResult> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::pull(&state, &locks, project_id)).await
}

#[tauri::command]
/// 推送当前分支；没有上游时推送到 remote 并设为上游。head 为确认时的 HEAD 提交，已变化时拒绝。
pub async fn git_push(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    remote: Option<String>,
    head: Option<String>,
) -> AppResult<PushResult> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || {
        git::push(
            &state,
            &locks,
            project_id,
            remote.as_deref(),
            head.as_deref(),
        )
    })
    .await
}

#[tauri::command]
/// 推送前预览当前分支要推送的提交；没有上游时按 remote 计算。
pub async fn git_outgoing(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
    remote: Option<String>,
) -> AppResult<Outgoing> {
    let state = workspaces.get(window.label())?;
    blocking(move || git::outgoing(&state, project_id, remote.as_deref())).await
}

#[tauri::command]
/// 把目标分支（完整引用名）合并到当前分支。
pub async fn git_merge(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    target: String,
) -> AppResult<Integration> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::merge(&state, &locks, project_id, &target)).await
}

#[tauri::command]
/// 把当前分支变基到目标分支（完整引用名）。
pub async fn git_rebase(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    target: String,
) -> AppResult<Integration> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::rebase(&state, &locks, project_id, &target)).await
}

#[tauri::command]
/// 把冲突文件标记为已解决。
pub async fn git_resolve(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
    paths: Vec<String>,
    force: bool,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::resolve(&state, &locks, project_id, &paths, force)).await
}

#[tauri::command]
/// 冲突解决后完成合并或继续变基。
pub async fn git_continue(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<Integration> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::proceed(&state, &locks, project_id)).await
}

#[tauri::command]
/// 变基时跳过当前停下的提交。
pub async fn git_skip(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<Integration> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::skip(&state, &locks, project_id)).await
}

#[tauri::command]
/// 中止进行中的合并或变基。
pub async fn git_abort(
    workspaces: State<'_, Workspaces>,
    locks: State<'_, GitLocks>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let locks = locks.inner().clone();
    blocking(move || git::abort(&state, &locks, project_id)).await
}

#[tauri::command]
/// 快速打开使用的项目文件列表，尊重 .gitignore。
pub async fn search_files(
    workspaces: State<'_, Workspaces>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<FileList> {
    let state = workspaces.get(window.label())?;
    blocking(move || search::files(&state, project_id)).await
}

#[tauri::command]
/// 在项目中搜索文本；同一窗口开始新搜索时之前的搜索停止。
pub async fn search_text(
    workspaces: State<'_, Workspaces>,
    searches: State<'_, Searches>,
    window: WebviewWindow,
    project_id: u64,
    query: String,
    options: SearchOptions,
) -> AppResult<SearchResult> {
    let state = workspaces.get(window.label())?;
    let searches = searches.inner().clone();
    let label = window.label().to_owned();
    blocking(move || search::search(&state, &searches, &label, project_id, &query, &options)).await
}

#[tauri::command]
/// 取消本窗口进行中的搜索。
pub fn cancel_search(searches: State<'_, Searches>, window: WebviewWindow) -> AppResult<()> {
    searches.cancel(window.label())
}

#[tauri::command]
pub fn get_settings(settings: State<'_, Arc<SettingsStore>>) -> AppResult<Settings> {
    settings.get()
}

#[tauri::command]
/// 保存设置并通知所有窗口应用。
pub async fn save_settings(
    app: AppHandle,
    store: State<'_, Arc<SettingsStore>>,
    settings: Settings,
) -> AppResult<Settings> {
    let store = store.inner().clone();
    let saved = blocking(move || store.save(settings)).await?;
    // 通知失败只影响其他窗口的即时同步，下次打开窗口时仍会读取新设置。
    let _ = app.emit("nib://settings-changed", &saved);
    Ok(saved)
}

#[tauri::command]
/// 本机已安装的字体家族，首次调用时在后台线程扫描。
pub async fn system_fonts() -> AppResult<Vec<FontFamily>> {
    blocking(|| Ok(fonts::system_fonts())).await
}

#[tauri::command]
/// 上次记录的窗口尺寸、侧边栏宽度与侧边栏状态。
pub fn get_layout(sessions: State<'_, Arc<SessionStore>>) -> AppResult<Layout> {
    sessions.layout()
}

#[tauri::command]
pub async fn save_sidebar_width(
    sessions: State<'_, Arc<SessionStore>>,
    width: u32,
) -> AppResult<()> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.save_sidebar_width(width)).await
}

#[tauri::command]
/// 记录侧边栏是否显示及当前面板。
pub async fn save_view(
    sessions: State<'_, Arc<SessionStore>>,
    sidebar: bool,
    panel: String,
) -> AppResult<()> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.save_view(sidebar, panel)).await
}

#[tauri::command]
/// 写入一个文件未保存内容的恢复数据。
pub async fn recovery_save(
    workspaces: State<'_, Workspaces>,
    recovery: State<'_, Arc<RecoveryStore>>,
    window: WebviewWindow,
    project_id: u64,
    path: String,
    content: String,
    revision: String,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let recovery = recovery.inner().clone();
    blocking(move || {
        let root = state.lock()?.root_text(project_id)?;
        recovery.save(&root, &path, content, revision)
    })
    .await
}

#[tauri::command]
/// 删除文件的恢复数据。
pub async fn recovery_discard(
    workspaces: State<'_, Workspaces>,
    recovery: State<'_, Arc<RecoveryStore>>,
    window: WebviewWindow,
    project_id: u64,
    paths: Vec<String>,
) -> AppResult<()> {
    let state = workspaces.get(window.label())?;
    let recovery = recovery.inner().clone();
    blocking(move || {
        let root = state.lock()?.root_text(project_id)?;
        recovery.discard(&root, &paths)
    })
    .await
}

#[tauri::command]
/// 项目中上次未正常关闭时留下的恢复数据。
pub async fn recovery_list(
    workspaces: State<'_, Workspaces>,
    recovery: State<'_, Arc<RecoveryStore>>,
    window: WebviewWindow,
    project_id: u64,
) -> AppResult<Vec<RecoveryEntry>> {
    let state = workspaces.get(window.label())?;
    let recovery = recovery.inner().clone();
    blocking(move || {
        let root = state.lock()?.root_text(project_id)?;
        recovery.list(&root)
    })
    .await
}

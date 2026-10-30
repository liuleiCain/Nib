use std::{path::Path, sync::Arc};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::{
    error::{AppError, AppResult},
    filesystem::{self, Directory, Document},
    git::{self, CommitResult, DiffSources, GitLocks, GitStatus, Side},
    session::{ProjectTabs, SessionStore},
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
        sessions.save_tabs(&root, ProjectTabs { tabs, active })
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

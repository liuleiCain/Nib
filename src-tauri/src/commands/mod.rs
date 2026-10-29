use tauri::State;

use crate::{
    error::{AppError, AppResult},
    filesystem::{self, Directory, Document},
    workspace::{self, Project, WorkspaceState},
};

/// 磁盘任务统一进入阻塞线程池，避免阻塞窗口事件循环。
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| AppError::new("TASK", "后台任务意外中止，请重试。"))?
}

#[tauri::command]
/// 在后台校验目录可读性，成功后切换当前工作区。
pub async fn open_project(state: State<'_, WorkspaceState>, path: String) -> AppResult<Project> {
    let state = state.inner().clone();
    blocking(move || workspace::open(&state, &path)).await
}

#[tauri::command]
/// 只枚举指定层级，避免打开项目时扫描整棵目录树。
pub async fn list_directory(
    state: State<'_, WorkspaceState>,
    project_id: u64,
    path: String,
) -> AppResult<Directory> {
    let state = state.inner().clone();
    blocking(move || filesystem::list(&state, project_id, &path)).await
}

#[tauri::command]
/// 校验工作区和文件类型后返回文本及磁盘版本。
pub async fn read_file(
    state: State<'_, WorkspaceState>,
    project_id: u64,
    path: String,
) -> AppResult<Document> {
    let state = state.inner().clone();
    blocking(move || filesystem::read(&state, project_id, &path)).await
}

#[tauri::command]
/// 按读取时的磁盘版本保存，冲突时保留原文件。
pub async fn save_file(
    state: State<'_, WorkspaceState>,
    project_id: u64,
    path: String,
    content: String,
    expected_revision: String,
) -> AppResult<String> {
    let state = state.inner().clone();
    blocking(move || filesystem::save(&state, project_id, &path, &content, &expected_revision))
        .await
}

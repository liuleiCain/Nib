use std::{
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 单窗口工作区；所有磁盘操作持锁，切换项目与保存不会交错执行。
#[derive(Clone, Default)]
pub struct WorkspaceState(pub Arc<Mutex<Workspace>>);

/// 锁内维护根目录及版本，阻止旧项目的迟到命令。
#[derive(Default)]
pub struct Workspace {
    pub root: Option<PathBuf>,
    pub id: u64,
}

/// 返回前端的工作区标识与展示信息。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: u64,
    pub name: String,
    pub root: String,
}

impl WorkspaceState {
    /// 互斥失败时返回可展示错误，避免继续访问不确定状态。
    pub fn lock(&self) -> AppResult<MutexGuard<'_, Workspace>> {
        self.0
            .lock()
            .map_err(|_| AppError::new("WORKSPACE", "工作区暂时不可用，请重新启动 Nib。"))
    }
}

impl Workspace {
    /// 路径必须相对当前项目，符号链接也不得越过项目边界。
    pub fn resolve(&self, id: u64, relative: &str) -> AppResult<PathBuf> {
        if self.id != id {
            return Err(AppError::new("STALE", "项目已切换，请重试。"));
        }
        let root = self
            .root
            .as_ref()
            .ok_or_else(|| AppError::new("WORKSPACE", "请先打开项目。"))?;
        let path = Path::new(relative);
        if path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(AppError::new("PATH", "不允许访问项目之外的路径。"));
        }
        let resolved = root.join(path).canonicalize()?;
        if !resolved.starts_with(root) {
            return Err(AppError::new(
                "PATH",
                "此符号链接指向项目之外，暂不支持打开。",
            ));
        }
        Ok(resolved)
    }
}

/// 目录可访问后才替换工作区，失败时保留当前项目。
pub fn open(state: &WorkspaceState, path: &str) -> AppResult<Project> {
    let root = Path::new(path).canonicalize()?;
    if !root.is_dir() {
        return Err(AppError::new("DIRECTORY", "请选择一个本地文件夹。"));
    }
    // 确认有读取权限后再切换，失败时保留原项目。
    std::fs::read_dir(&root)?;
    let root_text = root
        .to_str()
        .ok_or_else(|| AppError::new("PATH", "暂不支持非 Unicode 项目路径。"))?
        .to_owned();
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_text.clone());
    let mut workspace = state.lock()?;
    workspace.id += 1;
    workspace.root = Some(root);
    Ok(Project {
        id: workspace.id,
        name,
        root: root_text,
    })
}

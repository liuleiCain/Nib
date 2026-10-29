use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
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

/// 所有窗口的工作区注册表；每个窗口独立加锁，窗口之间的磁盘操作互不阻塞。
///
/// 加锁顺序固定为注册表 → 窗口工作区，持有窗口工作区锁时不得再访问注册表。
#[derive(Clone, Default)]
pub struct Workspaces(Arc<Registry>);

/// 窗口标签到工作区的映射及标签计数。
#[derive(Default)]
pub struct Registry {
    windows: Mutex<HashMap<String, Slot>>,
    next_label: AtomicU64,
}

/// 单个窗口的工作区，以及窗口创建后等待前端打开的项目。
struct Slot {
    state: WorkspaceState,
    pending: Option<String>,
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

    /// 当前项目的根目录文本，未打开项目时为空。
    pub fn current_root(&self) -> Option<String> {
        self.root
            .as_deref()
            .and_then(Path::to_str)
            .map(str::to_owned)
    }

    /// 指定项目的根目录文本；项目已切换或关闭时拒绝。
    pub fn root_text(&self, id: u64) -> AppResult<String> {
        if self.id != id {
            return Err(AppError::new("STALE", "项目已切换，请重试。"));
        }
        self.current_root()
            .ok_or_else(|| AppError::new("WORKSPACE", "请先打开项目。"))
    }
}

impl Workspaces {
    fn windows(&self) -> AppResult<MutexGuard<'_, HashMap<String, Slot>>> {
        self.0
            .windows
            .lock()
            .map_err(|_| AppError::new("WORKSPACE", "工作区暂时不可用，请重新启动 Nib。"))
    }

    /// 为新窗口分配标签，并登记窗口加载后要打开的项目。
    pub fn register(&self, pending: Option<String>) -> AppResult<String> {
        let number = self.0.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("window-{number}");
        self.windows()?.insert(
            label.clone(),
            Slot {
                state: WorkspaceState::default(),
                pending,
            },
        );
        Ok(label)
    }

    /// 返回窗口的工作区；窗口已销毁时拒绝。
    pub fn get(&self, label: &str) -> AppResult<WorkspaceState> {
        self.windows()?
            .get(label)
            .map(|slot| slot.state.clone())
            .ok_or_else(|| AppError::new("WORKSPACE", "窗口已关闭。"))
    }

    /// 取出窗口待打开的项目；页面重新加载时返回窗口当前项目。
    pub fn startup(&self, label: &str) -> AppResult<Option<String>> {
        let state = {
            let mut windows = self.windows()?;
            let slot = windows
                .get_mut(label)
                .ok_or_else(|| AppError::new("WORKSPACE", "窗口已关闭。"))?;
            if let Some(root) = slot.pending.take() {
                return Ok(Some(root));
            }
            slot.state.clone()
        };
        let root = state.lock()?.current_root();
        Ok(root)
    }

    /// 查找已打开或即将打开该项目的窗口。
    pub fn find(&self, root: &Path) -> AppResult<Option<String>> {
        let windows = self.windows()?;
        for (label, slot) in windows.iter() {
            if slot.pending.as_deref().map(Path::new) == Some(root)
                || slot.state.lock()?.root.as_deref() == Some(root)
            {
                return Ok(Some(label.clone()));
            }
        }
        Ok(None)
    }

    /// 所有窗口已打开或即将打开的项目根目录。
    pub fn roots(&self) -> AppResult<Vec<String>> {
        let windows = self.windows()?;
        let mut roots = Vec::new();
        for slot in windows.values() {
            roots.extend(slot.pending.clone());
            roots.extend(slot.state.lock()?.current_root());
        }
        Ok(roots)
    }

    /// 除 except 外是否还有其他窗口。
    pub fn has_others(&self, except: &str) -> bool {
        self.windows()
            .map(|windows| windows.keys().any(|label| label != except))
            .unwrap_or(false)
    }

    /// 窗口销毁后释放其工作区。
    pub fn remove(&self, label: &str) {
        if let Ok(mut windows) = self.windows() {
            windows.remove(label);
        }
    }
}

/// 规范化并确认项目目录可读，返回根目录及其文本形式。
pub fn canonical_root(path: &str) -> AppResult<(PathBuf, String)> {
    let root = Path::new(path).canonicalize()?;
    if !root.is_dir() {
        return Err(AppError::new("DIRECTORY", "请选择一个本地文件夹。"));
    }
    // 确认有读取权限后再切换，失败时保留原项目。
    std::fs::read_dir(&root)?;
    let text = root
        .to_str()
        .ok_or_else(|| AppError::new("PATH", "暂不支持非 Unicode 项目路径。"))?
        .to_owned();
    Ok((root, text))
}

/// 用已校验的根目录替换窗口工作区，并使旧项目的请求失效。
pub fn open(state: &WorkspaceState, root: PathBuf, root_text: String) -> AppResult<Project> {
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

/// 关闭窗口当前项目并使旧请求失效，返回原项目根目录。
pub fn close(state: &WorkspaceState) -> AppResult<Option<String>> {
    let mut workspace = state.lock()?;
    let root = workspace.current_root();
    workspace.id += 1;
    workspace.root = None;
    Ok(root)
}

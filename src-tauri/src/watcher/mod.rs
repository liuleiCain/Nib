use std::{
    collections::{BTreeSet, HashMap},
    path::{Component, Path, PathBuf},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};

use crate::error::{AppError, AppResult};

/// 同一批外部修改合并后再通知前端，AI 连续写入时不逐个事件刷新。
const DEBOUNCE: Duration = Duration::from_millis(150);
/// 单批变化超过该数量时只通知整体刷新，避免大批量生成文件时传输过多路径。
const MAX_PATHS: usize = 500;
/// 不向前端报告的目录，与文件树隐藏规则一致，避免构建和依赖目录的高频变化。
const IGNORED: [&str; 4] = [".git", "node_modules", "target", ".DS_Store"];

/// 按窗口管理项目目录监听；窗口切换项目或关闭时停止旧监听。
#[derive(Clone, Default)]
pub struct Watchers(Arc<Mutex<HashMap<String, RecommendedWatcher>>>);

/// 推送给项目窗口的一批文件变化，路径相对项目根目录。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub project_id: u64,
    pub paths: Vec<String>,
    pub rescan: bool,
    /// 项目根目录下 .git 的 HEAD、索引或引用有变化（终端或 AI 执行了 Git 操作）。
    pub git: bool,
}

impl Watchers {
    /// 为窗口启动项目监听，替换该窗口原有的监听。
    pub fn watch(
        &self,
        app: &AppHandle,
        label: &str,
        project_id: u64,
        root: &Path,
    ) -> AppResult<()> {
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(sender)
            .map_err(|error| AppError::new("WATCH", format!("无法监听项目目录：{error}")))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| AppError::new("WATCH", format!("无法监听项目目录：{error}")))?;
        let app = app.clone();
        let target = label.to_owned();
        let root = root.to_path_buf();
        // 监听器释放后发送端随之关闭，合并线程收到断开后退出。
        thread::spawn(move || forward(app, target, project_id, root, receiver));
        self.0
            .lock()
            .map_err(|_| AppError::new("WATCH", "文件监听暂时不可用。"))?
            .insert(label.to_owned(), watcher);
        Ok(())
    }

    /// 停止窗口的项目监听。
    pub fn stop(&self, label: &str) {
        if let Ok(mut watchers) = self.0.lock() {
            watchers.remove(label);
        }
    }
}

/// 合并事件后按项目推送；只发给拥有该项目的窗口。
fn forward(
    app: AppHandle,
    label: String,
    project_id: u64,
    root: PathBuf,
    receiver: mpsc::Receiver<notify::Result<notify::Event>>,
) {
    let mut pending = BTreeSet::new();
    let mut rescan = false;
    let mut git = false;
    let mut deadline: Option<Instant> = None;
    let git_dir = root.join(".git");
    loop {
        let message = match deadline {
            Some(at) => receiver.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(Ok(event)) => {
                rescan |= event.need_rescan();
                for path in &event.paths {
                    if let Some(relative) = relative(&root, path) {
                        pending.insert(relative);
                    } else if let Ok(inner) = path.strip_prefix(&git_dir) {
                        // 对象库写入后总会更新索引或引用，忽略它可减少无效刷新。
                        git |= !inner.starts_with("objects") && !inner.starts_with("logs");
                    }
                }
                if pending.len() > MAX_PATHS {
                    rescan = true;
                    pending.clear();
                }
            }
            // 监听出错时无法确定变化范围，要求前端整体刷新。
            Ok(Err(_)) => rescan = true,
            Err(RecvTimeoutError::Timeout) => {
                if rescan || git || !pending.is_empty() {
                    let changes = Changes {
                        project_id,
                        paths: std::mem::take(&mut pending).into_iter().collect(),
                        rescan,
                        git,
                    };
                    rescan = false;
                    git = false;
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.as_str()),
                        "nib://files-changed",
                        changes,
                    );
                }
                deadline = None;
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
        deadline.get_or_insert_with(|| Instant::now() + DEBOUNCE);
    }
}

/// 转为相对项目根目录的路径；忽略目录、项目外路径和非 Unicode 路径返回空。
fn relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = name.to_str()?;
        if IGNORED.contains(&name) {
            return None;
        }
        parts.push(name);
    }
    Some(parts.join("/"))
}

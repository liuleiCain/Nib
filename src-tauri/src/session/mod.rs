use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
};

use serde::{Deserialize, Serialize};

use crate::{
    common::write_atomic,
    error::{AppError, AppResult},
};

const VERSION: u32 = 1;
const MAX_RECENT: usize = 20;
const MAX_TABS: usize = 30;
const MAX_PATH_LENGTH: usize = 4096;
/// 每个项目最多记录的展开目录数。
const MAX_EXPANDED: usize = 200;
/// 侧边栏宽度范围，与界面拖动范围一致。
const SIDEBAR_WIDTH: (u32, u32) = (180, 420);
/// 可记录的侧边栏面板。
const PANELS: [&str; 5] = ["files", "commit", "log", "search", "live"];

/// 最近项目、各项目标签和退出时打开的项目，与项目文件分开存放在用户目录的 `.nib` 下。
pub struct SessionStore {
    path: PathBuf,
    data: Mutex<Session>,
    quitting: AtomicBool,
}

/// 带版本号的会话文件内容。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    version: u32,
    recent: Vec<RecentProject>,
    open: Vec<String>,
    projects: HashMap<String, ProjectTabs>,
    /// 旧版会话文件没有此项，按默认值读取。
    #[serde(default)]
    layout: Layout,
}

/// 窗口尺寸与侧边栏状态，所有项目窗口共用最近一次的值；缺少的项按界面默认值处理。
/// 用户可调整的偏好保存在设置文件，见 `settings`。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// 窗口内容区的逻辑尺寸；最大化、全屏时不记录。
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sidebar_width: Option<u32>,
    /// 侧边栏是否显示。
    pub sidebar: Option<bool>,
    /// 侧边栏当前面板，取值见 `PANELS`。
    pub panel: Option<String>,
}

/// 最近项目列表中的一项，按最近打开排序。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub root: String,
    pub name: String,
}

/// 项目上次打开的标签、当前标签及文件树展开的目录，路径相对项目根目录。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTabs {
    pub tabs: Vec<String>,
    pub active: Option<String>,
    /// 旧版会话文件没有此项，按空列表读取。
    #[serde(default)]
    pub expanded: Vec<String>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            version: VERSION,
            recent: Vec::new(),
            open: Vec::new(),
            projects: HashMap::new(),
            layout: Layout::default(),
        }
    }
}

impl SessionStore {
    /// 读取会话文件；文件缺失、损坏或版本不符时从空会话开始。
    pub fn load(directory: PathBuf) -> Self {
        let path = directory.join("session.json");
        let data = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Session>(&bytes).ok())
            .filter(|session| session.version == VERSION)
            .unwrap_or_default();
        Self {
            path,
            data: Mutex::new(data),
            quitting: AtomicBool::new(false),
        }
    }

    fn data(&self) -> AppResult<MutexGuard<'_, Session>> {
        self.data
            .lock()
            .map_err(|_| AppError::new("SESSION", "会话记录暂时不可用，请重新启动 Nib。"))
    }

    /// 原子写入会话文件，写入失败不影响内存中的会话。
    fn persist(&self, session: &Session) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(session)
            .map_err(|_| AppError::new("SESSION", "会话记录序列化失败。"))?;
        write_atomic(&self.path, &bytes)
    }

    /// 修改会话并立即写盘；持锁写入保证多窗口的写入顺序与内存一致。
    fn update(&self, change: impl FnOnce(&mut Session)) -> AppResult<()> {
        let mut session = self.data()?;
        change(&mut session);
        let keep: Vec<String> = session
            .recent
            .iter()
            .map(|item| item.root.clone())
            .chain(session.open.iter().cloned())
            .collect();
        session.projects.retain(|root, _| keep.contains(root));
        self.persist(&session)
    }

    /// 上次退出时打开的项目，按打开顺序排列。
    pub fn open_projects(&self) -> Vec<String> {
        self.data()
            .map(|session| session.open.clone())
            .unwrap_or_default()
    }

    /// 只保留启动时仍可恢复的项目。
    pub fn retain_open(&self, roots: &[String]) -> AppResult<()> {
        self.update(|session| session.open.retain(|root| roots.contains(root)))
    }

    /// 最近打开的项目，最新的在前。
    pub fn recent(&self) -> AppResult<Vec<RecentProject>> {
        Ok(self.data()?.recent.clone())
    }

    /// 项目上次的标签；没有记录时为空。
    pub fn tabs(&self, root: &str) -> AppResult<ProjectTabs> {
        Ok(self.data()?.projects.get(root).cloned().unwrap_or_default())
    }

    /// 记录项目已在窗口中打开：移到最近项目最前，并加入打开列表。
    pub fn opened(&self, root: &str, name: &str) -> AppResult<()> {
        self.update(|session| {
            session.recent.retain(|item| item.root != root);
            session.recent.insert(
                0,
                RecentProject {
                    root: root.to_owned(),
                    name: name.to_owned(),
                },
            );
            session.recent.truncate(MAX_RECENT);
            if !session.open.iter().any(|item| item == root) {
                session.open.push(root.to_owned());
            }
        })
    }

    /// 项目已关闭，下次启动不再恢复。
    pub fn closed(&self, root: &str) -> AppResult<()> {
        self.update(|session| session.open.retain(|item| item != root))
    }

    /// 从最近项目中移除，不影响项目文件。
    pub fn forget(&self, root: &str) -> AppResult<()> {
        self.update(|session| session.recent.retain(|item| item.root != root))
    }

    /// 记录项目当前的标签，保留展开目录；数量和路径长度超限时拒绝。
    pub fn save_tabs(
        &self,
        root: &str,
        tabs: Vec<String>,
        active: Option<String>,
    ) -> AppResult<()> {
        if tabs.len() > MAX_TABS
            || tabs
                .iter()
                .chain(active.iter())
                .any(|path| path.len() > MAX_PATH_LENGTH)
        {
            return Err(AppError::new("SESSION", "标签记录超出限制，未保存。"));
        }
        self.update(|session| {
            let entry = session.projects.entry(root.to_owned()).or_default();
            entry.tabs = tabs;
            entry.active = active;
        })
    }

    /// 记录项目文件树展开的目录，保留标签；数量和路径长度超限时拒绝。
    pub fn save_expanded(&self, root: &str, expanded: Vec<String>) -> AppResult<()> {
        if expanded.len() > MAX_EXPANDED || expanded.iter().any(|path| path.len() > MAX_PATH_LENGTH)
        {
            return Err(AppError::new("SESSION", "展开目录记录超出限制，未保存。"));
        }
        self.update(|session| {
            session
                .projects
                .entry(root.to_owned())
                .or_default()
                .expanded = expanded;
        })
    }

    /// 上次记录的窗口尺寸与侧边栏状态。
    pub fn layout(&self) -> AppResult<Layout> {
        Ok(self.data()?.layout.clone())
    }

    /// 窗口尺寸变化时只更新内存，窗口关闭时由 flush 写盘，避免拖动窗口时频繁写入。
    pub fn resized(&self, width: u32, height: u32) {
        if let Ok(mut session) = self.data() {
            session.layout.width = Some(width);
            session.layout.height = Some(height);
        }
    }

    /// 记录侧边栏宽度；超出范围时拒绝。
    pub fn save_sidebar_width(&self, width: u32) -> AppResult<()> {
        if !(SIDEBAR_WIDTH.0..=SIDEBAR_WIDTH.1).contains(&width) {
            return Err(AppError::new("SESSION", "侧边栏宽度超出范围，未保存。"));
        }
        self.update(|session| session.layout.sidebar_width = Some(width))
    }

    /// 记录侧边栏是否显示及当前面板；面板未知时拒绝。
    pub fn save_view(&self, sidebar: bool, panel: String) -> AppResult<()> {
        if !PANELS.contains(&panel.as_str()) {
            return Err(AppError::new("SESSION", "侧边栏面板无效，未保存。"));
        }
        self.update(|session| {
            session.layout.sidebar = Some(sidebar);
            session.layout.panel = Some(panel);
        })
    }

    /// 把内存中的会话写盘，用于窗口关闭时保存尺寸。
    pub fn flush(&self) -> AppResult<()> {
        self.update(|_| {})
    }

    /// 标记应用正在退出，期间关闭的窗口保留在打开列表中供下次恢复。
    pub fn set_quitting(&self, quitting: bool) {
        self.quitting.store(quitting, Ordering::SeqCst);
    }

    /// 应用是否处于退出流程。
    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

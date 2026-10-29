use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const VERSION: u32 = 1;
const MAX_RECENT: usize = 20;
const MAX_TABS: usize = 30;
const MAX_PATH_LENGTH: usize = 4096;

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
}

/// 最近项目列表中的一项，按最近打开排序。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub root: String,
    pub name: String,
}

/// 项目上次打开的标签及当前标签，路径相对项目根目录。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTabs {
    pub tabs: Vec<String>,
    pub active: Option<String>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            version: VERSION,
            recent: Vec::new(),
            open: Vec::new(),
            projects: HashMap::new(),
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

    /// 在配置目录写临时文件后原子替换，写入失败不影响内存中的会话。
    fn persist(&self, session: &Session) -> AppResult<()> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| AppError::new("SESSION", "会话文件路径无效。"))?;
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec_pretty(session)
            .map_err(|_| AppError::new("SESSION", "会话记录序列化失败。"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.path)
            .map_err(|error| AppError::from(error.error))?;
        Ok(())
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

    /// 记录项目当前的标签，数量和路径长度超限时拒绝。
    pub fn save_tabs(&self, root: &str, tabs: ProjectTabs) -> AppResult<()> {
        if tabs.tabs.len() > MAX_TABS
            || tabs
                .tabs
                .iter()
                .chain(tabs.active.iter())
                .any(|path| path.len() > MAX_PATH_LENGTH)
        {
            return Err(AppError::new("SESSION", "标签记录超出限制，未保存。"));
        }
        self.update(|session| {
            session.projects.insert(root.to_owned(), tabs);
        })
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

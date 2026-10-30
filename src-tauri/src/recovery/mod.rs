//! 未保存内容的本地恢复：编辑后定期把未保存的标签内容写入 `~/.nib/recovery/<项目>/<文件>.json`，
//! 保存、放弃或正常关闭时由前端删除；异常退出后再次打开项目时，前端据此提示恢复，
//! 用户选择“稍后处理”的条目保留到下次打开。恢复数据与项目文件、会话记录分开存放，只有当前用户可读。

use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    common::write_atomic,
    error::{AppError, AppResult},
};

const VERSION: u32 = 1;
/// 单个文件恢复内容的上限，超过时前端不写入恢复数据。
pub const MAX_CONTENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_PATH_LENGTH: usize = 4096;
/// 每个项目最多读取的恢复条目数，与标签上限一致。
const MAX_ENTRIES: usize = 30;

/// 一个文件的恢复内容；content 为编辑器中的文本（LF 换行，不含 BOM）。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub version: u32,
    /// 项目根目录，读取时核对，避免哈希冲突时恢复到其他项目。
    pub root: String,
    /// 相对项目根目录的路径。
    pub path: String,
    pub content: String,
    /// 编辑所基于的磁盘版本；与当前磁盘版本不同表示文件在此后被修改过。
    pub revision: String,
    /// 写入时间，Unix 秒。
    pub saved_at: u64,
}

/// 恢复数据目录。
pub struct RecoveryStore {
    directory: PathBuf,
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 只接受项目内的相对路径。
fn checked(path: &str) -> AppResult<&str> {
    // components() 会省略中间的 "."，另按 / 逐段检查，保证同一文件只有一种写法。
    let valid = !path.is_empty()
        && path.len() <= MAX_PATH_LENGTH
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
    if !valid {
        return Err(AppError::new("RECOVERY", "恢复数据的文件路径无效。"));
    }
    Ok(path)
}

impl RecoveryStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory: directory.join("recovery"),
        }
    }

    fn project(&self, root: &str) -> PathBuf {
        self.directory.join(digest(root))
    }

    fn entry(&self, root: &str, path: &str) -> PathBuf {
        self.project(root).join(format!("{}.json", digest(path)))
    }

    /// 写入一个文件的恢复内容，覆盖之前的记录。
    pub fn save(&self, root: &str, path: &str, content: String, revision: String) -> AppResult<()> {
        let path = checked(path)?;
        if content.len() > MAX_CONTENT_BYTES {
            return Err(AppError::new("RECOVERY", "文件过大，不写入恢复数据。"));
        }
        let project = self.project(root);
        fs::create_dir_all(&project)?;
        // 恢复内容可能含敏感信息，目录只允许当前用户访问。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for directory in [&self.directory, &project] {
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
            }
        }
        let entry = RecoveryEntry {
            version: VERSION,
            root: root.to_owned(),
            path: path.to_owned(),
            content,
            revision,
            saved_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|time| time.as_secs())
                .unwrap_or(0),
        };
        let bytes = serde_json::to_vec(&entry)
            .map_err(|_| AppError::new("RECOVERY", "恢复数据序列化失败。"))?;
        write_atomic(&self.entry(root, path), &bytes)
    }

    /// 删除文件的恢复内容；不存在时忽略。先校验全部路径，避免只删除一部分。
    pub fn discard(&self, root: &str, paths: &[String]) -> AppResult<()> {
        for path in paths {
            checked(path)?;
        }
        for path in paths {
            match fs::remove_file(self.entry(root, path)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into())
                }
                _ => {}
            }
        }
        // 项目下已没有恢复内容时删除空目录，失败不影响结果。
        let _ = fs::remove_dir(self.project(root));
        Ok(())
    }

    /// 项目的全部恢复内容，按路径排序；损坏、版本不符或不属于该项目的记录跳过。
    pub fn list(&self, root: &str) -> AppResult<Vec<RecoveryEntry>> {
        let directory = match fs::read_dir(self.project(root)) {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut entries = Vec::new();
        for item in directory.flatten() {
            if entries.len() >= MAX_ENTRIES {
                break;
            }
            let Ok(bytes) = fs::read(item.path()) else {
                continue;
            };
            let Ok(entry) = serde_json::from_slice::<RecoveryEntry>(&bytes) else {
                continue;
            };
            if entry.version == VERSION && entry.root == root && checked(&entry.path).is_ok() {
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }
}

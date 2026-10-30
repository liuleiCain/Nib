//! 跨模块公共能力。

use std::{fs, io::Write, path::Path};

use crate::error::{AppError, AppResult};

/// 在目标目录写临时文件、同步后原子替换；用于会话、设置和恢复数据，失败时原文件不变。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let directory = path
        .parent()
        .ok_or_else(|| AppError::new("STORAGE", "数据文件路径无效。"))?;
    fs::create_dir_all(directory)?;
    // 临时文件在 Unix 上权限为 0600，替换后只有当前用户可读。
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| AppError::from(error.error))?;
    Ok(())
}

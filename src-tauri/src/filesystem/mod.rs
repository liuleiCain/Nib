use std::{
    fs,
    io::{Read, Write},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    workspace::WorkspaceState,
};

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

/// 文件树的一层条目，路径始终相对工作区。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// 单层目录响应，明确告知无法表示的文件名数量。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub entries: Vec<FileEntry>,
    pub skipped_names: usize,
}

/// 文本及安全保存所需的原始磁盘信息。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub content: String,
    pub revision: String,
    pub newline: &'static str,
    pub has_bom: bool,
    pub mixed_newlines: bool,
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 按需读取一层目录，隐藏规则只影响文件树，不承担搜索忽略语义。
pub fn list(state: &WorkspaceState, id: u64, path: &str) -> AppResult<Directory> {
    let workspace = state.lock()?;
    let directory = workspace.resolve(id, path)?;
    let mut entries = Vec::new();
    let mut skipped_names = 0;
    for item in fs::read_dir(directory)? {
        let item = item?;
        let Ok(name) = item.file_name().into_string() else {
            skipped_names += 1;
            continue;
        };
        if matches!(
            name.as_str(),
            ".git" | "node_modules" | "target" | ".DS_Store"
        ) {
            continue;
        }
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            return Err(AppError::new(
                "DIRECTORY_LIMIT",
                "此目录超过 10,000 项，暂不支持展示。请打开更小的子目录。",
            ));
        }
        let file_type = item.file_type()?;
        let relative = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        // 不跟随文件树中的符号链接目录，避免循环；文件链接由 resolve 校验。
        entries.push(FileEntry {
            name,
            path: relative,
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(Directory {
        entries,
        skipped_names,
    })
}

fn read_limited(path: &std::path::Path) -> AppResult<Vec<u8>> {
    // 打开 FIFO 可能阻塞，必须在打开前拒绝已知特殊文件。
    if !fs::metadata(path)?.is_file() {
        return Err(AppError::new(
            "FILE_TYPE",
            "此路径不是普通文件，暂不支持目录和特殊设备。",
        ));
    }
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::new(
            "FILE_TYPE",
            "此路径不是普通文件；暂不支持符号链接目录和特殊设备。",
        ));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(AppError::new(
            "FILE_TOO_LARGE",
            "文件超过 5 MiB，阶段一暂不加载，请使用其他编辑器打开。",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::new(
            "FILE_TOO_LARGE",
            "读取时文件超过 5 MiB，已停止加载。",
        ));
    }
    Ok(bytes)
}

/// 拒绝不支持的内容，并统一编辑器使用的换行表示。
pub fn read(state: &WorkspaceState, id: u64, path: &str) -> AppResult<Document> {
    let workspace = state.lock()?;
    let resolved = workspace.resolve(id, path)?;
    let bytes = read_limited(&resolved)?;
    if bytes.contains(&0) {
        return Err(AppError::new(
            "BINARY",
            "这是二进制文件，Nib 暂不提供二进制预览。",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::new("ENCODING", "此文件不是 UTF-8 编码，请先使用其他工具转换。"))?;
    let has_bom = text.starts_with('\u{feff}');
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let cr = text.matches('\r').count() - crlf;
    let mixed_newlines = [crlf, lf, cr]
        .into_iter()
        .filter(|count| *count > 0)
        .count()
        > 1;
    if mixed_newlines {
        return Err(AppError::new(
            "MIXED_NEWLINES",
            "文件含有混合换行符。为避免整文件变化，阶段一暂不编辑此文件。",
        ));
    }
    Ok(Document {
        content: text.replace("\r\n", "\n").replace('\r', "\n"),
        revision: revision(&bytes),
        newline: if crlf > 0 {
            "CRLF"
        } else if cr > 0 {
            "CR"
        } else {
            "LF"
        },
        has_bom,
        mixed_newlines,
    })
}

/// 校验磁盘版本后在同目录原子替换；权限及符号链接目标得到保留。
pub fn save(
    state: &WorkspaceState,
    id: u64,
    path: &str,
    content: &str,
    expected_revision: &str,
) -> AppResult<String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::new(
            "FILE_TOO_LARGE",
            "编辑内容超过 5 MiB，无法保存。请缩小内容后重试。",
        ));
    }
    let workspace = state.lock()?;
    let resolved = workspace.resolve(id, path)?;
    let previous = read_limited(&resolved)?;
    if revision(&previous) != expected_revision {
        return Err(AppError::new(
            "CONFLICT",
            "文件已被外部程序修改，保存已停止。请保留当前编辑，或重新加载磁盘版本。",
        ));
    }
    let metadata = fs::metadata(&resolved)?;
    if metadata.permissions().readonly() {
        return Err(AppError::new("READ_ONLY", "文件为只读，未写入任何内容。"));
    }
    let parent = resolved
        .parent()
        .ok_or_else(|| AppError::new("PATH", "文件路径无效。"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content.as_bytes())?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())?;
    temporary.as_file().sync_all()?;
    // 写临时文件期间也可能有外部修改，替换前再次检查。
    if revision(&read_limited(&resolved)?) != expected_revision {
        return Err(AppError::new(
            "CONFLICT",
            "保存期间检测到外部修改，已停止替换原文件。",
        ));
    }
    temporary
        .persist(&resolved)
        .map_err(|error| AppError::from(error.error))?;
    Ok(revision(content.as_bytes()))
}

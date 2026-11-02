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

/// 可编辑文件上限，与 GoLand 默认的 20 MB 加载上限一致；超过时只读预览开头部分。
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// 超大文本只读预览读取的字节数。
const PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
/// 判断二进制时检查的开头字节数。
const SNIFF_BYTES: u64 = 8 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

/// 非 Git 项目的变化路径状态；仅检查元数据，不读取文件内容。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub original: Option<String>,
    pub kind: &'static str,
    pub submodule: bool,
}

/// 过滤目录和项目外路径，消失的文件保留为删除状态供实时面板展示。
pub fn inspect_files(
    state: &WorkspaceState,
    id: u64,
    paths: &[String],
) -> AppResult<Vec<ChangedFile>> {
    let workspace = state.lock()?;
    workspace.root_text(id)?;
    let mut files = Vec::new();
    for path in paths.iter().take(500) {
        let kind = match workspace.entry(id, path) {
            Ok(entry) => match fs::symlink_metadata(&entry) {
                Ok(metadata) if metadata.is_file() => "modified",
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => "deleted",
                Err(error) => return Err(error.into()),
            },
            // 父目录消失时，前端只将之前确认过的文件纳入删除列表。
            Err(error) if error.code == "NOT_FOUND" => "deleted",
            Err(error) => return Err(error),
        };
        files.push(ChangedFile {
            path: path.clone(),
            original: None,
            kind,
            submodule: false,
        });
    }
    Ok(files)
}

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
    /// 文件超过可编辑上限，content 只是开头部分，前端须只读展示且不保存。
    pub truncated: bool,
    /// 磁盘文件的总字节数。
    pub size: u64,
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

/// 打开普通文件并返回其字节数，拒绝目录和特殊设备。
fn open_regular(path: &std::path::Path) -> AppResult<(fs::File, u64)> {
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
    Ok((file, metadata.len()))
}

fn too_large() -> AppError {
    AppError::new(
        "FILE_TOO_LARGE",
        "文件超过 20 MiB，无法编辑或保存，只能只读预览开头部分。",
    )
}

/// 读取完整文件，用于保存前的版本检查；超过可编辑上限时报错。
fn read_limited(path: &std::path::Path) -> AppResult<Vec<u8>> {
    let (file, size) = open_regular(path)?;
    if size > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

fn binary() -> AppError {
    AppError::new("BINARY", "这是二进制文件，Nib 暂不提供二进制预览。")
}

fn encoding() -> AppError {
    AppError::new("ENCODING", "此文件不是 UTF-8 编码，请先使用其他工具转换。")
}

/// 拒绝不支持的内容，并统一编辑器使用的换行表示。
///
/// 先检查开头是否为二进制，再看大小：不超过可编辑上限时完整读取；超过时只读取开头
/// 一段作为只读预览，避免把超大文件整体读入内存和 WebView。
pub fn read(state: &WorkspaceState, id: u64, path: &str) -> AppResult<Document> {
    let workspace = state.lock()?;
    let resolved = workspace.resolve(id, path)?;
    let (file, size) = open_regular(&resolved)?;
    let truncated = size > MAX_FILE_BYTES;
    let limit = if truncated {
        PREVIEW_BYTES
    } else {
        MAX_FILE_BYTES + 1
    };
    let mut bytes = Vec::new();
    let mut reader = file.take(limit);
    (&mut reader).take(SNIFF_BYTES).read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        return Err(binary());
    }
    reader.read_to_end(&mut bytes)?;
    if !truncated && bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    if bytes.contains(&0) {
        return Err(binary());
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        // 预览在多字节字符中间截断时，丢弃末尾不完整的字符。
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(|_| encoding())?
        }
        Err(_) => return Err(encoding()),
    };
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
    // 只读预览不会写回，混合换行不影响展示。
    if mixed_newlines && !truncated {
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
        truncated,
        size,
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
            "编辑内容超过 20 MiB，无法保存。请缩小内容后重试。",
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

/// 新建、重命名使用的单级名称：不能为空、`.`、`..`，不能含路径分隔符或 NUL，不能是 `.git`。
fn valid_name(name: &str) -> AppResult<&str> {
    let name = name.trim_end_matches(['\r', '\n']);
    if name.trim().is_empty() {
        return Err(AppError::new("NAME", "名称不能为空。"));
    }
    if name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(AppError::new(
            "NAME",
            "名称不能是 . 或 ..，也不能包含 / 或 \\。",
        ));
    }
    if name.eq_ignore_ascii_case(".git") {
        return Err(AppError::new("NAME", "不能使用 .git 作为名称。"));
    }
    Ok(name)
}

/// 父目录相对路径与名称拼接为项目相对路径。
fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

/// target 是否已存在；大小写不敏感的文件系统上只改大小写时，target 与 source 是同一文件，不算存在。
fn occupied(source: Option<&std::path::Path>, target: &std::path::Path) -> bool {
    let Ok(existing) = fs::symlink_metadata(target) else {
        return false;
    };
    #[cfg(unix)]
    if let Some(Ok(original)) = source.map(fs::symlink_metadata) {
        use std::os::unix::fs::MetadataExt;
        return !(existing.dev() == original.dev() && existing.ino() == original.ino());
    }
    let _ = (source, existing);
    true
}

/// 在 parent 目录下新建空文件或目录，返回新条目的项目相对路径；同名条目已存在时拒绝。
pub fn create(
    state: &WorkspaceState,
    id: u64,
    parent: &str,
    name: &str,
    directory: bool,
) -> AppResult<String> {
    let name = valid_name(name)?;
    let workspace = state.lock()?;
    let relative = join(parent, name);
    let target = workspace.entry(id, &relative)?;
    if !target.parent().is_some_and(std::path::Path::is_dir) {
        return Err(AppError::new("PATH", "所在目录不存在或不是目录。"));
    }
    if occupied(None, &target) {
        return Err(AppError::new(
            "EXISTS",
            format!("已存在名为 {name} 的文件或目录。"),
        ));
    }
    if directory {
        fs::create_dir(&target)?;
    } else {
        // create_new 保证不会覆盖检查之后才出现的同名文件。
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
    }
    Ok(relative)
}

/// 校验重命名：源条目存在、新名称有效且同目录下没有同名条目，返回新的项目相对路径。
pub fn rename_target(state: &WorkspaceState, id: u64, path: &str, name: &str) -> AppResult<String> {
    let name = valid_name(name)?;
    let workspace = state.lock()?;
    let source = workspace.entry(id, path)?;
    fs::symlink_metadata(&source)?;
    let relative = join(path.rsplit_once('/').map_or("", |(parent, _)| parent), name);
    let target = workspace.entry(id, &relative)?;
    if occupied(Some(&source), &target) {
        return Err(AppError::new(
            "EXISTS",
            format!("已存在名为 {name} 的文件或目录。"),
        ));
    }
    Ok(relative)
}

/// 直接在磁盘上重命名（未被 Git 跟踪的条目）；持锁后再次确认目标不存在。
pub fn rename(state: &WorkspaceState, id: u64, from: &str, to: &str) -> AppResult<()> {
    let workspace = state.lock()?;
    let source = workspace.entry(id, from)?;
    let target = workspace.entry(id, to)?;
    if occupied(Some(&source), &target) {
        return Err(AppError::new("EXISTS", "目标名称已被占用，未重命名。"));
    }
    fs::rename(&source, &target)?;
    Ok(())
}

/// 移到系统废纸篓，可从废纸篓找回；符号链接只移走链接本身。
pub fn trash(state: &WorkspaceState, id: u64, path: &str) -> AppResult<()> {
    let workspace = state.lock()?;
    let target = workspace.entry(id, path)?;
    fs::symlink_metadata(&target)?;
    let mut context = trash::TrashContext::default();
    // 默认的访达方式需要“自动化”授权，改用系统文件管理接口，不弹授权请求。
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context
        .delete(&target)
        .map_err(|error| AppError::new("TRASH", format!("移到废纸篓失败：{error}")))
}

/// 在系统文件管理器中显示并选中条目；path 为空时显示项目根目录。
pub fn reveal(state: &WorkspaceState, id: u64, path: &str) -> AppResult<()> {
    let target = {
        let workspace = state.lock()?;
        if path.is_empty() {
            std::path::PathBuf::from(workspace.root_text(id)?)
        } else {
            workspace.entry(id, path)?
        }
    };
    fs::symlink_metadata(&target)?;
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&target)
        .status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&target)
        .status();
    // 其他平台没有统一的选中接口，打开所在目录。
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = std::process::Command::new("xdg-open")
        .arg(target.parent().unwrap_or(&target))
        .status();
    match status {
        // Windows 资源管理器即使成功也可能返回非零状态，只把无法启动视为失败。
        Ok(status) if status.success() || cfg!(target_os = "windows") => Ok(()),
        Ok(_) => Err(AppError::new("REVEAL", "无法在文件管理器中显示。")),
        Err(error) => Err(AppError::new(
            "REVEAL",
            format!("无法打开文件管理器：{error}"),
        )),
    }
}

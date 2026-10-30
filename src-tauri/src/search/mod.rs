//! 快速打开的文件列表与项目文本搜索：按 `.gitignore` 等忽略规则遍历项目，始终排除 `.git`；
//! 搜索可取消，并限制文件大小和结果数量。忽略规则与文件树的隐藏规则相互独立。

use std::{
    collections::HashMap,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    workspace::WorkspaceState,
};

/// 快速打开最多列出的文件数。
const MAX_FILES: usize = 50_000;
/// 一次搜索最多收集的匹配数，达到后停止遍历。
const MAX_MATCHES: usize = 2_000;
/// 单个文件最多收集的匹配数。
const MAX_FILE_MATCHES: usize = 200;
/// 超过该大小的文件不搜索，计入跳过数。
const MAX_SEARCH_BYTES: u64 = 5 * 1024 * 1024;
/// 判断二进制时检查的开头字节数，与文件读取一致。
const SNIFF_BYTES: usize = 8 * 1024;
/// 预览中匹配前后保留的字节数，过长的行只显示匹配附近。
const CONTEXT_BYTES: usize = 80;
/// 预览中匹配文本最多保留的字节数。
const MATCH_BYTES: usize = 200;

/// 每个窗口当前搜索的编号；开始新搜索或取消时编号变化，进行中的旧搜索随即停止。
#[derive(Clone, Default)]
pub struct Searches(Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>);

impl Searches {
    fn counter(&self, label: &str) -> AppResult<Arc<AtomicU64>> {
        let mut searches = self
            .0
            .lock()
            .map_err(|_| AppError::new("SEARCH", "搜索暂时不可用，请重新启动 Nib。"))?;
        Ok(searches.entry(label.to_owned()).or_default().clone())
    }

    /// 开始新搜索，让该窗口之前的搜索停止；返回新搜索的编号和计数器。
    fn begin(&self, label: &str) -> AppResult<(u64, Arc<AtomicU64>)> {
        let counter = self.counter(label)?;
        let ticket = counter.fetch_add(1, Ordering::SeqCst) + 1;
        Ok((ticket, counter))
    }

    /// 取消该窗口进行中的搜索。
    pub fn cancel(&self, label: &str) -> AppResult<()> {
        self.counter(label)?.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// 窗口销毁后移除记录。
    pub fn remove(&self, label: &str) {
        if let Ok(mut searches) = self.0.lock() {
            if let Some(counter) = searches.remove(label) {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
}

/// 快速打开使用的项目文件，路径相对项目根目录，按路径排序。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub files: Vec<String>,
    /// 文件过多，只返回了前一部分。
    pub truncated: bool,
}

/// 文本搜索选项。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    /// 同时搜索被 `.gitignore` 等规则忽略的文件。
    pub include_ignored: bool,
}

/// 一处匹配。位置以 UTF-16 计算，与编辑器一致。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 行号，从 1 开始。
    pub line: u32,
    /// 匹配在行内的起始列。
    pub column: u32,
    pub length: u32,
    /// 预览：匹配前、匹配本身、匹配后的文本；过长时截断并以 … 标出。
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// 一个文件中的匹配。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<SearchMatch>,
    /// 该文件匹配过多，只列出前一部分。
    pub truncated: bool,
}

/// 搜索结果，按文件路径排序。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    /// 收集到的匹配数。
    pub total: usize,
    /// 匹配过多，遍历提前结束。
    pub truncated: bool,
    /// 过大或不是 UTF-8 编码而未搜索的文件数。
    pub skipped: usize,
}

/// 按忽略规则遍历项目；`.git` 与 macOS 的 `.DS_Store` 始终排除，其余隐藏文件照常列出。
fn walker(root: &Path, include_ignored: bool) -> WalkBuilder {
    let respect = !include_ignored;
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(respect)
        .git_global(respect)
        .git_exclude(respect)
        .ignore(respect)
        .parents(respect)
        // 项目不是 Git 仓库时同样尊重其中的 .gitignore。
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| {
            let name = entry.file_name();
            name != ".git" && name != ".DS_Store"
        });
    builder
}

/// 相对项目根目录、以 / 分隔的路径；非 Unicode 路径返回空。
fn relative(root: &Path, path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.strip_prefix(root).ok()?.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn project_root(state: &WorkspaceState, id: u64) -> AppResult<PathBuf> {
    Ok(PathBuf::from(state.lock()?.root_text(id)?))
}

/// 项目中的普通文件（不含符号链接），供快速打开按名称过滤。
pub fn files(state: &WorkspaceState, id: u64) -> AppResult<FileList> {
    let root = project_root(state, id)?;
    let mut files = Vec::new();
    let mut truncated = false;
    for entry in walker(&root, false).build().flatten() {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(path) = relative(&root, entry.path()) else {
            continue;
        };
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        files.push(path);
    }
    files.sort();
    Ok(FileList { files, truncated })
}

/// 按选项构造匹配规则；非正则搜索按字面匹配。
fn matcher(query: &str, options: &SearchOptions) -> AppResult<Regex> {
    let pattern = if options.regex {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|error| AppError::new("SEARCH", format!("正则表达式无效：{error}")))
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_boundary(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// 一行中匹配位置附近的预览文本；行首空白去掉，截断处以 … 标出。
fn preview(line: &str, start: usize, end: usize) -> (String, String, String) {
    let from = floor_boundary(line, start.saturating_sub(CONTEXT_BYTES));
    let mut before = line[from..start].trim_start().to_owned();
    if from > 0 {
        before.insert(0, '…');
    }
    let cut = ceil_boundary(line, (start + MATCH_BYTES).min(end));
    let mut matched = line[start..cut].to_owned();
    if cut < end {
        matched.push('…');
    }
    let to = ceil_boundary(line, (end + CONTEXT_BYTES).min(line.len()));
    let mut after = if cut < end {
        String::new()
    } else {
        line[end..to].trim_end().to_owned()
    };
    if cut == end && to < line.len() {
        after.push('…');
    }
    (before, matched, after)
}

/// 文件中的匹配；文件过大、不是 UTF-8 时返回 Err(()) 计入跳过，二进制文件返回空。
fn search_file(path: &Path, regex: &Regex) -> Result<(Vec<SearchMatch>, bool), ()> {
    let Ok(file) = std::fs::File::open(path) else {
        return Ok((Vec::new(), false));
    };
    if file
        .metadata()
        .map(|metadata| metadata.len() > MAX_SEARCH_BYTES)
        .unwrap_or(true)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    if file
        .take(MAX_SEARCH_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Ok((Vec::new(), false));
    }
    if bytes.len() as u64 > MAX_SEARCH_BYTES {
        return Err(());
    }
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return Ok((Vec::new(), false));
    }
    let text = String::from_utf8(bytes).map_err(|_| ())?;
    if !regex.is_match(&text) {
        return Ok((Vec::new(), false));
    }
    // 与编辑器一致：去掉 BOM，换行统一为 LF，行号和列号才能对上。
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let text = if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_owned()
    };
    let mut matches = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        // 按顺序累加 UTF-16 列，避免长行中每处匹配都从行首重新计算。
        let (mut byte, mut column) = (0, 0);
        for found in regex.find_iter(line) {
            if found.start() == found.end() {
                continue;
            }
            if matches.len() >= MAX_FILE_MATCHES {
                return Ok((matches, true));
            }
            column += line[byte..found.start()].encode_utf16().count();
            byte = found.start();
            let (before, matched, after) = preview(line, found.start(), found.end());
            matches.push(SearchMatch {
                line: index as u32 + 1,
                column: column as u32,
                length: found.as_str().encode_utf16().count() as u32,
                before,
                matched,
                after,
            });
        }
    }
    Ok((matches, false))
}

/// 在项目中搜索文本。并行遍历文件，匹配数达到上限或被取消时提前结束；取消时返回 CANCELLED。
pub fn search(
    state: &WorkspaceState,
    searches: &Searches,
    label: &str,
    id: u64,
    query: &str,
    options: &SearchOptions,
) -> AppResult<SearchResult> {
    let (ticket, current) = searches.begin(label)?;
    let root = project_root(state, id)?;
    if query.is_empty() {
        return Ok(SearchResult {
            files: Vec::new(),
            total: 0,
            truncated: false,
            skipped: 0,
        });
    }
    let regex = matcher(query, options)?;
    let results = Mutex::new(Vec::new());
    let total = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    walker(&root, options.include_ignored)
        .build_parallel()
        .run(|| {
            let (root, regex, results, total, skipped, truncated, current) = (
                &root, &regex, &results, &total, &skipped, &truncated, &current,
            );
            Box::new(move |entry| {
                if current.load(Ordering::SeqCst) != ticket {
                    return WalkState::Quit;
                }
                if total.load(Ordering::SeqCst) >= MAX_MATCHES {
                    truncated.store(true, Ordering::SeqCst);
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                let Some(path) = relative(root, entry.path()) else {
                    return WalkState::Continue;
                };
                match search_file(entry.path(), regex) {
                    Ok((matches, _)) if matches.is_empty() => {}
                    Ok((matches, more)) => {
                        total.fetch_add(matches.len(), Ordering::SeqCst);
                        if let Ok(mut results) = results.lock() {
                            results.push(FileMatches {
                                path,
                                matches,
                                truncated: more,
                            });
                        }
                    }
                    Err(()) => {
                        skipped.fetch_add(1, Ordering::SeqCst);
                    }
                }
                WalkState::Continue
            })
        });
    if current.load(Ordering::SeqCst) != ticket {
        return Err(AppError::new("CANCELLED", "搜索已取消。"));
    }
    let mut files = results
        .into_inner()
        .map_err(|_| AppError::new("SEARCH", "搜索失败，请重试。"))?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(SearchResult {
        files,
        total: total.into_inner(),
        truncated: truncated.into_inner(),
        skipped: skipped.into_inner(),
    })
}

//! 系统字体列表：WebView 不提供系统字体，由 Rust 扫描系统与用户字体目录得到字体家族名，供设置中的字体选择。

use std::{collections::BTreeMap, sync::OnceLock};

use fontdb::{Database, Language};
use serde::Serialize;

use super::font_char;

/// 最多返回的字体家族数。
const MAX_FAMILIES: usize = 3000;

/// 中文名称对应的语言，按优先顺序排列。
const CHINESE: [Language; 5] = [
    Language::Chinese_PeoplesRepublicOfChina,
    Language::Chinese_Singapore,
    Language::Chinese_Taiwan,
    Language::Chinese_HongKongSAR,
    Language::Chinese_MacaoSAR,
];

/// 一个字体家族。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    /// 英文家族名，作为 CSS font-family 使用。
    pub name: String,
    /// 字体自带的中文名称；没有时为 None。
    pub local: Option<String>,
    /// 任一字重为等宽字体。
    pub monospaced: bool,
}

static FAMILIES: OnceLock<Vec<FontFamily>> = OnceLock::new();

/// 本机已安装的字体家族，按名称排序；首次调用时扫描，之后返回同一结果，新安装的字体需重启 Nib 后出现。
///
/// 跳过以 `.` 开头的系统内部字体，以及含设置不接受字符的名称。
pub fn system_fonts() -> Vec<FontFamily> {
    FAMILIES.get_or_init(scan).clone()
}

fn scan() -> Vec<FontFamily> {
    let mut database = Database::new();
    database.load_system_fonts();
    let mut families: BTreeMap<String, FontFamily> = BTreeMap::new();
    for face in database.faces() {
        // 第一个名称为英文名，没有英文名时为字体中的第一个名称。
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || name.starts_with('.') || !name.chars().all(font_char) {
            continue;
        }
        let local = CHINESE.iter().find_map(|language| {
            face.families
                .iter()
                .find(|(local, item)| item == language && local != name)
                .map(|(local, _)| local.trim().to_owned())
        });
        let entry = families
            .entry(name.to_lowercase())
            .or_insert_with(|| FontFamily {
                name: name.to_owned(),
                local: None,
                monospaced: false,
            });
        entry.monospaced |= face.monospaced;
        if entry.local.is_none() {
            entry.local = local.filter(|local| !local.is_empty());
        }
    }
    families.into_values().take(MAX_FAMILIES).collect()
}

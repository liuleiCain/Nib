//! 用户设置（编辑器与 Git 显示偏好）：带版本号的 `~/.nib/settings.json`，与会话记录、恢复数据和项目文件分开存放，所有窗口共用。

pub mod fonts;

use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};

use crate::{
    common::write_atomic,
    error::{AppError, AppResult},
};

const VERSION: u32 = 1;
/// 字号范围，与界面调整范围一致。
const FONT_SIZE: (u32, u32) = (10, 24);
/// 可选的缩进宽度。
const TAB_SIZES: [u32; 3] = [2, 4, 8];
const MAX_FONT_FAMILY: usize = 200;

/// 字体名称允许的字符，避免写入的值改变界面其他样式。
fn font_char(character: char) -> bool {
    character.is_alphanumeric() || " ,-_.'\"".contains(character)
}

/// 用户设置；缺少的字段按默认值读取，便于后续版本增加设置项。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// 编辑器字体（CSS font-family）；为空时使用内置的等宽字体。
    pub font_family: String,
    pub font_size: u32,
    /// 缩进宽度，同时作为 Tab 的显示宽度。
    pub tab_size: u32,
    pub wrap: bool,
    pub auto_save: bool,
    /// 提交面板按目录分组显示变更文件。
    pub change_tree: bool,
    /// Diff 使用统一视图，否则左右对比。
    pub unified_diff: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: VERSION,
            font_family: String::new(),
            font_size: 13,
            tab_size: 4,
            wrap: false,
            auto_save: true,
            change_tree: false,
            unified_diff: false,
        }
    }
}

impl Settings {
    /// 校验取值；字体只允许常见字符，避免写入的值改变界面其他样式。
    fn checked(mut self) -> AppResult<Self> {
        self.version = VERSION;
        self.font_family = self.font_family.trim().to_owned();
        let font_ok = self.font_family.chars().count() <= MAX_FONT_FAMILY
            && self.font_family.chars().all(font_char);
        if !font_ok {
            return Err(AppError::new(
                "SETTINGS",
                "字体名称只能包含文字、数字、空格、逗号、引号、点、- 和 _，最长 200 个字符。",
            ));
        }
        if !(FONT_SIZE.0..=FONT_SIZE.1).contains(&self.font_size) {
            return Err(AppError::new(
                "SETTINGS",
                format!("字号须在 {} 到 {} 之间。", FONT_SIZE.0, FONT_SIZE.1),
            ));
        }
        if !TAB_SIZES.contains(&self.tab_size) {
            return Err(AppError::new("SETTINGS", "缩进宽度只能是 2、4 或 8。"));
        }
        Ok(self)
    }
}

/// 设置的读写，持锁写入保证多窗口的写入顺序。
pub struct SettingsStore {
    path: PathBuf,
    data: Mutex<Settings>,
}

impl SettingsStore {
    /// 读取设置文件；缺失、损坏、版本不符或取值无效时使用默认设置，下次保存时覆盖。
    pub fn load(directory: PathBuf) -> Self {
        let path = directory.join("settings.json");
        let data = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .filter(|settings| settings.version == VERSION)
            .and_then(|settings| settings.checked().ok())
            .unwrap_or_default();
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn data(&self) -> AppResult<std::sync::MutexGuard<'_, Settings>> {
        self.data
            .lock()
            .map_err(|_| AppError::new("SETTINGS", "设置暂时不可用，请重新启动 Nib。"))
    }

    pub fn get(&self) -> AppResult<Settings> {
        Ok(self.data()?.clone())
    }

    /// 校验后写盘，返回保存后的设置；写入失败时内存中的设置不变。
    pub fn save(&self, settings: Settings) -> AppResult<Settings> {
        let settings = settings.checked()?;
        let mut data = self.data()?;
        let bytes = serde_json::to_vec_pretty(&settings)
            .map_err(|_| AppError::new("SETTINGS", "设置序列化失败。"))?;
        write_atomic(&self.path, &bytes)?;
        *data = settings.clone();
        Ok(settings)
    }
}

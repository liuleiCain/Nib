use serde::Serialize;

/// 将后台失败转为前端可识别的错误，不暴露不必要的系统信息。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    /// 同时携带稳定错误码和面向用户的说明，供 IPC 序列化。
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        Self::new("WINDOW", format!("窗口操作失败：{error}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO", format!("文件操作失败：{error}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;

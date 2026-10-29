mod commands;
mod error;
mod filesystem;
mod workspace;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 注册工作区命令，并让正常退出先经过未保存内容确认。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::WorkspaceState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::list_directory,
            commands::read_file,
            commands::save_file,
        ])
        .build(tauri::generate_context!())
        .expect("Nib 启动失败")
        .run(|app, event| {
            // 菜单退出与 Cmd+Q 也走前端未保存确认；窗口销毁后才允许退出。
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app.get_webview_window("main").is_some() {
                    api.prevent_exit();
                    let _ = app.emit("nib://request-close", ());
                }
            }
        });
}

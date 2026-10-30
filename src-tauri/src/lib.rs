mod commands;
mod error;
mod filesystem;
mod git;
mod session;
mod watcher;
mod window;
mod workspace;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use git::GitLocks;
use session::SessionStore;
use watcher::Watchers;
use workspace::Workspaces;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 注册工作区命令，恢复上次打开的项目窗口，并让正常退出先经过未保存内容确认。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Workspaces::default())
        .manage(Watchers::default())
        .manage(GitLocks::default())
        .setup(|app| {
            // 会话数据放在用户目录的 .nib 下，删除该目录即清空所有记录。
            let sessions = Arc::new(SessionStore::load(app.path().home_dir()?.join(".nib")));
            app.manage(sessions.clone());
            // 只恢复目录仍可访问的项目，其余从下次恢复列表中移除。
            let mut roots: Vec<String> = Vec::new();
            for root in sessions.open_projects() {
                if let Ok((_, text)) = workspace::canonical_root(&root) {
                    if !roots.contains(&text) {
                        roots.push(text);
                    }
                }
            }
            // 单个项目窗口创建失败时跳过；全部失败或没有可恢复项目时打开空窗口。
            roots.retain(|root| window::create(app.handle(), Some(root.clone())).is_ok());
            // 恢复列表写入失败不影响本次启动。
            let _ = sessions.retain_open(&roots);
            if roots.is_empty() {
                window::create(app.handle(), None).map_err(|error| error.message)?;
            }
            Ok(())
        })
        .on_window_event(|target, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window::destroyed(target.app_handle(), target.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::window_startup,
            commands::open_project,
            commands::open_project_window,
            commands::new_window,
            commands::close_project,
            commands::recent_projects,
            commands::forget_project,
            commands::save_tabs,
            commands::cancel_quit,
            commands::list_directory,
            commands::read_file,
            commands::save_file,
            commands::git_status,
            commands::git_diff,
            commands::git_head_file,
            commands::git_commit,
            commands::git_restore,
            commands::git_add,
            commands::git_rollback,
            commands::git_ignore,
            commands::git_log,
            commands::git_commit_detail,
            commands::git_commit_diff,
            commands::git_branches,
            commands::git_create_branch,
            commands::git_switch_branch,
            commands::git_checkout_remote,
            commands::git_rename_branch,
            commands::git_delete_branch,
            commands::git_delete_remote_branch,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::git_merge,
            commands::git_rebase,
            commands::git_resolve,
            commands::git_continue,
            commands::git_skip,
            commands::git_abort,
            commands::create_entry,
            commands::rename_entry,
            commands::trash_entry,
            commands::reveal_entry,
        ])
        .build(tauri::generate_context!())
        .expect("Nib 启动失败")
        .run(|app, event| {
            // 菜单退出与 Cmd+Q 也走各窗口的未保存确认；窗口全部销毁后才允许退出。
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.webview_windows().is_empty() {
                    api.prevent_exit();
                    app.state::<Arc<SessionStore>>().set_quitting(true);
                    let _ = app.emit("nib://request-close", ());
                }
            }
        });
}

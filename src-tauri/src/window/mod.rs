use std::sync::Arc;

use tauri::{AppHandle, LogicalSize, Manager, PhysicalSize, WebviewWindow, WebviewWindowBuilder};

use crate::{
    error::{AppError, AppResult},
    search::Searches,
    session::SessionStore,
    watcher::Watchers,
    workspace::Workspaces,
};

/// 按 `tauri.conf.json` 的窗口模板创建项目窗口；pending 为窗口加载后要打开的项目。
///
/// macOS 上新窗口并入当前窗口的标签组，项目显示为窗口顶部标签；其他平台为独立窗口。
pub fn create(app: &AppHandle, pending: Option<String>) -> AppResult<()> {
    let workspaces = app.state::<Workspaces>();
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| AppError::new("WINDOW", "缺少窗口配置。"))?;
    // 先选定要并入的窗口，避免选中新窗口自身：优先当前聚焦窗口，否则取最近创建的窗口，
    // 使启动恢复时标签按原顺序排列。
    let windows = app.webview_windows();
    let anchor = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| {
            windows.values().max_by_key(|window| {
                window
                    .label()
                    .strip_prefix("window-")
                    .and_then(|number| number.parse::<u64>().ok())
                    .unwrap_or(0)
            })
        })
        .cloned();
    // 使用上次记录的窗口尺寸，不小于配置的最小尺寸；显示前再按屏幕大小收缩。
    if let Ok(layout) = app.state::<Arc<SessionStore>>().layout() {
        if let (Some(width), Some(height)) = (layout.width, layout.height) {
            config.width = f64::from(width).max(config.min_width.unwrap_or(0.0));
            config.height = f64::from(height).max(config.min_height.unwrap_or(0.0));
        }
    }
    let label = workspaces.register(pending)?;
    config.label = label.clone();
    // 并入标签组后再显示，避免先闪现一个独立窗口。
    config.visible = false;
    let window =
        match WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build()) {
            Ok(window) => window,
            Err(error) => {
                workspaces.remove(&label);
                return Err(error.into());
            }
        };
    fit_monitor(&window);
    present(app, window, anchor)
}

/// 记录的尺寸来自更大的显示器时，收缩到当前显示器之内。
fn fit_monitor(window: &WebviewWindow) {
    let (Ok(Some(monitor)), Ok(size), Ok(scale)) = (
        window.current_monitor(),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let current = size.to_logical::<f64>(scale);
    if current.width > screen.width || current.height > screen.height {
        let _ = window.set_size(LogicalSize::new(
            current.width.min(screen.width),
            current.height.min(screen.height),
        ));
    }
}

/// 窗口尺寸变化时记录逻辑尺寸；最大化、全屏和最小化时不记录，保留普通窗口的尺寸。
pub fn resized(window: &tauri::Window, size: PhysicalSize<u32>) {
    let normal = !window.is_maximized().unwrap_or(true)
        && !window.is_fullscreen().unwrap_or(true)
        && !window.is_minimized().unwrap_or(true);
    if !normal || size.width == 0 || size.height == 0 {
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    window
        .app_handle()
        .state::<Arc<SessionStore>>()
        .resized(logical.width.round() as u32, logical.height.round() as u32);
}

/// 在主线程将窗口并入 anchor 的标签组并显示；并入失败时作为独立窗口显示。
#[cfg(target_os = "macos")]
fn present(app: &AppHandle, window: WebviewWindow, anchor: Option<WebviewWindow>) -> AppResult<()> {
    let fallback = window.clone();
    let shown = app.run_on_main_thread(move || {
        if let Some(anchor) = anchor {
            let _ = add_tab(&anchor, &window);
        }
        let _ = window.show();
        let _ = window.set_focus();
    });
    if shown.is_err() {
        fallback.show()?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn present(
    _app: &AppHandle,
    window: WebviewWindow,
    _anchor: Option<WebviewWindow>,
) -> AppResult<()> {
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// 把 window 作为标签加入 anchor 所在的原生标签组，须在主线程调用。
#[cfg(target_os = "macos")]
fn add_tab(anchor: &WebviewWindow, window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    let anchor = anchor.ns_window()? as *const NSWindow;
    let window = window.ns_window()? as *const NSWindow;
    // SAFETY: 两个句柄都来自仍存活的 Tauri 窗口，调用方保证位于主线程。
    unsafe { (*anchor).addTabbedWindow_ordered(&*window, NSWindowOrderingMode::Above) };
    Ok(())
}

/// 恢复并聚焦已打开该项目的窗口。
pub fn focus(app: &AppHandle, label: &str) -> AppResult<()> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| AppError::new("WINDOW", "项目窗口已关闭，请重试。"))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// 窗口销毁后停止项目监听、搜索并释放工作区，写入窗口尺寸。
///
/// 退出应用或关闭最后一个窗口时保留项目，下次启动恢复；其余情况视为关闭项目。
pub fn destroyed(app: &AppHandle, label: &str) {
    let workspaces = app.state::<Workspaces>();
    let sessions = app.state::<Arc<SessionStore>>();
    if !sessions.quitting() && workspaces.has_others(label) {
        let root = workspaces
            .get(label)
            .and_then(|state| Ok(state.lock()?.current_root()));
        if let Ok(Some(root)) = root {
            // 窗口已销毁，写入失败没有可提示的界面，下次启动会重新校验项目目录。
            let _ = sessions.closed(&root);
        }
    }
    let _ = sessions.flush();
    app.state::<Watchers>().stop(label);
    app.state::<Searches>().remove(label);
    workspaces.remove(label);
}

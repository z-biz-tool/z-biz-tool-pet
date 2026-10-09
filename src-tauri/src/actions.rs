//! 托盘与快捷键共用的动作集合。
//!
//! Electron 侧这两处分别叫 `trayContext()`（index.ts）和 `ShortcutDeps`（shortcut-manager.ts），
//! 内容高度重叠，当年就是靠它们把菜单和快捷键绑到同一批能力上的。这里合并成一个模块，
//! 菜单项和加速键处理函数都调同一组函数，避免出现"托盘能做、快捷键做不到"的分叉。

use tauri::{AppHandle, Emitter, Manager};

use crate::{runtime, state};

const PET: &str = "pet";
const ADMIN: &str = "admin";

pub fn pet_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(PET)
}

pub fn show_admin(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(ADMIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        // 管理端是延迟创建的（T3.11 的对应物）：这里只能提示渲染层还不存在。
        // 窗口列表由 tauri.conf.json 决定，Tauri 的 WebviewWindowBuilder 在 setup 后
        // 也能动态建窗，但动态建窗要重新挂事件处理，统一交给 P2 之后的窗口工厂。
        eprintln!("[Z-Bot] 管理端窗口尚未创建");
    }
}

/// 托盘「设置」= 打开管理端并让它切到设置页（Electron: webContents.send('open:settings')）
pub fn open_settings(app: &AppHandle) {
    show_admin(app);
    if let Some(w) = app.get_webview_window(ADMIN) {
        let _ = w.emit("open:settings", ());
    }
}

/// 显示萌宠（不抢前台焦点，宠物不该为了出现而打断用户）。
/// Tauri 没有 Show/Hide 窗口事件，鼠标推送与位置落盘由这些主动收发的地方挂钩。
pub fn show_pet(app: &AppHandle) {
    if let Some(w) = pet_window(app) {
        let _ = w.show();
    }
    runtime::note_pet_shown(app);
}

pub fn toggle_pet(app: &AppHandle) {
    let Some(w) = pet_window(app) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        runtime::note_pet_hidden(app);
    } else {
        let _ = w.show();
        runtime::note_pet_shown(app);
    }
}

/// 对应 sendToWindows：两个窗口都收到
pub fn broadcast(app: &AppHandle, channel: &str) {
    if let Err(e) = app.emit(channel, ()) {
        eprintln!("[Z-Bot] 广播失败 {channel}: {e}");
    }
}

/// 唤醒宠物：显示 + 进入语音对话，和托盘「开始语音对话」是同一条链路
pub fn wake_pet(app: &AppHandle) {
    show_pet(app);
    broadcast(app, "voice:start");
}

pub fn set_stealth(app: &AppHandle, enabled: bool) -> bool {
    runtime::set_stealth(app, enabled)
}

pub fn set_click_through(app: &AppHandle, enabled: bool) -> bool {
    runtime::set_click_through(app, enabled)
}

// ---------- 便签（托盘「快速笔记」子菜单）----------

/// 托盘只展示最近 8 条，且**新的在前**（Electron: listRecentQuickNotes = slice(-8).reverse()）
pub fn list_notes() -> Vec<serde_json::Value> {
    let pins = state::read_list(state::pins_file());
    let n = pins.len();
    let mut recent: Vec<serde_json::Value> = pins.into_iter().skip(n.saturating_sub(8)).collect();
    recent.reverse();
    recent
}

pub fn clear_notes() {
    state::write_list(state::pins_file(), vec![]);
}

pub fn copy_note(app: &AppHandle, content: &str) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(content)
        .map_err(|e| format!("写剪贴板失败: {e}"))
}

/// 快速笔记：把剪贴板文本存成一条 Pin。空剪贴板不写，返回错误给调用方决定文案。
pub fn capture_note(app: &AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app
        .clipboard()
        .read_text()
        .map_err(|e| format!("读剪贴板失败: {e}"))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("剪贴板是空的".to_string());
    }
    let content: String = trimmed.chars().take(2000).collect();
    state::add_pin(&content);
    Ok(content)
}

/// 退出前把位置落盘。Electron 用 isQuitting 标记区分"关窗"和"真退"，
/// Tauri 侧管理端的关闭拦截写在 lib.rs 的 on_window_event 里，与此无关。
pub fn quit(app: &AppHandle) {
    runtime::flush_pet_bounds(app);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn note_menu_shows_only_the_last_eight() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-actions-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        crate::store::invalidate(&state::pins_file());
        for i in 0..12 {
            state::add_pin(&format!("笔记 {i}"));
        }
        let notes = list_notes();
        assert_eq!(notes.len(), 8, "托盘只该给最近 8 条");
        assert_eq!(notes[0]["content"], json!("笔记 11"), "新的在前");
        assert_eq!(notes[7]["content"], json!("笔记 4"));
        clear_notes();
        assert!(list_notes().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

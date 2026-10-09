//! 托盘菜单：对照 src/main/tray-manager.ts（T3.12，修复 D15 的 70 行重复实现）。
//!
//! 这里的菜单是"动作集合 + 当前状态"的一次快照：状态变了就整份重建（refresh_menu），
//! 和 Electron 版每次 click 后 setContextMenu(buildTrayMenu(...)) 的做法一致。
//! CheckMenuItem 被点击时 muda 会自己翻一次勾，所以重建前不能读它的 checked 值 ——
//! 统一以 runtime/actions 里的状态为准取反，避免"菜单显示的和真实的不一样"。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::{actions, runtime, shortcuts, state};

pub const TRAY_ID: &str = "z-bot-tray";

/// 便签条目前 28 个字符（Electron 是 slice(0,28)，这里按字符切，中文不会被切成半个）
const NOTE_LABEL_CHARS: usize = 28;

fn note_label(content: &str) -> String {
    // 对应 Electron 的 replace(/\s+/g,' ')：连续空白压成一个空格，顺带去掉首尾
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = flat.as_str();
    if trimmed.is_empty() {
        return "(空白的笔记)".to_string();
    }
    let head: String = trimmed.chars().take(NOTE_LABEL_CHARS).collect();
    let mut out = head;
    if trimmed.chars().count() > NOTE_LABEL_CHARS {
        out.push('…');
    }
    out
}

fn notes_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let sub = Submenu::new(app, "📝 快速笔记", true)?;
    let notes = actions::list_notes();
    if notes.is_empty() {
        sub.append(&MenuItem::with_id(app, "note-empty", "暂无笔记", false, None::<&str>)?)?;
        sub.append(&MenuItem::with_id(
            app,
            "note-hint",
            "复制文字后按「快速笔记」快捷键即可存入",
            false,
            None::<&str>,
        )?)?;
        return Ok(sub);
    }
    for note in &notes {
        let id = note.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let content = note.get("content").and_then(|v| v.as_str()).unwrap_or("");
        sub.append(&MenuItem::with_id(
            app,
            format!("note:{id}"),
            note_label(content),
            true,
            None::<&str>,
        )?)?;
    }
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&MenuItem::with_id(
        app,
        "note-count",
        format!("共 {} 条 · 点击复制", notes.len()),
        false,
        None::<&str>,
    )?)?;
    sub.append(&MenuItem::with_id(app, "clear-notes", "清空全部笔记", true, None::<&str>)?)?;
    Ok(sub)
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let hint = shortcuts::pet_toggle_hint(app);
    let visible = actions::pet_window(app)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let pet_text = if visible { "🐱 隐藏萌宠" } else { "🐱 显示萌宠" };
    menu.append(&MenuItem::with_id(
        app,
        "show-pet",
        format!("{pet_text}{hint}"),
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(app, "show-admin", "💻 打开管理端", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "voice-start", "🎙️ 开始语音对话", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "voice-stop", "⏹️ 停止语音对话", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&notes_submenu(app)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "stealth",
        "🕵️ 截图隐身",
        true,
        runtime::is_stealth(),
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "click-through",
        "🫥 点击穿透",
        true,
        runtime::is_click_through(),
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "settings", "⚙️ 设置", true, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "autostart",
        "🚀 开机自启",
        true,
        is_autostart_enabled(app),
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "❌ 退出", true, None::<&str>)?)?;
    Ok(menu)
}

/// 开机自启：Electron 用 app.getLoginItemSettings/setLoginItemSettings，
/// Tauri 侧对应 tauri-plugin-autostart（Windows 写 HKCU 的 Run 键，可逆）。
fn is_autostart_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn set_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    if let Err(e) = result {
        eprintln!("[Z-Bot Tray] 开机自启设置失败: {e}");
    }
}

fn copy_note_by_id(app: &AppHandle, note_id: &str) {
    let pin = state::read_list(state::pins_file())
        .into_iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(note_id));
    match pin {
        Some(p) => {
            let content = p.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if let Err(e) = actions::copy_note(app, content) {
                eprintln!("[Z-Bot Tray] {e}");
            }
        }
        None => eprintln!("[Z-Bot Tray] 便签已不存在: {note_id}"),
    }
}

/// 菜单项 id → 动作。与 trayContext() 的回调一一对应，做完就重建菜单。
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        "show-pet" => actions::toggle_pet(app),
        "show-admin" => actions::show_admin(app),
        "voice-start" => actions::broadcast(app, "voice:start"),
        "voice-stop" => actions::broadcast(app, "voice:stop"),
        "settings" => actions::open_settings(app),
        "clear-notes" => {
            actions::clear_notes();
        }
        "stealth" => {
            actions::set_stealth(app, !runtime::is_stealth());
        }
        "click-through" => {
            actions::set_click_through(app, !runtime::is_click_through());
        }
        "autostart" => set_autostart(app, !is_autostart_enabled(app)),
        "quit" => {
            actions::quit(app);
            return false; // 退出后不必重建菜单
        }
        other => {
            if let Some(note_id) = other.strip_prefix("note:") {
                if !note_id.is_empty() {
                    copy_note_by_id(app, note_id);
                    return false; // 复制不改列表，省一次重建
                }
            }
            return false;
        }
    }
    true
}

/// 托盘图标：tauri 2.12 没有 include_image! 宏，这里把 32x32 的 PNG 直接嵌进二进制，
/// 再由 image-png 特性解出来 —— 与 Electron 版的内联 base64 图标同一思路，不再依赖安装目录里的文件。
fn tray_icon() -> tauri::image::Image<'static> {
    static BYTES: &[u8] = include_bytes!("../icons/32x32.png");
    tauri::image::Image::from_bytes(BYTES).expect("托盘图标不可用")
}

/// 建托盘。失败不影响主流程：Electron 版同样降级为"只有快捷键"，宠物照常显示。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Z-Bot 桌面助手")
        .icon(tray_icon())
        .on_menu_event(|inner, event| {
            if handle_menu_event(inner, event.id.as_ref()) {
                refresh_menu(inner);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Electron: tray.on('double-click') → 打开管理端
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                actions::show_admin(app);
            }
        })
        .build(app)?;
    Ok(())
}

/// 便签增删、隐身/穿透切换之后重建菜单（菜单项是打开时的快照）
pub fn refresh_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("[Z-Bot Tray] 菜单刷新失败: {e}");
                }
            }
            Err(e) => eprintln!("[Z-Bot Tray] 菜单构建失败: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_label_collapses_whitespace_and_truncates() {
        assert_eq!(note_label("hello   world"), "hello world");
        assert_eq!(note_label("   \n\t "), "(空白的笔记)");
        let long = "一".repeat(40);
        let label = note_label(&long);
        assert_eq!(label.chars().count(), NOTE_LABEL_CHARS + 1, "截到 28 字再加省略号");
        assert!(label.ends_with('…'));
        assert_eq!(note_label(&"二".repeat(NOTE_LABEL_CHARS)), "二".repeat(NOTE_LABEL_CHARS));
    }
}

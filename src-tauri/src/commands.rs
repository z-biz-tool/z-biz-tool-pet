//! 窗口与宠物位姿相关的命令。
//! 逐条对照 src/main/window-manager.ts 的 ipcMain 端点移植，channel 名保持不变，
//! 渲染进程垫片（src/renderer/shared/tauri-bridge.ts）按「: → _」映射到这里的函数名。

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};

const PET: &str = "pet";
const ADMIN: &str = "admin";

fn window(app: &tauri::AppHandle, mode: &str) -> Result<WebviewWindow, String> {
    let label = match mode {
        PET | ADMIN => mode,
        other => return Err(format!("未知窗口: {other}")),
    };
    app.get_webview_window(label)
        .ok_or_else(|| format!("窗口不存在或已销毁: {label}"))
}

/// 以窗口当前所在显示器的工作区做边界约束。
/// 这里比 Electron 版更严谨：Electron 的 movePet 只取 workAreaSize 而没加 workArea 原点，
/// 副屏（负偏移）会算错，本函数用 work_area().position 作为原点。
fn clamp_in_work_area(w: &WebviewWindow, x: i32, y: i32, win_w: i32, win_h: i32) -> (i32, i32) {
    match w.current_monitor() {
        Ok(Some(m)) => {
            let wa = m.work_area();
            let min_x = wa.position.x;
            let min_y = wa.position.y;
            let max_x = min_x + wa.size.width as i32 - win_w;
            let max_y = min_y + wa.size.height as i32 - win_h;
            (
                x.clamp(min_x, max_x.max(min_x)),
                y.clamp(min_y, max_y.max(min_y)),
            )
        }
        _ => (x, y),
    }
}

/// Electron: app:getMode
#[tauri::command]
pub fn app_get_mode(app: tauri::AppHandle) -> String {
    match app.get_webview_window(ADMIN) {
        Some(w) if w.is_visible().unwrap_or(false) => ADMIN.to_string(),
        _ => PET.to_string(),
    }
}

/// Electron: window:show（admin 走 show+focus，pet 走 showInactive）
#[tauri::command]
pub fn window_show(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let w = window(&app, &mode)?;
    w.show().map_err(|e| format!("show 失败: {e}"))?;
    if mode == ADMIN {
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        crate::runtime::note_pet_shown(&app);
    }
    Ok(())
}

/// Electron: window:hide
#[tauri::command]
pub fn window_hide(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    window(&app, &mode)?
        .hide()
        .map_err(|e| format!("hide 失败: {e}"))?;
    if mode == PET {
        crate::runtime::note_pet_hidden(&app);
    }
    Ok(())
}

/// Electron: window:toggle
#[tauri::command]
pub fn window_toggle(app: tauri::AppHandle, mode: String) -> Result<bool, String> {
    let w = window(&app, &mode)?;
    let visible = w.is_visible().map_err(|e| e.to_string())?;
    if visible {
        w.hide().map_err(|e| format!("hide 失败: {e}"))?;
        if mode == PET {
            crate::runtime::note_pet_hidden(&app);
        }
        return Ok(false);
    }
    w.show().map_err(|e| format!("show 失败: {e}"))?;
    if mode == ADMIN {
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        crate::runtime::note_pet_shown(&app);
    }
    Ok(true)
}

/// Electron: window:movePet —— 拖拽宠物时按增量移动并约束在本屏工作区内
#[tauri::command]
pub fn window_move_pet(app: tauri::AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    let w = window(&app, PET)?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    let (x, y) = clamp_in_work_area(
        &w,
        pos.x + delta_x,
        pos.y + delta_y,
        size.width as i32,
        size.height as i32,
    );
    w.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| format!("setPosition 失败: {e}"))
}

/// Electron: window:setPetPosition
#[tauri::command]
pub fn window_set_pet_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    let w = window(&app, PET)?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    let (cx, cy) = clamp_in_work_area(&w, x, y, size.width as i32, size.height as i32);
    w.set_position(tauri::PhysicalPosition::new(cx, cy))
        .map_err(|e| format!("setPosition 失败: {e}"))
}

/// Electron: pet:setPosition —— 同样落位，但把钳制后的坐标回给渲染进程
#[derive(Serialize)]
pub struct Positioned {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
pub fn pet_set_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<Positioned, String> {
    let w = window(&app, PET)?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    let (cx, cy) = clamp_in_work_area(&w, x, y, size.width as i32, size.height as i32);
    w.set_position(tauri::PhysicalPosition::new(cx, cy))
        .map_err(|e| format!("setPosition 失败: {e}"))?;
    Ok(Positioned { x: cx, y: cy })
}

/// Electron: pet:triggerAnimation —— 只投递给宠物窗口
#[tauri::command]
pub fn pet_trigger_animation(app: tauri::AppHandle, anim_type: String) -> Result<bool, String> {
    let w = window(&app, PET)?;
    w.emit("pet:triggerAnimation", &anim_type)
        .map_err(|e| format!("emit 失败: {e}"))?;
    Ok(true)
}

/// Electron: pet:toggleStealth —— 不传参数就取反，返回值是切换后的状态
#[tauri::command]
pub fn pet_toggle_stealth(app: tauri::AppHandle, enabled: Option<bool>) -> bool {
    let target = enabled.unwrap_or_else(|| !crate::runtime::is_stealth());
    let applied = crate::actions::set_stealth(&app, target);
    // 托盘里的「截图隐身」是 checkbox，状态变了要重建菜单
    crate::tray::refresh_menu(&app);
    applied
}

/// Electron: pet:getStealthMode
#[tauri::command]
pub fn pet_get_stealth_mode() -> bool {
    crate::runtime::is_stealth()
}

/// Electron: window:stickToEdge —— 贴到屏幕边缘时让它滑到工作区底部。
/// Electron 走 setBounds(rect, true) 让系统做动画，Tauri 的位置 API 没有动画开关，
/// 结果是同一位置、没有滑行动画。
#[tauri::command]
pub fn window_stick_to_edge(app: tauri::AppHandle) -> Result<(), String> {
    let w = window(&app, PET)?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    let (win_w, win_h) = (size.width as i32, size.height as i32);
    let Ok(Some(monitor)) = w.current_monitor() else {
        return Ok(()); // 拿不到工作区就不滑，行为与 Electron 里 display 缺失时一致
    };
    let wa = monitor.work_area();
    let (ax, ay) = (wa.position.x, wa.position.y);
    let (width, height) = (wa.size.width as i32, wa.size.height as i32);

    let at_left = pos.x - ax <= 5;
    let at_right = pos.x >= ax + width - win_w - 5;
    let at_top = pos.y - ay <= 5;
    let at_bottom = pos.y >= ay + height - win_h - 5;
    if !(at_left || at_right || at_top || at_bottom) {
        return Ok(());
    }
    let target_x = if at_left {
        ax
    } else if at_right {
        ax + width - win_w
    } else {
        pos.x
    };
    let target_y = ay + height - win_h;
    w.set_position(tauri::PhysicalPosition::new(target_x, target_y))
        .map_err(|e| format!("贴边失败: {e}"))
}


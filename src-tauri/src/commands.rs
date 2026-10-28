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

/// 抛掷物理要用的边界快照：窗口当前矩形 + 所在屏的工作区。
///
/// 只在**抛掷开始时取一次**，之后整段飞行都由渲染进程自己积分（physics.ts），
/// 逐帧只回传 `window_move_pet` 一个增量。若改成每帧都取工作区，
/// 一次抛掷要几十次 IPC，延迟会叠到肉眼可见。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionBounds {
    /// 工作区左上角（物理坐标，可能为负：副屏在主屏左侧时 x < 0）
    pub area_x: i32,
    pub area_y: i32,
    pub area_w: i32,
    pub area_h: i32,
    pub win_x: i32,
    pub win_y: i32,
    pub win_w: i32,
    pub win_h: i32,
}

#[tauri::command]
pub fn window_get_motion_bounds(app: tauri::AppHandle) -> Result<MotionBounds, String> {
    let w = window(&app, PET)?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    // 拿不到工作区就退化成「以窗口自身为界」——物理层会因此几乎不动，
    // 但绝不会把窗口甩到不可达的位置。多屏热插拔瞬间可能走这条。
    let (area_x, area_y, area_w, area_h) = match w.current_monitor() {
        Ok(Some(m)) => {
            let wa = m.work_area();
            (
                wa.position.x,
                wa.position.y,
                wa.size.width as i32,
                wa.size.height as i32,
            )
        }
        _ => (pos.x, pos.y, size.width as i32, size.height as i32),
    };
    Ok(MotionBounds {
        area_x,
        area_y,
        area_w,
        area_h,
        win_x: pos.x,
        win_y: pos.y,
        win_w: size.width as i32,
        win_h: size.height as i32,
    })
}

/// 把窗口拉回工作区中心（超过 25% 掉出屏幕时的自救，对应 VPet 的 ResetPosition）。
/// 返回拉回后的坐标，便于渲染进程记录。
#[tauri::command]
pub fn window_recover_position(app: tauri::AppHandle) -> Result<Positioned, String> {
    let w = window(&app, PET)?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    let (win_w, win_h) = (size.width as i32, size.height as i32);
    let Ok(Some(m)) = w.current_monitor() else {
        let pos = w.outer_position().map_err(|e| e.to_string())?;
        return Ok(Positioned { x: pos.x, y: pos.y });
    };
    let wa = m.work_area();
    let (ax, ay) = (wa.position.x, wa.position.y);
    let (aw, ah) = (wa.size.width as i32, wa.size.height as i32);
    // 落点取工作区底部往上 1/3 处：像「从桌上掉回来」，而不是凭空出现在正中
    let x = ax + ((aw - win_w) / 2).max(0);
    let y = ay + ((ah - win_h) * 2 / 3).max(0);
    let (cx, cy) = clamp_in_work_area(&w, x, y, win_w, win_h);
    w.set_position(tauri::PhysicalPosition::new(cx, cy))
        .map_err(|e| format!("回位失败: {e}"))?;
    Ok(Positioned { x: cx, y: cy })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// MotionBounds 的字段名是**渲染进程的契约**：physics.ts 直接按
    /// `b.areaX / b.winY` 读。一旦这里漏掉 rename_all 变回 snake_case，
    /// 前端拿到的是 undefined，抛掷物理会静默算出 NaN 坐标 —— 表现为
    /// 「甩出去之后她不见了」，没有任何报错。所以钉死这个形状。
    #[test]
    fn motion_bounds_serializes_camel_case_for_the_renderer() {
        let b = MotionBounds {
            area_x: -1920,
            area_y: 0,
            area_w: 1920,
            area_h: 1080,
            win_x: 100,
            win_y: 200,
            win_w: 268,
            win_h: 512,
        };
        let v = serde_json::to_value(&b).unwrap();
        // 每个 snake_case 原名都不该出现
        for raw in ["area_x", "area_y", "area_w", "area_h", "win_x", "win_y", "win_w", "win_h"] {
            assert!(v.get(raw).is_none(), "字段名 {raw} 泄漏到了前端");
        }
        // 前端读的每一个键都必须在
        for key in ["areaX", "areaY", "areaW", "areaH", "winX", "winY", "winW", "winH"] {
            assert!(v.get(key).is_some(), "缺少前端契约字段 {key}");
        }
        // 副屏负偏移不能被当成 0 或 None 丢掉
        assert_eq!(v["areaX"], serde_json::json!(-1920));
        assert_eq!(v["winY"], serde_json::json!(200));
    }

    /// Positioned 是 pet_set_position / window_recover_position 的返回值，
    /// 同样直接被渲染进程读。字段名保持 x/y（本就是单字符，无蛇形风险），
    /// 这条钉的是「它仍然是一个可序列化的纯数据结构」。
    #[test]
    fn positioned_shape_is_unchanged() {
        let p = Positioned { x: 12, y: 34 };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v, serde_json::json!({ "x": 12, "y": 34 }));
    }
}

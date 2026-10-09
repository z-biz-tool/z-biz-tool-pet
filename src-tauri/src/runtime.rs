//! 主进程侧的运行状态：截图隐身、点击穿透、窗口位置持久化、鼠标位置推送。
//! 对照 src/main/window-manager.ts 的非命令部分（T4.1/T4.2/T4.4/T4.5/T3.2/T3.3）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::{state, store};

const PET: &str = "pet";
const ADMIN: &str = "admin";
/// 与 Electron 版同名，换壳后位置直接继承
const BOUNDS_FILE: &str = "window_bounds.json";
const BOUNDS_DEBOUNCE: Duration = Duration::from_millis(400);
const CURSOR_PUSH_INTERVAL: Duration = Duration::from_millis(200);

static STEALTH: AtomicBool = AtomicBool::new(true);
static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);
/// 推送线程只允许存在一个：首次启动置位后不再重复 spawn
static CURSOR_THREAD_SPAWNED: AtomicBool = AtomicBool::new(false);
/// 上一次推送过的鼠标位置，静止时不重复投递（T3.2 修 D17 的同一条）
static LAST_X: AtomicI32 = AtomicI32::new(i32::MIN);
static LAST_Y: AtomicI32 = AtomicI32::new(i32::MIN);
/// 每次 Moved/Resized 递增；睡眠中的落盘任务发现号变了就放弃，等价于 400 ms 去抖
static BOUNDS_GENERATION: AtomicI64 = AtomicI64::new(0);

fn bounds_path() -> PathBuf {
    store::data_dir().join(BOUNDS_FILE)
}

fn pet_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(PET)
}

// ---------- 截图隐身 ----------

/// Windows 用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，这正是 Electron
/// `setContentProtection` 在 Windows 上做的事；Tauri 没有对应 API，只能直接调 Win32。
/// macOS 侧 Electron 额外调用了 setHiddenInMissionControl，Tauri 无对应物，
/// 因此在非 Windows 上这里返回 Err，由调用方记账 —— 能力缺口不做成静默成功。
fn apply_affinity(win: &WebviewWindow, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        // windows 0.62 把 SetWindowDisplayAffinity 归到了 Win32::UI::WindowsAndMessaging
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
        };
        let hwnd = win.hwnd().map_err(|e| format!("hwnd 获取失败: {e}"))?;
        let affinity = if enabled { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        unsafe { SetWindowDisplayAffinity(hwnd, affinity) }
            .map_err(|e| format!("SetWindowDisplayAffinity 失败: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = (win, enabled);
        Err("本平台暂无截图隐身实现".to_string())
    }
}

pub fn is_stealth() -> bool {
    STEALTH.load(Ordering::SeqCst)
}

/// 状态先落地，再逐窗口应用；单个窗口失败只记日志不中断（与原 Electron 版一致）
pub fn set_stealth(app: &AppHandle, enabled: bool) -> bool {
    apply_stealth(app, enabled, true)
}

/// persist=false 用于开机恢复：Electron 侧是 initWindowManager({initialStealth}) 只读配置，
/// 只有用户真的切换时才回写 config —— 照搬过来，避免每次启动都无意义地重写一遍配置文件。
fn apply_stealth(app: &AppHandle, enabled: bool, persist: bool) -> bool {
    STEALTH.store(enabled, Ordering::SeqCst);
    for label in [PET, ADMIN] {
        if let Some(w) = app.get_webview_window(label) {
            if let Err(e) = apply_affinity(&w, enabled) {
                eprintln!("[Z-Bot] {label} 隐身设置失败: {e}");
            }
        }
    }
    println!("[Z-Bot] 截图隐身模式: {}", if enabled { "开启" } else { "关闭" });
    // Electron: onStealthChange → configStore.patch({ stealthMode })，重启后保持
    if persist {
        if let Err(e) = store::patch(&store::config_file(), state::default_config(), &json!({ "stealthMode": enabled })) {
            eprintln!("[Z-Bot] 隐身状态写入配置失败: {e}");
        }
    }
    enabled
}

pub fn stealth_from_config(app: &AppHandle) {
    let cfg = state::load_config();
    if let Some(enabled) = cfg.get("stealthMode").and_then(|v| v.as_bool()) {
        apply_stealth(app, enabled, false);
    }
}

// ---------- 点击穿透 ----------

pub fn is_click_through() -> bool {
    CLICK_THROUGH.load(Ordering::SeqCst)
}

/// 穿透只能由托盘关掉：窗口一旦 ignore cursor events 就收不到点击，渲染进程无法自救。
pub fn set_click_through(app: &AppHandle, enabled: bool) -> bool {
    CLICK_THROUGH.store(enabled, Ordering::SeqCst);
    let Some(w) = pet_window(app) else {
        return enabled;
    };
    // Tauri 的 set_ignore_cursor_events 没有 Electron forward:true 的等价物：
    // 穿透期间 hover 也收不到，宠物在穿透态下不再随鼠标转头。
    if let Err(e) = w.set_ignore_cursor_events(enabled) {
        eprintln!("[Z-Bot] 点击穿透设置失败: {e}");
    }
    enabled
}

/// 窗口重建后恢复穿透态（Electron 版 createPetWindow 末尾同一步）
pub fn reapply_pet_window_flags(app: &AppHandle) {
    if let Some(w) = pet_window(app) {
        let _ = w.set_always_on_top(true);
        let _ = w.set_visible_on_all_workspaces(true);
        if is_click_through() {
            let _ = w.set_ignore_cursor_events(true);
        }
        if is_stealth() {
            if let Err(e) = apply_affinity(&w, true) {
                eprintln!("[Z-Bot] {PET} 隐身恢复失败: {e}");
            }
        }
    }
}

// ---------- 位置持久化 ----------

/// 保存的位置还要落在某个显示器工作区附近，否则拔掉外接屏后宠物会回到屏幕外。
/// 容差沿用 Electron 的 x-200 / y-100（窗口 200x320，留的是"半个身子"的余量）。
fn bounds_on_some_display(app: &AppHandle, x: i32, y: i32) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        // 拿不到显示器列表时不拦 —— 位置最坏是偏，让随后的 clamp 逻辑去修
        return true;
    };
    monitors.into_iter().any(|m| {
        let wa = m.work_area();
        let (ax, ay) = (wa.position.x, wa.position.y);
        let (w, h) = (wa.size.width as i32, wa.size.height as i32);
        x >= ax - 200 && x <= ax + w && y >= ay - 100 && y <= ay + h
    })
}

pub fn restore_pet_bounds(app: &AppHandle) {
    let v = store::read(&bounds_path(), Value::Null);
    let (Some(x), Some(y)) = (
        v.get("x").and_then(|n| n.as_i64()),
        v.get("y").and_then(|n| n.as_i64()),
    ) else {
        return;
    };
    if !bounds_on_some_display(app, x as i32, y as i32) {
        println!("[Z-Bot] 记录的窗口位置已不在任何屏幕内，改用默认位置");
        return;
    }
    if let Some(w) = pet_window(app) {
        if let Err(e) = w.set_position(tauri::PhysicalPosition::new(x as i32, y as i32)) {
            eprintln!("[Z-Bot] 恢复窗口位置失败: {e}");
        }
    }
}

/// 立即落盘当前位置（退出与隐藏路径都要调，拖完 400 ms 内退出会丢位置）
pub fn flush_pet_bounds(app: &AppHandle) {
    BOUNDS_GENERATION.fetch_add(1, Ordering::SeqCst);
    let Some(w) = pet_window(app) else { return };
    let Ok(pos) = w.outer_position() else { return };
    if let Err(e) = store::write(&bounds_path(), json!({ "x": pos.x, "y": pos.y })) {
        eprintln!("[Z-Bot] 保存窗口位置失败: {e}");
    }
}

/// 移动结束后再落盘，拖拽期间不落盘（等价于 Electron 的 400 ms debounce）
pub fn schedule_bounds_flush(app: &AppHandle) {
    let generation = BOUNDS_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(BOUNDS_DEBOUNCE);
        if BOUNDS_GENERATION.load(Ordering::SeqCst) == generation {
            flush_pet_bounds(&app);
        }
    });
}

// ---------- 鼠标位置推送 ----------

/// 200 ms 推送一次，只在萌宠可见且有位移时发。
/// Electron 版是 show/hide 起停定时器；Tauri 的 WindowEvent 没有 Show/Hide 变体，
/// 所以这里只跑一个常驻线程，每帧自己问一次 is_visible —— 不可见时连 GetCursorPos 都不调，
/// 轮询成本与 Electron 的空转定时器同一量级，但不用跨线程 join。
pub fn start_cursor_push(app: &AppHandle) {
    if CURSOR_THREAD_SPAWNED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(CURSOR_PUSH_INTERVAL);
        let Some(w) = pet_window(&app) else { continue };
        if !w.is_visible().unwrap_or(false) {
            continue;
        }
        let Some((x, y)) = cursor_position() else { continue };
        if x == LAST_X.load(Ordering::Relaxed) && y == LAST_Y.load(Ordering::Relaxed) {
            continue; // 鼠标静止不推
        }
        LAST_X.store(x, Ordering::Relaxed);
        LAST_Y.store(y, Ordering::Relaxed);
        let Ok(pos) = w.outer_position() else { continue };
        let Ok(size) = w.inner_size() else { continue };
        // 给的是相对窗口中心的偏移，渲染端不用再换算（与 Electron 推送的形状一致）
        let payload = json!({
            "dx": x - (pos.x + size.width as i32 / 2),
            "dy": y - (pos.y + size.height as i32 / 2),
        });
        if let Err(e) = w.emit("pet:cursorDelta", &payload) {
            eprintln!("[Z-Bot] 鼠标推送失败: {e}");
        }
    });
}

/// 显示萌宠时开推送（常驻线程只 spawn 一次，重复调用是空操作）
pub fn note_pet_shown(app: &AppHandle) {
    start_cursor_push(app);
}

/// 隐藏萌宠时立刻把位置落盘：Electron 是 `petWindow.on('hide', persistLater)`，
/// Tauri 侧没有 hide 事件，只能由主动隐藏的那几处（窗口命令 / 托盘 / 关闭拦截）补上。
pub fn note_pet_hidden(app: &AppHandle) {
    flush_pet_bounds(app);
}

fn cursor_position() -> Option<(i32, i32)> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut p = POINT::default();
        // windows 0.62 把 Win32 BOOL 包成了 Result：桌面切换（UAC 安全桌面）期间会失败，
        // 拿不到点位就跳过这一帧，不影响后续推送
        unsafe { GetCursorPos(&mut p) }.ok().map(|_| (p.x, p.y))
    }
    #[cfg(not(windows))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_roundtrip_and_default_position_path() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-bounds-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        store::invalidate(&bounds_path());
        store::write(&bounds_path(), json!({ "x": 1200, "y": 300 })).unwrap();
        let v = store::read(&bounds_path(), Value::Null);
        assert_eq!(v["x"], json!(1200));
        assert_eq!(v["y"], json!(300));
        // 缺 x/y 时 restore 会直接返回，这里只验证读回来是 Null 而不是崩
        store::invalidate(&bounds_path());
        store::write(&bounds_path(), json!({ "x": "abc" })).unwrap();
        let v = store::read(&bounds_path(), Value::Null);
        assert!(v.get("y").and_then(|n| n.as_i64()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn flags_default_like_electron() {
        // 隐身默认开（DEFAULT_CONFIG.stealthMode = true），穿透默认关
        assert!(is_stealth());
        assert!(!is_click_through());
    }
}

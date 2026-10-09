//! 全局快捷键：对照 src/main/shortcut-manager.ts（T4.9）。
//!
//! Electron 侧是 `globalShortcut.register("CommandOrControl+Shift+Z", fn)`，字符串直接由 Chromium 解析；
//! Tauri 的 tauri-plugin-global-shortcut 只收 `Shortcut` 结构体，所以这里自带一份加速键解析，
//! **保留 Electron 的字符串格式** —— 用户 config.json 里已有的自定义项换壳后原样可用，不必重录。
//!
//! 翻译取词（原 CommandOrControl+Alt+T）在 Electron 版就已下架：跨应用取词要系统级选区读取，
//! 本仓库没有这个能力，留着只会从其他应用手里偷走快捷键却只弹一句"待实现"。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::actions;

/// 快捷键的稳定标识，同时是 config.shortcuts 的字段名
pub const KEYS: [&str; 6] = [
    "petShowHide",
    "screenshot",
    "note",
    "whisperStart",
    "pushToTalkStart",
    "pushToTalkStop",
];

pub fn default_accelerator(key: &str) -> &'static str {
    match key {
        "petShowHide" => "CommandOrControl+Shift+Z",
        "screenshot" => "CommandOrControl+Alt+S",
        "note" => "CommandOrControl+Alt+N",
        "whisperStart" => "CommandOrControl+Alt+P",
        "pushToTalkStart" => "Alt+Shift+V",
        "pushToTalkStop" => "Alt+Shift+C",
        _ => "",
    }
}

pub fn label(key: &str) -> &'static str {
    match key {
        "petShowHide" => "显示/隐藏萌宠",
        "screenshot" => "截图分析",
        "note" => "快速笔记（剪贴板存入便签）",
        "whisperStart" => "唤醒宠物（开始语音对话）",
        "pushToTalkStart" => "按住说话 · 开始",
        "pushToTalkStop" => "按住说话 · 停止",
        _ => "自定义快捷键",
    }
}

fn applied_map() -> &'static Mutex<HashMap<String, String>> {
    static M: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn registered_map() -> &'static Mutex<HashMap<String, bool>> {
    static M: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn set_registered(key: &str, ok: bool) {
    if let Ok(mut m) = registered_map().lock() {
        m.insert(key.to_string(), ok);
    }
}

static PUSH_TO_TALK: AtomicBool = AtomicBool::new(false);

pub fn is_push_to_talk_active() -> bool {
    PUSH_TO_TALK.load(Ordering::SeqCst)
}

pub fn set_push_to_talk_active(v: bool) {
    PUSH_TO_TALK.store(v, Ordering::SeqCst);
}

/// 解析 Electron 风格的加速键。
/// 词表直接复用 global-hotkey 的解析器（`CommandOrControl/CmdOrCtrl/Alt/Shift/Super` +
/// `A..Z`/`0..9`/`F1..F24`/`Esc`/`Space`/方向键，且要求修饰键在前、只允许一个主键），
/// 这里只补 Electron 那条闸：**必须有修饰键** —— 单键热键会把别人的普通输入整个抢走。
/// 复用的好处是"能被解析"与"能被注册"永远同一套词，不会出现我们收下了、插件注册时才失败。
pub fn parse_accelerator(raw: &str) -> Option<Shortcut> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 60 {
        return None;
    }
    let shortcut = trimmed.parse::<Shortcut>().ok()?;
    if shortcut.mods.is_empty() {
        return None;
    }
    Some(shortcut)
}

/// 与 Electron 的 isValidAccelerator 同一条闸：shortcuts:update 用它先剔非法项
pub fn is_valid_accelerator(raw: &str) -> bool {
    parse_accelerator(raw).is_some()
}

fn effective_accelerator(key: &str, overrides: &Value) -> String {
    let custom = overrides.get(key).and_then(|v| v.as_str()).unwrap_or("");
    if !custom.is_empty() && parse_accelerator(custom).is_some() {
        return custom.trim().to_string();
    }
    default_accelerator(key).to_string()
}

fn dispatch(app: &AppHandle, key: &str) {
    match key {
        "petShowHide" => actions::toggle_pet(app),
        "screenshot" => actions::broadcast(app, "shortcut:screenshot"),
        "note" => {
            // Electron 版：成功则刷新托盘便签子菜单，失败只由调用链记账
            if actions::capture_note(app).is_ok() {
                crate::tray::refresh_menu(app);
            }
        }
        "whisperStart" => actions::wake_pet(app),
        "pushToTalkStart" => {
            set_push_to_talk_active(true);
            actions::broadcast(app, "voice:pushToTalkStart");
        }
        "pushToTalkStop" => {
            set_push_to_talk_active(false);
            actions::broadcast(app, "voice:pushToTalkStop");
        }
        _ => {}
    }
}

/// 注册全部快捷键，返回失败项（被占用/解析不出）。重复调用即热重载：先全清再按新值注册。
pub fn register_all(app: &AppHandle, overrides: &Value) -> Vec<String> {
    let gs = app.global_shortcut();
    // unregister_all 会把 on_shortcut 挂的处理函数一并丢掉，所以重载必须整体重注册而不是逐键替换
    let _ = gs.unregister_all();
    if let Ok(mut m) = applied_map().lock() {
        m.clear();
    }
    let mut failed: Vec<String> = vec![];

    for key in KEYS {
        let accel = effective_accelerator(key, overrides);
        match parse_accelerator(&accel) {
            None => {
                set_registered(key, false);
                failed.push(format!("{key} ({accel})"));
                eprintln!("[Shortcut] 加速键无法解析: {key} → {accel}");
            }
            Some(shortcut) => {
                let handle = app.clone();
                // KEYS 里的元素本来就是 &'static str，闭包直接带走即可
                let result = gs.on_shortcut(shortcut, move |_app, _shortcut, event| {
                    // Electron 版只响应按下；松开同样触发会被当成第二次按下
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    dispatch(&handle, key);
                });
                match result {
                    Ok(_) => {
                        set_registered(key, true);
                        println!("[Shortcut] {key} 已注册: {accel}");
                    }
                    Err(e) => {
                        set_registered(key, false);
                        failed.push(format!("{key} ({accel})"));
                        eprintln!("[Shortcut] 注册失败或已被占用: {key} → {accel} ({e})");
                    }
                }
            }
        }
        if let Ok(mut m) = applied_map().lock() {
            m.insert(key.to_string(), accel);
        }
    }
    failed
}

/// 从 config.shortcuts 取覆盖值注册（启动路径与热重载共用）
pub fn apply_from_config(app: &AppHandle) -> Vec<String> {
    let cfg = crate::state::load_config();
    let overrides = cfg.get("shortcuts").cloned().unwrap_or(Value::Null);
    register_all(app, &overrides)
}

/// 启动时的注册：失败要出声，否则用户只会觉得"按了没反应"（Electron 版同一条通知）
pub fn apply_from_config_with_notice(app: &AppHandle) {
    let failed = apply_from_config(app);
    if failed.is_empty() {
        return;
    }
    eprintln!("[Z-Bot Main] 以下快捷键注册失败（被占用或格式非法）: {}", failed.join(", "));
    crate::notify::notify(
        app,
        "部分全局快捷键未生效",
        &format!(
            "{} 注册失败，可能被其他应用占用，可在设置 → 快捷键里改键。",
            failed.join("、")
        ),
    );
}

/// Electron: shortcuts:list
#[tauri::command]
pub fn shortcuts_list() -> Vec<Value> {
    list()
}

/// Electron: shortcuts:update —— 只做热重载，不落盘。
/// 管理端的提示语已经写明"点击保存配置时也会按其中的 shortcuts 字段重新注册"，
/// 持久化归 config:save，这里再写一次就会有两份真值。
#[tauri::command]
pub fn shortcuts_update(app: AppHandle, overrides: Value) -> Value {
    let mut cleaned = serde_json::Map::new();
    let mut rejected: Vec<String> = vec![];
    if let Some(obj) = overrides.as_object() {
        for (key, value) in obj {
            let raw = value.as_str().unwrap_or("").to_string();
            if !is_valid_accelerator(&raw) {
                rejected.push(key.clone());
                continue;
            }
            cleaned.insert(key.clone(), json!(raw.trim()));
        }
    }
    let failed = register_all(&app, &Value::Object(cleaned));
    crate::tray::refresh_menu(&app);
    json!({ "ok": failed.is_empty() && rejected.is_empty(), "failed": failed, "rejected": rejected })
}

/// Electron: getShortcuts() —— 设置面板按这个形状回显
pub fn list() -> Vec<Value> {
    let applied = applied_map()
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default();
    let registered = registered_map()
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default();
    KEYS.iter()
        .map(|key| {
            json!({
                "key": key,
                "label": label(key),
                "accelerator": applied.get(*key).cloned().unwrap_or_else(|| default_accelerator(key).to_string()),
                "defaultAccelerator": default_accelerator(key),
                "registered": registered.get(*key).copied().unwrap_or(false),
            })
        })
        .collect()
}

/// 托盘的显示/隐藏萌宠一项要把当前加速键写进标签，和 Electron 菜单同款提示
pub fn pet_toggle_hint(app: &AppHandle) -> String {
    let accel = applied_map()
        .lock()
        .ok()
        .and_then(|m| m.get("petShowHide").cloned())
        .unwrap_or_else(|| default_accelerator("petShowHide").to_string());
    let _ = app;
    format!(" ({accel})")
}

pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    for key in KEYS {
        set_registered(key, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_electron_style_accelerators() {
        for key in KEYS {
            assert!(
                parse_accelerator(default_accelerator(key)).is_some(),
                "默认值 {key} 必须能解析"
            );
        }
        // CommandOrControl 与 Ctrl/Cmd 两个写法都收
        assert!(parse_accelerator("CommandOrControl+Shift+Z").is_some());
        assert!(parse_accelerator("Ctrl+Shift+Z").is_some());
        assert!(parse_accelerator("Alt+Shift+V").is_some());
        assert!(parse_accelerator("super+f12").is_some());
        assert!(parse_accelerator("CommandOrControl+Alt+Space").is_some());
    }

    #[test]
    fn rejects_single_keys_and_unknown_tokens() {
        // 无修饰键：会把别人的单键输入整个抢走
        assert!(!is_valid_accelerator("Z"));
        assert!(!is_valid_accelerator("Shift"));
        assert!(!is_valid_accelerator(""));
        assert!(!is_valid_accelerator("CommandOrControl+"));
        assert!(!is_valid_accelerator("CommandOrControl+Hyper+Z"));
        assert!(!is_valid_accelerator("CommandOrControl+Shift+Hello"));
        assert!(!is_valid_accelerator(&"CommandOrControl+Shift+Z".repeat(8)));
    }

    #[test]
    fn override_must_be_valid_or_default_wins() {
        let overrides = json!({ "note": "Alt+Shift+M", "screenshot": "nonsense" });
        assert_eq!(effective_accelerator("note", &overrides), "Alt+Shift+M");
        // 非法覆盖不生效，退回默认值 —— 与 Electron 的 accelerators() 同一策略
        assert_eq!(
            effective_accelerator("screenshot", &overrides),
            default_accelerator("screenshot")
        );
        assert_eq!(
            effective_accelerator("petShowHide", &Value::Null),
            default_accelerator("petShowHide")
        );
    }
}

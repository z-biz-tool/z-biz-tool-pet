//! 皮肤系统：Electron src/main/ipc-handlers.ts:56-97 的三条端点。
//! 预设色板是硬编码在 handler 里的，渲染层按 id 回查 —— 一个 hex 抄错就是一张变色的猫。

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::actions::pet_window;
use crate::state;

const EYE: &str = "#1a1a2e";
const DEFAULT_BLUSH: &str = "rgba(255, 105, 180, 0.5)";

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

/// (id, 名称, body, bodyLight, bodyDark, blush, accent)
type Preset = (&'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str);

const PRESETS: &[Preset] = &[
    ("default-purple", "默认紫", "#722ed1", "#b794f6", "#531dab", "rgba(255, 105, 180, 0.5)", "#722ed1"),
    ("forest-green", "森林绿", "#237804", "#52c41a", "#135200", "rgba(250, 173, 20, 0.4)", "#52c41a"),
    ("ocean-blue", "海洋蓝", "#003a8c", "#1890ff", "#002766", "rgba(255, 105, 180, 0.4)", "#1890ff"),
    ("sakura-pink", "樱花粉", "#9e1068", "#eb2f96", "#6e0f4e", "rgba(255, 182, 193, 0.6)", "#eb2f96"),
    ("lava-red", "岩浆红", "#820014", "#ff4d4f", "#5c0011", "rgba(255, 182, 193, 0.5)", "#ff4d4f"),
    ("galaxy-gray", "银河灰", "#434343", "#bfbfbf", "#1f1f1f", "rgba(114, 46, 209, 0.4)", "#bfbfbf"),
    ("golden", "金色", "#ad6800", "#faad14", "#874d00", "rgba(255, 105, 180, 0.4)", "#faad14"),
];

fn preset_skin(p: &Preset) -> Value {
    json!({
        "id": p.0,
        "name": p.1,
        "colors": {
            "body": p.2,
            "bodyLight": p.3,
            "bodyDark": p.4,
            "eye": EYE,
            "blush": p.5,
            "accent": p.6,
        },
        "isCustom": false,
    })
}

/// Electron: pet:getSkins
#[tauri::command]
pub fn pet_get_skins() -> Value {
    Value::Array(PRESETS.iter().map(preset_skin).collect())
}

/// Electron: pet:applySkin —— 发的是 **id 字符串**，不是皮肤对象。
/// preload 收到后自己 invoke getSkins 回查再交给渲染层（见 tauri-bridge 的 onApplySkin）。
#[tauri::command]
pub fn pet_apply_skin(app: AppHandle, skin_id: String) -> bool {
    if let Some(w) = pet_window(&app) {
        let _ = w.emit("pet:applySkin", &skin_id);
    }
    let mut cfg = state::load_config();
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("currentSkinId".into(), json!(skin_id));
    }
    state::save_config(&cfg);
    true
}

/// Electron: pet:applySkinTheme —— AI 生成的自定义皮肤，只发事件，不落盘
#[tauri::command]
pub fn pet_apply_skin_theme(app: AppHandle, skin_data: Value) -> Value {
    let skin = build_custom_skin(&skin_data);
    if let Some(w) = pet_window(&app) {
        let _ = w.emit("pet:applySkinData", &skin);
    }
    skin
}

fn build_custom_skin(skin_data: &Value) -> Value {
    let colors = skin_data.get("colors").cloned().unwrap_or(Value::Null);
    let get = |key: &str| {
        colors
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let body = get("body");
    let accent = get("accent");
    let name = skin_data
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("AI生成皮肤");
    json!({
        "id": format!("custom-{}", now_ms()),
        "name": name,
        "colors": {
            "body": body,
            "bodyLight": get("bodyLight"),
            "bodyDark": get("bodyDark"),
            "eye": EYE,
            "blush": DEFAULT_BLUSH,
            // Electron 写的是 `accent || body`，空串也要退到 body
            "accent": if accent.is_empty() { body } else { accent },
        },
        "isCustom": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_keep_the_electron_palettes() {
        let skins = pet_get_skins().as_array().expect("必须是数组").clone();
        assert_eq!(skins.len(), 7, "预设皮肤数量变了老用户的收藏就对不上 id");
        assert_eq!(skins[0]["colors"]["body"], json!("#722ed1"));
        assert_eq!(skins[0]["colors"]["blush"], json!("rgba(255, 105, 180, 0.5)"));
        assert_eq!(skins[3]["colors"]["blush"], json!("rgba(255, 182, 193, 0.6)"));
        assert_eq!(skins[6]["id"], json!("golden"));
        for skin in &skins {
            assert_eq!(skin["colors"]["eye"], json!(EYE), "{skin}");
            assert_eq!(skin["isCustom"], json!(false));
        }
    }

    #[test]
    fn custom_theme_fills_eye_blush_and_accent_fallback() {
        let skin = build_custom_skin(&json!({
            "name": "",
            "colors": { "body": "#111111", "bodyLight": "#333333", "bodyDark": "#000000" },
        }));
        assert_eq!(skin["name"], json!("AI生成皮肤"));
        assert_eq!(skin["colors"]["accent"], json!("#111111"), "缺 accent 要退到 body");
        assert_eq!(skin["colors"]["eye"], json!(EYE));
        assert_eq!(skin["colors"]["blush"], json!(DEFAULT_BLUSH));
        assert_eq!(skin["isCustom"], json!(true));
        assert!(skin["id"].as_str().unwrap().starts_with("custom-"));

        let with_accent = build_custom_skin(&json!({
            "name": "我的",
            "colors": { "body": "#111111", "bodyLight": "#333333", "bodyDark": "#000000", "accent": "#ff0000" },
        }));
        assert_eq!(with_accent["colors"]["accent"], json!("#ff0000"));
        assert_eq!(with_accent["name"], json!("我的"));
    }
}

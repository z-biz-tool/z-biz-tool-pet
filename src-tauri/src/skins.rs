//! 皮肤系统：Electron src/main/ipc-handlers.ts:56-97 的三条端点。
//! 预设色板与渲染层 `pet/characters/index.ts` 是同一份清单：渲染层按 id 回查立绘，
//! 一个 hex 或 id 抄错，就是「换了配色头像还是上一个人」的鬼故事。

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
type Preset = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
);

const PRESETS: &[Preset] = &[
    // 2026-10-28：新增原创角色「桃夭」并作为默认（门面不该是 AI 产品的娘化形象）。
    (
        "taoyao",
        "桃夭",
        "#e9b7a6",
        "#ffe6da",
        "#8a5a4c",
        "rgba(255, 170, 170, 0.45)",
        "#f5a68c",
    ),
    // 2026-10-27：皮肤语义从「圆猫换色」变成「立绘角色各一套配色」。
    // 这份表和 src/renderer/pet/characters/index.ts 是同一个清单的两种语言版本，
    // id / 名称 / 六个颜色必须逐字一致（渲染层认 id 回查立绘，抄错就是张冠李戴）。
    (
        "chatgpt",
        "茉白",
        "#3fb6a8",
        "#a7f0e2",
        "#0e6157",
        "rgba(255, 150, 190, 0.45)",
        "#4ecdc4",
    ),
    (
        "claude",
        "夜汐",
        "#6f7bd6",
        "#b7c0ff",
        "#2b2f6b",
        "rgba(190, 160, 255, 0.4)",
        "#8f9cff",
    ),
    (
        "gemini",
        "星璃",
        "#8b7cf6",
        "#cfc2ff",
        "#4a2f9e",
        "rgba(190, 178, 255, 0.5)",
        "#a78bfa",
    ),
    (
        "deepseek",
        "砚秋",
        "#d98243",
        "#ffc79a",
        "#8a4718",
        "rgba(255, 176, 140, 0.45)",
        "#f0a35e",
    ),
    (
        "midjourney",
        "棠青",
        "#4f9ec4",
        "#a9e0f2",
        "#1f5a76",
        "rgba(255, 178, 178, 0.4)",
        "#63b3d6",
    ),
    (
        "suno",
        "音橘",
        "#f07a4b",
        "#ffc0a0",
        "#a03e17",
        "rgba(255, 150, 130, 0.5)",
        "#ff8a5c",
    ),
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
    fn presets_match_the_renderer_characters() {
        let skins = pet_get_skins().as_array().expect("必须是数组").clone();
        assert_eq!(
            skins.len(),
            7,
            "7 个立绘角色，多一个少一个都会让 id 对不上立绘"
        );
        // id 顺序与 characters/index.ts 完全一致：渲染层按数组顺序渲染换角色菜单
        let ids: Vec<&str> = skins.iter().filter_map(|s| s["id"].as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "taoyao",
                "chatgpt",
                "claude",
                "gemini",
                "deepseek",
                "midjourney",
                "suno",
            ]
        );
        // 默认角色必须是原创的桃夭，而不是任何 AI 产品的娘化形象
        assert_eq!(skins[0]["name"], json!("桃夭"));
        assert_eq!(skins[0]["colors"]["accent"], json!("#f5a68c"));
        assert_eq!(skins[1]["name"], json!("茉白"));
        assert_eq!(skins[1]["colors"]["accent"], json!("#4ecdc4"));
        assert_eq!(skins[3]["colors"]["bodyDark"], json!("#4a2f9e"));
        assert_eq!(skins[6]["colors"]["body"], json!("#f07a4b"));
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
        assert_eq!(
            skin["colors"]["accent"],
            json!("#111111"),
            "缺 accent 要退到 body"
        );
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

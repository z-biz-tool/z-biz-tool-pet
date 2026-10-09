//! 持久化状态与对应的 Tauri 命令：配置 / 对话历史 / 宠物养成 / Pin 卡片。
//! 逐条对照 src/main/stores.ts + ipc-handlers.ts 的 config、history、conversation、pin、pet 端点。
//!
//! 类型策略：只有宠物状态用强类型（数值规则要参与计算，见 decay），
//! 配置和历史按 Value 透传 —— 渲染进程是这两份数据的唯一作者，Rust 侧只做
//! 存取和默认值补齐，擅自建模反而会把前端新增的字段在下一次写盘时丢掉。

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{secret, store};

pub const MAX_HISTORY_LENGTH: usize = 200;

fn config_file() -> PathBuf {
    store::config_file()
}
fn history_file() -> PathBuf {
    store::history_file()
}
fn pet_stats_file() -> PathBuf {
    store::pet_stats_file()
}
pub fn pins_file() -> PathBuf {
    store::pins_file()
}

/// Electron DEFAULT_CONFIG；缺键由 read 一层补齐，避免升级后前端读到 undefined。
pub fn default_config() -> Value {
    json!({
        "ollamaUrl": "http://localhost:11434",
        "modelName": "qwen2.5:7b-instruct-q4_K_M",
        "systemPrompt": "",
        "sttUrl": "http://localhost:8084",
        "ttsUrl": "http://localhost:8086",
        "voiceSpeed": 1.0,
        "petName": "Z-Bot 小猫咪",
        "themeColor": "#722ed1",
        "stealthMode": true,
        "memoryEnabled": true,
        "sceneryEnabled": true,
        "particleEnabled": true,
        "taskSchedulerEnabled": true,
        "autoSwitchScenery": true,
        "autoExtractMemory": true,
        "interruptThreshold": 30,
        "sttModel": "base"
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PetStats {
    pub hunger: f64,
    pub happiness: f64,
    pub energy: f64,
    pub cleanliness: f64,
    pub health: f64,
    pub affection: f64,
    pub age: i64,
    pub stage: String,
    pub born_at: String,
    pub last_update: String,
    pub is_sleeping: bool,
    pub is_sick: bool,
}

impl Default for PetStats {
    fn default() -> Self {
        let now = store::now_iso();
        PetStats {
            hunger: 80.0,
            happiness: 80.0,
            energy: 80.0,
            cleanliness: 80.0,
            health: 100.0,
            affection: 50.0,
            age: 0,
            stage: "egg".to_string(),
            born_at: now.clone(),
            last_update: now,
            is_sleeping: false,
            is_sick: false,
        }
    }
}

fn clamp_stat(v: f64) -> f64 {
    v.clamp(0.0, 100.0)
}

fn parse_iso(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

/// 按距上次更新的分钟数衰减，并推 age / 进化阶段（对照 stores.ts decayPetStats）。
/// 时间戳解析失败时不改数值，只把 lastUpdate 顶到现在 —— 坏时间戳不该让宠物饿死，
/// 也不该每次读取都重复衰减。
pub fn decay(mut s: PetStats) -> PetStats {
    let now = Utc::now();
    let minutes = match parse_iso(&s.last_update) {
        Some(last) => ((now - last).num_seconds().max(0) as f64) / 60.0,
        None => 0.0,
    };
    if minutes < 1.0 {
        return s;
    }

    s.hunger = clamp_stat(s.hunger - (minutes / 30.0).floor());
    s.happiness = clamp_stat(s.happiness - (minutes / 20.0).floor());
    s.cleanliness = clamp_stat(s.cleanliness - (minutes / 60.0).floor());
    s.energy = if s.is_sleeping {
        clamp_stat(s.energy + (minutes * 2.0).floor())
    } else {
        clamp_stat(s.energy - (minutes / 45.0).floor())
    };

    if s.hunger < 20.0 || s.cleanliness < 20.0 {
        let rate = (if s.hunger < 20.0 { 1.0 } else { 0.0 })
            + (if s.cleanliness < 20.0 { 1.0 } else { 0.0 });
        s.health = clamp_stat(s.health - (minutes / 60.0).floor() * rate);
    }
    s.is_sick = s.health < 10.0;

    let days = parse_iso(&s.born_at)
        .map(|b| (now - b).num_seconds().max(0) as f64 / 86400.0)
        .unwrap_or(0.0);
    s.age = days.floor() as i64;

    let all_above_60 = s.hunger > 60.0
        && s.happiness > 60.0
        && s.energy > 60.0
        && s.cleanliness > 60.0
        && s.health > 60.0;
    if all_above_60 {
        match (s.stage.as_str(), s.age) {
            ("egg", a) if a >= 1 => s.stage = "baby".into(),
            ("baby", a) if a >= 3 => s.stage = "child".into(),
            ("child", a) if a >= 7 => s.stage = "adult".into(),
            _ => {}
        }
    }
    s.last_update = store::now_iso();
    s
}

// ---------- 读写通道（渲染进程只见 Value / PetStats） ----------

/// config:load 的返回值：加密存储优先，回退到 config 里的 aiApiKey 字段。
pub fn load_config() -> Value {
    let mut cfg = store::read(&config_file(), default_config());
    if let Some(key) = secret::get(secret::API_KEY).ok().flatten() {
        if !key.is_empty() {
            if let Some(obj) = cfg.as_object_mut() {
                obj.insert("aiApiKey".into(), Value::String(key));
            }
        }
    }
    cfg
}

/// 明文密钥不进 config.json：单独走 secret，配置文件里那一份抹成空串。
pub fn save_config(cfg: &Value) -> Value {
    let plain = cfg
        .get("aiApiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut to_disk = cfg.clone();
    if !plain.is_empty() {
        if let Err(e) = secret::put(secret::API_KEY, &plain) {
            eprintln!("[Z-Bot] 密钥加密落盘失败，config.json 未写入明文: {}", e);
        }
        if let Some(obj) = to_disk.as_object_mut() {
            obj.insert("aiApiKey".into(), Value::String(String::new()));
        }
    }
    store::write(&config_file(), to_disk).unwrap_or_else(|e| {
        eprintln!("[Z-Bot] 配置写入失败: {}", e);
        cfg.clone()
    })
}

pub fn read_list(file: PathBuf) -> Vec<Value> {
    store::read(&file, json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default()
}

pub fn write_list(file: PathBuf, items: Vec<Value>) {
    if let Err(e) = store::write(&file, Value::Array(items)) {
        eprintln!("[Z-Bot] 列表写入失败 {}: {}", file.display(), e);
    }
}

pub fn load_stats() -> PetStats {
    let raw = store::read(&pet_stats_file(), serde_json::to_value(PetStats::default()).unwrap());
    serde_json::from_value::<PetStats>(raw).unwrap_or_default()
}

pub fn save_stats(s: &PetStats) {
    match serde_json::to_value(s) {
        Ok(v) => {
            if let Err(e) = store::write(&pet_stats_file(), v) {
                eprintln!("[Z-Bot] 宠物状态写入失败: {}", e);
            }
        }
        Err(e) => eprintln!("[Z-Bot] 宠物状态序列化失败: {}", e),
    }
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn config_load() -> Value {
    load_config()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Applied {
    #[serde(skip_serializing_if = "Option::is_none")]
    stt_model: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shortcuts: Option<bool>,
}

/// Electron: config:save —— 返回 { ok, applied }
///
/// shortcuts 一变就整体重注册（等价于 Electron 的 reloadShortcuts），applied.shortcuts
/// 如实回报有没有全抢到；sttModel 只存不换：whisper 子进程还没进 Rust（P3 语音），
/// 这里刻意不回填 true —— 谎报"已生效"比报"没生效"更难排查。
#[tauri::command]
pub fn config_save(app: tauri::AppHandle, config: Value) -> Value {
    let before = load_config();
    let after = save_config(&config);
    let changed = |key: &str| {
        before.get(key).and_then(|v| v.as_str()).unwrap_or("")
            != after.get(key).and_then(|v| v.as_str()).unwrap_or("")
    };
    let mut applied = Applied { stt_model: None, shortcuts: None };
    if changed("sttModel") {
        eprintln!("[Z-Bot] sttModel 已保存，但 whisper 子进程尚未移植（P3），本次不会热切换");
    }
    if before.get("shortcuts") != after.get("shortcuts") {
        let overrides = after.get("shortcuts").cloned().unwrap_or(Value::Null);
        let failed = crate::shortcuts::register_all(&app, &overrides);
        crate::tray::refresh_menu(&app);
        applied.shortcuts = Some(failed.is_empty());
        if !failed.is_empty() {
            eprintln!("[Z-Bot] 改键后注册失败: {}", failed.join(", "));
        }
    }
    json!({ "ok": true, "applied": applied })
}

/// Electron: stt:models —— 模型清单只是"文件在不在"，识别服务本身还没进来（P3 语音），
/// 但设置面板要靠这份清单显示已下载哪些模型、往哪个目录放，所以先把它补齐。
#[tauri::command]
pub fn stt_models() -> Value {
    const STT_MODELS: [&str; 5] = ["tiny", "base", "small", "medium", "large-v3"];
    let current = load_config()
        .get("sttModel")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("base")
        .to_string();
    let models_dir = store::data_dir().join("models");
    let models = STT_MODELS
        .iter()
        .map(|id| {
            // 文件名沿用 Electron 的 ggml-<model>.bin，旧目录里的模型直接可用
            let path = models_dir.join(format!("ggml-{id}.bin"));
            json!({
                "id": id,
                "path": path.to_string_lossy(),
                "installed": path.is_file(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "current": current,
        "modelsDir": models_dir.to_string_lossy(),
        "models": models,
    })
}

#[tauri::command]
pub fn history_load() -> Vec<Value> {
    read_list(history_file())
}

#[tauri::command]
pub fn history_save(messages: Vec<Value>) -> bool {
    write_list(history_file(), messages);
    true
}

#[tauri::command]
pub fn history_clear() -> bool {
    write_list(history_file(), vec![]);
    true
}

/// conversation:addMessage：追加并按 MAX_HISTORY_LENGTH 截尾，返回当前条数
#[tauri::command]
pub fn conversation_add_message(message: Value) -> usize {
    let mut items = read_list(history_file());
    items.push(message);
    if items.len() > MAX_HISTORY_LENGTH {
        let cut = items.len() - MAX_HISTORY_LENGTH;
        items.drain(..cut);
    }
    write_list(history_file(), items.clone());
    items.len()
}

#[tauri::command]
pub fn pin_list() -> Vec<Value> {
    read_list(pins_file())
}

/// Electron: pin:create —— 也供托盘/快捷键的「快速笔记」直接调用
pub fn add_pin(content: &str) -> Value {
    let mut pins = read_list(pins_file());
    let pin = json!({
        "id": chrono::Utc::now().timestamp_millis().to_string(),
        "content": content,
        "createdAt": store::now_iso()
    });
    pins.push(pin.clone());
    write_list(pins_file(), pins);
    pin
}

#[tauri::command]
pub fn pin_create(content: String) -> Value {
    add_pin(&content)
}

#[tauri::command]
pub fn pin_remove(id: String) -> bool {
    let pins: Vec<Value> = read_list(pins_file())
        .into_iter()
        .filter(|p| p.get("id").and_then(|v| v.as_str()) != Some(id.as_str()))
        .collect();
    write_list(pins_file(), pins);
    true
}

/// 养成动作的统一形状：读盘 → 衰减 → 改一项 → 落盘 → 回给前端
fn mutate_stats(f: impl FnOnce(&mut PetStats)) -> Value {
    let mut s = decay(load_stats());
    f(&mut s);
    s.last_update = store::now_iso();
    save_stats(&s);
    serde_json::to_value(&s).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn pet_get_stats() -> Value {
    let s = decay(load_stats());
    save_stats(&s);
    serde_json::to_value(&s).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn pet_feed() -> Value {
    mutate_stats(|s| s.hunger = clamp_stat(s.hunger + 30.0))
}

#[tauri::command]
pub fn pet_play() -> Value {
    mutate_stats(|s| {
        s.happiness = clamp_stat(s.happiness + 20.0);
        s.energy = clamp_stat(s.energy - 10.0);
    })
}

#[tauri::command]
pub fn pet_wash() -> Value {
    mutate_stats(|s| s.cleanliness = clamp_stat(s.cleanliness + 40.0))
}

#[tauri::command]
pub fn pet_sleep() -> Value {
    mutate_stats(|s| s.is_sleeping = !s.is_sleeping)
}

#[tauri::command]
pub fn pet_medicine() -> Value {
    mutate_stats(|s| {
        s.health = clamp_stat(s.health + 30.0);
        if s.health >= 10.0 {
            s.is_sick = false;
        }
    })
}

#[tauri::command]
pub fn pet_pet() -> Value {
    mutate_stats(|s| {
        s.happiness = clamp_stat(s.happiness + 5.0);
        s.affection = clamp_stat(s.affection + 1.0);
    })
}

/// 启动时装盘状态（Electron 侧 initRuntimeState 里与宠物相关的两件事）
pub fn init_runtime_state() {
    let s = decay(load_stats());
    save_stats(&s);
    println!(
        "[Z-Bot] 宠物状态已加载, stage: {} age: {}",
        s.stage, s.age
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("z-bot-state-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        dir
    }

    fn stats_minutes_ago(minutes: i64) -> PetStats {
        PetStats {
            last_update: (Utc::now() - chrono::Duration::minutes(minutes))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ..PetStats::default()
        }
    }

    #[test]
    fn decay_applies_the_documented_rates() {
        let _g = crate::lock_test_env();
        // 60 分钟：hunger -2（每 30 分钟 -1）、happiness -3（每 20 分钟 -1）、
        // cleanliness -1（每 60 分钟 -1）、energy 醒着 -1（每 45 分钟 -1）
        let s = decay(stats_minutes_ago(60));
        assert_eq!(s.hunger, 78.0);
        assert_eq!(s.happiness, 77.0);
        assert_eq!(s.cleanliness, 79.0);
        assert_eq!(s.energy, 79.0);
        assert_eq!(s.health, 100.0, "属性都远高于 20，健康不该掉");
    }

    #[test]
    fn decay_ignores_gaps_under_a_minute() {
        let _g = crate::lock_test_env();
        let s = decay(stats_minutes_ago(0));
        assert_eq!(s.hunger, 80.0);
    }

    #[test]
    fn sleeping_restores_energy() {
        let _g = crate::lock_test_env();
        let mut base = stats_minutes_ago(60);
        base.is_sleeping = true;
        let s = decay(base);
        assert_eq!(s.energy, 100.0, "睡觉 +2/分钟，60 分钟应顶到上限");
    }

    #[test]
    fn low_stats_drain_health_and_mark_sick() {
        let _g = crate::lock_test_env();
        let mut base = stats_minutes_ago(600); // 10 小时
        base.hunger = 10.0;
        base.cleanliness = 10.0;
        base.health = 20.0;
        let s = decay(base);
        assert!(s.health < 20.0, "双低应扣健康，实际 {}", s.health);
        assert!(s.is_sick, "health<10 必须置病");
    }

    #[test]
    fn unparsable_timestamp_does_not_kill_the_pet() {
        let _g = crate::lock_test_env();
        let mut base = PetStats::default();
        base.last_update = "昨天".into();
        let s = decay(base);
        assert_eq!(s.hunger, 80.0, "坏时间戳不能触发衰减");
    }

    #[test]
    fn stage_only_advances_when_everything_is_healthy() {
        let _g = crate::lock_test_env();
        // 不足 1 分钟的间隔会走"不衰减"早退（与 Electron 一致），所以要给一个够旧的 lastUpdate
        let mut base = stats_minutes_ago(5);
        base.born_at = (Utc::now() - chrono::Duration::days(3))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        base.stage = "egg".into();
        let s = decay(base.clone());
        assert_eq!(s.age, 3);
        assert_eq!(s.stage, "baby", "所有属性>60 且满 1 天应从 egg 进化");

        let mut weak = base.clone();
        weak.hunger = 5.0;
        assert_eq!(decay(weak).stage, "egg", "饿过头不能进化");
    }

    #[test]
    fn api_key_never_lands_in_config_json() {
        let _g = crate::lock_test_env();
        let dir = isolated("key");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = json!({ "petName": "小紫", "aiApiKey": "sk-secret" });
        save_config(&cfg);
        let on_disk = std::fs::read_to_string(config_file()).unwrap();
        assert!(!on_disk.contains("sk-secret"), "config.json 泄漏了明文密钥");
        // write 是全量替换且以写入值为准（Electron 同构），默认值补齐发生在重新读盘时
        store::invalidate(&config_file());
        assert_eq!(load_config()["aiApiKey"], json!("sk-secret"), "读回必须带密钥");
        assert_eq!(load_config()["petName"], json!("小紫"));
        assert_eq!(load_config()["voiceSpeed"], json!(1.0), "缺键由默认值补齐");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn history_is_trimmed_to_the_last_200() {
        let _g = crate::lock_test_env();
        let dir = isolated("history");
        let _ = std::fs::remove_dir_all(&dir);
        store::invalidate(&history_file());
        for i in 0..205 {
            conversation_add_message(json!({ "id": i.to_string(), "role": "user", "content": "m" }));
        }
        let h = history_load();
        assert_eq!(h.len(), MAX_HISTORY_LENGTH);
        assert_eq!(h[0]["id"], json!("5"), "截尾要留最新的一批");
        assert!(history_clear());
        assert!(history_load().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn pins_roundtrip_and_remove() {
        let _g = crate::lock_test_env();
        let dir = isolated("pins");
        let _ = std::fs::remove_dir_all(&dir);
        store::invalidate(&pins_file());
        let a = pin_create("第一条".into());
        let b = pin_create("第二条".into());
        assert_eq!(pin_list().len(), 2);
        assert!(a["id"].as_str().unwrap().len() >= 13);
        assert!(b["createdAt"].as_str().unwrap().contains('T'));
        assert!(pin_remove(a["id"].as_str().unwrap().to_string()));
        let left = pin_list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["content"], json!("第二条"));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn feed_persists_and_returns_camel_case() {
        let _g = crate::lock_test_env();
        let dir = isolated("feed");
        let _ = std::fs::remove_dir_all(&dir);
        store::invalidate(&pet_stats_file());
        let got = pet_feed();
        assert_eq!(got["hunger"], json!(100.0), "喂食 +30 但要封顶 100");
        assert!(got.get("isSleeping").is_some(), "字段名必须是 camelCase");
        assert!(got.get("is_sleeping").is_none());
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(pet_stats_file()).unwrap()).unwrap();
        assert_eq!(on_disk, got, "返回给前端的必须和落盘的一致");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn stats_survive_a_partial_file() {
        let _g = crate::lock_test_env();
        let dir = isolated("partial");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(pet_stats_file(), json!({ "hunger": 12.0 }).to_string()).unwrap();
        store::invalidate(&pet_stats_file());
        let s = load_stats();
        assert_eq!(s.hunger, 12.0, "磁盘上的值优先");
        assert_eq!(s.health, 100.0, "缺的键回落默认值而不是 0");
        assert_eq!(s.stage, "egg");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

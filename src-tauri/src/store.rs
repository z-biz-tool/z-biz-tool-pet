//! 数据目录与 JSON 状态落盘，对应 Electron 侧 src/main/config-store.ts。
//!
//! 三条不变量原样保留（都是当年修 D22/D23 时定下的）：
//! - 目录 `~/.z-bot`，`ZBOT_DATA_DIR` 可覆盖（测试与多实例隔离）。
//! - 写入 = 临时文件 + rename，断电不会留下半截 JSON。
//! - 读损坏文件先备份成 `<file>.corrupt.<毫秒>` 再回落默认值，不静默丢弃。
//!
//! 与 Electron 版的差异：`JsonStore` 的"合并落盘"（scheduleFlush）没有搬过来。
//! Electron 用它是为了躲开主进程同步 IO 卡 UI；Tauri 的 command 跑在工作线程上，
//! 磁盘抖动碰不到渲染线程，多一层延迟反而制造"内存和磁盘不一致"的时间窗。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ZBOT_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".z-bot")
}

pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn config_file() -> PathBuf {
    data_dir().join("config.json")
}
pub fn history_file() -> PathBuf {
    data_dir().join("history.json")
}
pub fn pet_stats_file() -> PathBuf {
    data_dir().join("pet_stats.json")
}
pub fn pins_file() -> PathBuf {
    data_dir().join("pins.json")
}

pub fn ensure_data_dir() -> Result<(), String> {
    for d in [data_dir(), log_dir()] {
        std::fs::create_dir_all(&d).map_err(|e| format!("创建目录失败 {}: {}", d.display(), e))?;
    }
    Ok(())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn caches() -> &'static Mutex<HashMap<PathBuf, Value>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Value>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn locks() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_lock(file: &Path) -> Arc<Mutex<()>> {
    let mut map = locks().lock().expect("store 锁表被污染");
    map.entry(file.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// 同名文件串行化，避免两个 command 并发 rename 互相盖。
fn with_file_lock<T>(file: &Path, f: impl FnOnce() -> T) -> T {
    let guard = file_lock(file);
    // 锁中毒只说明某次写入 panic 过，文件本身仍然是完整的（rename 才生效）。
    let _g = guard.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// 数组默认值直接透传，对象默认值做一层浅合并 —— 与 Electron 的 loadFromDisk 一致，
/// 目的是版本升级新增字段时前端不会读到 undefined。
fn merge_defaults(stored: Value, defaults: &Value) -> Value {
    match (stored, defaults) {
        (Value::Object(got), Value::Object(def)) => {
            let mut out = def.clone();
            for (k, v) in got {
                out.insert(k, v);
            }
            Value::Object(out)
        }
        (stored, _) => stored,
    }
}

fn backup_corrupt(file: &Path) {
    if file.exists() {
        let dest = format!("{}.corrupt.{}", file.display(), chrono::Utc::now().timestamp_millis());
        let _ = std::fs::copy(file, Path::new(&dest));
    }
}

/// 读；命中内存缓存则不碰磁盘。磁盘损坏时备份后回落默认值（不落盘，等下一次写）。
pub fn read(file: &Path, defaults: Value) -> Value {
    {
        let cache = caches().lock().expect("store 缓存表被污染");
        if let Some(v) = cache.get(file) {
            return v.clone();
        }
    }
    let loaded = if !file.exists() {
        defaults.clone()
    } else {
        match std::fs::read_to_string(file)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
        {
            Ok(v) => merge_defaults(v, &defaults),
            Err(_) => {
                backup_corrupt(file);
                defaults.clone()
            }
        }
    };
    caches()
        .lock()
        .expect("store 缓存表被污染")
        .insert(file.to_path_buf(), loaded.clone());
    loaded
}

/// 全量替换：更新缓存并立即落盘。合并语义由调用方保证（与 Electron 版一致）。
pub fn write(file: &Path, value: Value) -> Result<Value, String> {
    let out = value;
    let text = serde_json::to_string_pretty(&out).map_err(|e| format!("序列化失败: {}", e))?;
    with_file_lock(file, || {
        ensure_data_dir()?;
        let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入临时文件失败: {}", e))?;
        std::fs::rename(&tmp, file).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("替换文件失败 {}: {}", file.display(), e)
        })?;
        Ok::<(), String>(())
    })?;
    caches()
        .lock()
        .expect("store 缓存表被污染")
        .insert(file.to_path_buf(), out.clone());
    Ok(out)
}

/// 只覆盖 patch 出现的键（对象语义）。数组状态请直接用 write。
pub fn patch(file: &Path, defaults: Value, patch: &Value) -> Result<Value, String> {
    let mut merged = read(file, defaults);
    match (merged.as_object_mut(), patch.as_object()) {
        (Some(t), Some(p)) => {
            for (k, v) in p {
                t.insert(k.clone(), v.clone());
            }
        }
        _ => return Err("只有对象配置支持 patch".to_string()),
    }
    write(file, merged)
}

/// 丢弃缓存，强制下一次 read 重新读盘（多实例调试用）。
pub fn invalidate(file: &Path) {
    caches().lock().expect("store 缓存表被污染").remove(file);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 环境变量是进程级的，并发测试会互踩，统一串行化。
    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("z-bot-store-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        dir
    }

    fn cfg_defaults() -> Value {
        json!({ "petName": "Z-Bot 小猫咪", "voiceSpeed": 1.0 })
    }

    #[test]
    fn missing_file_falls_back_to_defaults_without_writing() {
        let _g = crate::lock_test_env();
        let dir = isolated("missing");
        let f = config_file();
        assert_eq!(read(&f, cfg_defaults()), cfg_defaults());
        assert!(!f.exists(), "read 不该创建配置文件");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn write_leaves_no_temp_file_and_read_fills_defaults() {
        let _g = crate::lock_test_env();
        let dir = isolated("atomic");
        let _ = std::fs::remove_dir_all(&dir);
        let f = config_file();
        let got = write(&f, json!({ "petName": "改名了" })).expect("写入应成功");
        // write 是全量替换，不补默认值；补齐发生在重新读盘（与 Electron 的 JsonStore 一致）
        assert_eq!(got, json!({ "petName": "改名了" }));
        invalidate(&f);
        assert_eq!(read(&f, cfg_defaults())["voiceSpeed"], json!(1.0));
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "不应残留临时文件: {:?}", left);
        // 落盘内容必须真的能被重新解析
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(on_disk["petName"], json!("改名了"));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn corrupt_file_is_backed_up_not_dropped() {
        let _g = crate::lock_test_env();
        let dir = isolated("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = config_file();
        std::fs::write(&f, b"{ not json").unwrap();
        invalidate(&f);
        assert_eq!(read(&f, cfg_defaults()), cfg_defaults());
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt."))
            .count();
        assert_eq!(kept, 1, "损坏原件应留下备份");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn array_state_is_stored_verbatim() {
        let _g = crate::lock_test_env();
        let dir = isolated("array");
        let _ = std::fs::remove_dir_all(&dir);
        let f = history_file();
        write(&f, json!([{ "id": "1", "role": "user" }])).expect("历史写入应成功");
        assert_eq!(read(&f, json!([])).as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn patch_touches_only_the_keys_given() {
        let _g = crate::lock_test_env();
        let dir = isolated("patch");
        let _ = std::fs::remove_dir_all(&dir);
        let f = config_file();
        write(&f, json!({ "petName": "a", "themeColor": "#722ed1" })).unwrap();
        invalidate(&f);
        patch(&f, cfg_defaults(), &json!({ "petName": "b" })).expect("patch 应成功");
        let got = read(&f, cfg_defaults());
        assert_eq!(got["petName"], json!("b"));
        assert_eq!(got["themeColor"], json!("#722ed1"));
        assert_eq!(got["voiceSpeed"], json!(1.0));
        assert!(patch(&f, cfg_defaults(), &json!([])).is_err(), "数组不能 patch");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

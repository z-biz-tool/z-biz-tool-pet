//! 长期记忆：对照 src/main/memory-system.ts（P3）。
//!
//! 只搬"真的被调用到"的那几个函数。Electron 侧的短期记忆（shortTermMemory）、
//! buildMemoryContext、removeLongTermMemory、resetMemory 全仓库没有调用方 ——
//! 记忆上下文甚至从没注入过 AI 请求，所谓"长期记忆"实际是只写不读的存档。
//! 这里保留它的可观测部分（同一份 long_term_memory.json），不补那些没人用的接口。
//!
//! 与 Electron 的差异只有一处、且是修 bug：D11 当年是"目录没初始化导致持久化必失败"，
//! Rust 侧文件名统一走 store::data_dir()，不存在未初始化状态。

use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde_json::{json, Value};

use crate::store;

/// 与 Electron 同名同位置：~/.z-bot/long_term_memory.json
pub fn memory_file() -> std::path::PathBuf {
    store::data_dir().join("long_term_memory.json")
}

fn entries() -> &'static Mutex<Vec<Value>> {
    static MEM: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    MEM.get_or_init(|| Mutex::new(Vec::new()))
}

/// 启动时读盘；损坏文件由 store::read 备份成 .corrupt.<ms>，这里只处理"不是数组"的情况
pub fn init() {
    let loaded = store::read(&memory_file(), json!([]));
    let list = loaded.as_array().cloned().unwrap_or_default();
    *entries().lock().expect("记忆表被污染") = list;
}

/// 同 key 覆盖内容、置信度取两者较大；新 key 直接追加。落盘是整表替换。
pub fn add_long_term_memory(key: &str, content: &str, confidence: i64) {
    let now = store::now_iso();
    {
        let mut mem = entries().lock().expect("记忆表被污染");
        if let Some(existing) = mem.iter_mut().find(|m| m.get("key").and_then(|v| v.as_str()) == Some(key)) {
            existing["content"] = json!(content);
            existing["updatedAt"] = json!(&now);
            let prev = existing.get("confidence").and_then(|v| v.as_i64()).unwrap_or(0);
            existing["confidence"] = json!(prev.max(confidence));
        } else {
            // id 沿用 mem_<毫秒>，与 Electron 生成的旧条目同一格式
            let id = format!("mem_{}", chrono::Utc::now().timestamp_millis());
            mem.push(json!({
                "id": id,
                "key": key,
                "content": content,
                "createdAt": &now,
                "updatedAt": &now,
                "confidence": confidence,
            }));
        }
    }
    flush();
    println!("[Memory] 添加长期记忆: {key}");
}

fn flush() {
    let snapshot = json!(entries().lock().expect("记忆表被污染").clone());
    if let Err(e) = store::write(&memory_file(), snapshot) {
        eprintln!("[Memory] 保存长期记忆失败: {e}");
    }
}

/// 当前长期记忆快照。Electron 侧的 getLongTermMemory 没有任何调用方，
/// 这里留着是给测试观察内存表，以及后续可能出现的"记忆面板"。
#[allow(dead_code)]
pub fn long_term() -> Vec<Value> {
    entries().lock().expect("记忆表被污染").clone()
}

struct Pattern {
    key: &'static str,
    /// 命中这些关键词之一才尝试正则（与 Electron 的 patterns.some(includes) 一致）
    hints: &'static [&'static str],
    source: &'static str,
}

/// 四条模式串与 memory-system.ts 逐字对齐；改一条要同步两边（P4 删 Electron 前）。
fn patterns() -> Vec<Pattern> {
    vec![
        Pattern { key: "用户生日", hints: &["生日", "出生日期", "birthday"], source: r"(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?)" },
        Pattern { key: "用户邮箱", hints: &["邮箱", "email", "@"], source: r"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})" },
        Pattern { key: "用户喜好", hints: &["喜欢", "爱", "偏好", "爱好"], source: r"喜欢(的)?(.{1,50})" },
        Pattern { key: "工作内容", hints: &["工作", "职位", "公司", "职业"], source: r"(在|担任|是)(.{1,30})" },
    ]
}

/// JS 的 substring(0,100) 数的是 UTF-16 单元；中文与 ASCII 都是 1 单元，
/// 只有 emoji（代理对）会差一倍。按字符截更合理，也足够贴近原行为。
fn take_100(s: &str) -> String {
    s.chars().take(100).collect()
}

/// 从对话里抽记忆。入参是 (role, content) 序列，
/// 与 Electron 一样：拼成 "role: content" 后统一小写再匹配。
pub fn extract_from_conversation(messages: &[(&str, &str)]) {
    let text = messages
        .iter()
        .map(|(role, content)| format!("{role}: {content}"))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();

    for p in patterns() {
        if !p.hints.iter().any(|h| text.contains(h)) {
            continue;
        }
        // 正则构造失败按"这条不抽"处理：坏模式不该让整次抽取报错
        let Ok(re) = Regex::new(p.source) else { continue };
        if let Some(m) = re.find(&text) {
            add_long_term_memory(p.key, &take_100(m.as_str()), 90);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn birthday_and_email_are_captured() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-memory-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        store::invalidate(&memory_file());
        let _ = std::fs::remove_dir_all(&dir);
        init();

        extract_from_conversation(&[
            ("user", "我的生日是 1995-03-07，邮箱 zhang@example.com"),
            ("assistant", "记下了"),
        ]);

        let got = long_term();
        let keys: Vec<&str> = got.iter().filter_map(|m| m["key"].as_str()).collect();
        assert!(keys.contains(&"用户生日"), "实际: {keys:?}");
        assert!(keys.contains(&"用户邮箱"), "实际: {keys:?}");
        let birthday = got.iter().find(|m| m["key"] == json!("用户生日")).unwrap();
        assert_eq!(birthday["content"], json!("1995-03-07"));
        assert_eq!(birthday["confidence"], json!(90));
        // 落盘必须真的发生（D11 的回归点）
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(memory_file()).unwrap()).unwrap();
        assert_eq!(on_disk.as_array().unwrap().len(), got.len());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn same_key_updates_instead_of_duplicating() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-memory-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        store::invalidate(&memory_file());
        let _ = std::fs::remove_dir_all(&dir);
        init();

        add_long_term_memory("用户邮箱", "a@example.com", 60);
        add_long_term_memory("用户邮箱", "b@example.com", 80);
        add_long_term_memory("用户邮箱", "c@example.com", 40);

        let got = long_term();
        assert_eq!(got.len(), 1, "同 key 应覆盖而不是追加");
        assert_eq!(got[0]["content"], json!("c@example.com"));
        // 置信度取历史最大值，不是最后一次
        assert_eq!(got[0]["confidence"], json!(80));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn irrelevant_chat_writes_nothing() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-memory-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        store::invalidate(&memory_file());
        let _ = std::fs::remove_dir_all(&dir);
        init();
        extract_from_conversation(&[("user", "今天天气怎么样")]);
        assert!(long_term().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

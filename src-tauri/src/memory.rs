//! 长期记忆（v2）：从「只写不读的存档」升级成「记得住、想得起、用得上」。
//!
//! v1 的问题写在它自己的注释里：四条正则把话抽出来落盘，然后**再也没有人读过**——
//! `buildMemoryContext` 全仓库没有调用方，记忆从没进过任何一次 AI 请求。
//! 那本"记忆"实际是一份只写不读的存档：用户问她"我生日几号"，她照样不知道。
//!
//! v2 补三件事：
//! 1. **结构化**：条目带 kind / key / confidence / source / tags / hits / pinned。
//!    旧文件是裸数组，`init` 里就地迁移，不丢用户已经攒下的记忆。
//! 2. **可检索**：中文按 2-gram、西文按词切，按「命中度 + 置信度 + 时间衰减 +
//!    常用度 + 置顶」打分。全是纯函数，能单测，不碰网络。
//! 3. **能注入**：`prompt_context()` 产出可直接拼进 system prompt 的片段，
//!    router 在**每一次** chat / stream 前调用。被用到的条目累加 hits ——
//!    越常被想起的越容易被想起，人也是这么记东西的。
//!
//! 抽取有两条路：本地正则（零延迟，兜底）与 mind.rs 的 LLM 抽取（慢但准，
//! 能抽"他讨厌开会前十分钟改需求"这种正则永远抓不到的东西）。两条路写同一张表，
//! 靠 key + 内容归一化去重。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store;

/// 落盘格式版本。裸数组 = v1，`{version, entries}` = v2。
const SCHEMA_VERSION: u64 = 2;
/// 上限：再多就不是"记忆"而是日志了，检索也会变慢
const MAX_ENTRIES: usize = 2000;
/// 注入 system prompt 的字数硬上限（约 600 token，别把上下文挤爆）
const MAX_CONTEXT_CHARS: usize = 900;
/// 一次最多注入几条
const CONTEXT_LIMIT: usize = 12;
/// 时间衰减半衰期（天）；超过半年的旧事仍然能被关键词精确命中带出来
const DECAY_DAYS: f64 = 45.0;

pub const KINDS: [&str; 6] = ["fact", "preference", "person", "event", "plan", "trait"];

/// 与 Electron 同名同位置：~/.z-bot/long_term_memory.json
pub fn memory_file() -> std::path::PathBuf {
    store::data_dir().join("long_term_memory.json")
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Memory {
    pub id: String,
    /// fact | preference | person | event | plan | trait
    pub kind: String,
    /// 去重用的短标题，归一化后比较（"用户生日" / "生日"）
    pub key: String,
    /// 一句话事实，注入 prompt 用的就是它
    pub content: String,
    /// 可选补充（LLM 抽出来的上下文原句）
    pub detail: String,
    /// 0..100，正则抽取 60~90、LLM 抽取 80、用户手动 100
    pub confidence: i64,
    /// regex | llm | manual | episode | migration
    pub source: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: String,
    /// 被检索命中的次数，参与打分
    pub hits: u32,
    /// 置顶：永远进上下文（用户手动钉的"重要的事"）
    pub pinned: bool,
    /// 归档：不参与检索，但保留可查（"她忘掉了但没删"）
    pub archived: bool,
}

impl Memory {
    fn label(&self) -> &'static str {
        match self.kind.as_str() {
            "preference" => "偏好",
            "person" => "人",
            "event" => "经历",
            "plan" => "打算",
            "trait" => "性格",
            _ => "事实",
        }
    }

    /// 参与检索的全文
    fn haystack(&self) -> String {
        format!(
            "{} {} {} {}",
            self.key,
            self.content,
            self.detail,
            self.tags.join(" ")
        )
    }
}

struct Table {
    items: Vec<Memory>,
    dirty: bool,
    /// 上次写盘时刻：recall 每命中一次就写盘会抖，节流成 30s 一次
    last_flush: i64,
    loaded: bool,
}

fn table() -> &'static Mutex<Table> {
    static T: OnceLock<Mutex<Table>> = OnceLock::new();
    T.get_or_init(|| {
        Mutex::new(Table {
            items: Vec::new(),
            dirty: false,
            last_flush: 0,
            loaded: false,
        })
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn days_since(iso: &str, now: i64) -> f64 {
    match parse_ms(iso) {
        Some(t) if now > t => (now - t) as f64 / 86_400_000.0,
        _ => 0.0,
    }
}

// ---------- 落盘 ----------

/// 启动时读盘。旧格式（裸数组）在这里就地迁移成 v2，不需要用户做任何事。
pub fn init() {
    let raw = store::read(&memory_file(), json!([]));
    let mut items = from_disk(&raw);
    items.truncate(MAX_ENTRIES);
    let migrated = raw.is_array() && !items.is_empty();
    {
        let mut t = table().lock().expect("记忆表被污染");
        t.items = items;
        t.loaded = true;
        t.dirty = migrated;
        t.last_flush = 0;
    }
    if migrated {
        // 迁移立刻落盘一次，否则下次启动又当 v1 重来
        flush(true);
    }
}

fn from_disk(raw: &Value) -> Vec<Memory> {
    let list = match raw {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o
            .get("entries")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    list.into_iter()
        .filter_map(|v| serde_json::from_value::<Memory>(v).ok())
        .map(|mut m| {
            if m.id.is_empty() {
                m.id = new_id();
            }
            if m.kind.is_empty() {
                m.kind = "fact".into();
            }
            if m.source.is_empty() {
                m.source = "migration".into();
            }
            if m.confidence <= 0 {
                m.confidence = 60;
            }
            if m.updated_at.is_empty() {
                m.updated_at = store::now_iso();
            }
            if m.created_at.is_empty() {
                m.created_at = m.updated_at.clone();
            }
            if m.key.is_empty() {
                m.key = auto_key(&m.content);
            }
            m
        })
        .collect()
}

fn snapshot(items: &[Memory]) -> Value {
    json!({ "version": SCHEMA_VERSION, "entries": items })
}

/// 批量写入（一次抽取写多条）后必须强制收口，否则节流窗口内的后几条会留在内存里
pub fn flush_now() {
    flush(true);
}

fn flush(force: bool) {
    let payload = {
        let mut t = table().lock().expect("记忆表被污染");
        if !t.dirty {
            return;
        }
        let now = now_ms();
        if !force && now - t.last_flush < 30_000 {
            return;
        }
        t.last_flush = now;
        t.dirty = false;
        snapshot(&t.items)
    };
    if let Err(e) = store::write(&memory_file(), payload) {
        eprintln!("[Memory] 保存长期记忆失败: {e}");
        // 没写成功就把 dirty 打回去，下一次还有机会
        table().lock().expect("记忆表被污染").dirty = true;
    }
}

// ---------- 归一化与去重 ----------

fn new_id() -> String {
    format!("mem_{}", chrono::Utc::now().timestamp_micros())
}

/// key 归一化：去空白与标点、统一小写，用来判断"是不是同一件事"
fn norm_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn auto_key(content: &str) -> String {
    content.chars().take(16).collect()
}

fn norm_content(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !"、，,。．.！!？?～~…·\"'“”‘’()（）".contains(*c))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

// ---------- 分词与打分 ----------

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF |      // 假名
        0x3400..=0x4DBF |      // 扩展 A
        0x4E00..=0x9FFF |      // 基本汉字
        0xF900..=0xFAFF)
}

/// 高频繁虚词 2-gram：不滤掉的话"我的""你的"能让任意两条记忆互相关联
const STOP_BIGRAMS: &[&str] = &[
    "我的", "你的", "他的", "她的", "我们", "你们", "他们", "是一", "一个", "这个", "那个",
    "什么", "没有", "可以", "就是", "不是", "了吗", "的话", "知道", "觉得", "现在", "今天",
    "时候", "这样", "那样", "怎么", "因为", "所以", "但是", "如果", "已经", "还是", "应该",
    "起来", "出来", "有点", "一些", "然后", "而且", "或者", "自己", "东西", "事情",
];

fn push_cjk_run(run: &mut Vec<char>, out: &mut HashSet<String>) {
    match run.len() {
        0 => {}
        1 => {
            out.insert(run[0].to_string());
        }
        _ => {
            for w in run.windows(2) {
                let g: String = w.iter().collect();
                if STOP_BIGRAMS.contains(&g.as_str()) {
                    continue;
                }
                out.insert(g);
            }
        }
    }
    run.clear();
}

/// 中英混排分词：汉字走 2-gram，西文/数字走词。够用且零依赖 ——
/// 为一个桌面手办的记忆去引 jieba 不值得，2-gram 对"冰美式""周四下午"这类
/// 实体反而召回更稳（分词器容易把它们切成没意义的碎片）。
pub fn tokens(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut cjk: Vec<char> = Vec::new();
    let mut latin = String::new();

    for c in text.chars() {
        if is_cjk(c) {
            if !latin.is_empty() {
                if latin.chars().count() >= 2 {
                    out.insert(std::mem::take(&mut latin));
                } else {
                    latin.clear();
                }
            }
            cjk.push(c);
        } else if c.is_alphanumeric() {
            push_cjk_run(&mut cjk, &mut out);
            latin.extend(c.to_lowercase());
        } else {
            push_cjk_run(&mut cjk, &mut out);
            if latin.chars().count() >= 2 {
                out.insert(std::mem::take(&mut latin));
            } else {
                latin.clear();
            }
        }
    }
    push_cjk_run(&mut cjk, &mut out);
    if latin.chars().count() >= 2 {
        out.insert(latin);
    }
    out
}

/// 相关度。五项相加，权重是调出来的手感值：
/// 关键词命中是主信号，置信度/新鲜度/常用度做微调，置顶直接压过一切。
pub fn relevance(m: &Memory, q: &HashSet<String>, now: i64) -> f64 {
    if q.is_empty() {
        return 0.0;
    }
    let hay = tokens(&m.haystack());
    let hit = q.iter().filter(|t| hay.contains(*t)).count() as f64;
    if hit == 0.0 {
        return 0.0;
    }
    // 用 sqrt 归一：长 query 不该因为词多就压过短 query 的精确命中
    let kw = hit / (q.len() as f64).sqrt();
    let conf = (m.confidence.clamp(0, 100) as f64) / 100.0;
    let rec = (-days_since(&m.updated_at, now) / DECAY_DAYS).exp();
    let pin = if m.pinned { 0.6 } else { 0.0 };
    let used = (m.hits.min(5) as f64) / 5.0 * 0.15;

    kw + 0.35 * conf + 0.30 * rec + pin + used
}

// ---------- 写入 ----------

/// 唯一的写入口：同 kind 同 key 合并，内容重复也合并。
/// `source` 说明这条记忆怎么来的，UI 上要显示（"她自己记下的" vs "你让她记的"）。
pub fn upsert(
    kind: &str,
    key: &str,
    content: &str,
    detail: &str,
    confidence: i64,
    source: &str,
    tags: &[String],
) -> Memory {
    let kind = if KINDS.contains(&kind) { kind } else { "fact" };
    let key = if key.trim().is_empty() {
        auto_key(content)
    } else {
        key.trim().to_string()
    };
    let now = store::now_iso();
    let kk = norm_key(&key);
    let cc = norm_content(content);

    let mut t = table().lock().expect("记忆表被污染");
    if !t.loaded {
        drop(t);
        init();
        t = table().lock().expect("记忆表被污染");
    }

    // 1) 同 key 同 kind：覆盖内容，置信度取两者较大（"他亲口说过"比"我猜的"可信）
    if !kk.is_empty() {
        if let Some(existing) = t
            .items
            .iter_mut()
            .find(|m| m.kind == kind && norm_key(&m.key) == kk)
        {
            if norm_content(&existing.content) != cc {
                existing.content = content.to_string();
                existing.detail = detail.to_string();
                existing.updated_at = now.clone();
                existing.source = source.to_string();
                if !tags.is_empty() {
                    existing.tags = tags.to_vec();
                }
            }
            existing.confidence = existing.confidence.max(confidence);
            existing.archived = false;
            let out = existing.clone();
            t.dirty = true;
            drop(t);
            flush(false);
            println!("[Memory] 更新记忆: {kind}/{key}");
            return out;
        }
    }

    // 2) 同 kind 内容重复（key 写法不同）：也算同一条
    if !cc.is_empty() {
        if let Some(existing) = t
            .items
            .iter_mut()
            .find(|m| m.kind == kind && norm_content(&m.content) == cc)
        {
            existing.confidence = existing.confidence.max(confidence);
            existing.archived = false;
            let out = existing.clone();
            t.dirty = true;
            drop(t);
            flush(false);
            return out;
        }
    }

    let entry = Memory {
        id: new_id(),
        kind: kind.to_string(),
        key,
        content: content.to_string(),
        detail: detail.to_string(),
        confidence,
        source: source.to_string(),
        tags: tags.to_vec(),
        created_at: now.clone(),
        updated_at: now,
        last_used_at: String::new(),
        hits: 0,
        pinned: false,
        archived: false,
    };
    t.items.push(entry.clone());

    // 超额时先丢「最不重要」的：非置顶优先，其次置信度低、最久没更新
    if t.items.len() > MAX_ENTRIES {
        let now_i = now_ms();
        let mut idx = 0;
        let mut worst = f64::MAX;
        for (i, m) in t.items.iter().enumerate() {
            if m.pinned {
                continue;
            }
            let s = (m.confidence as f64) / 100.0 + (-days_since(&m.updated_at, now_i) / 90.0).exp();
            if s < worst {
                worst = s;
                idx = i;
            }
        }
        t.items.remove(idx);
    }

    t.dirty = true;
    drop(t);
    flush(false);
    println!("[Memory] 添加记忆: {}/{}", entry.kind, entry.key);
    entry
}

// ---------- 读取 ----------

pub fn all() -> Vec<Memory> {
    let mut v = {
        let t = table().lock().expect("记忆表被污染");
        t.items.clone()
    };
    v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    v
}

/// 检索：只返回真的命中关键词的条目（空 query 时返回置顶 + 最近）。
/// `touch` 为真时累加 hits —— 只有"真的被拿去用了"才算用过。
pub fn recall(query: &str, limit: usize, touch: bool) -> Vec<Memory> {
    let q = tokens(query);
    let now = now_ms();

    let mut scored: Vec<(f64, Memory)> = {
        let t = table().lock().expect("记忆表被污染");
        t.items
            .iter()
            .filter(|m| !m.archived && !m.content.trim().is_empty())
            .map(|m| {
                let s = if q.is_empty() {
                    if m.pinned {
                        2.0
                    } else {
                        (-days_since(&m.updated_at, now) / DECAY_DAYS).exp()
                    }
                } else {
                    relevance(m, &q, now)
                };
                (s, m.clone())
            })
            .filter(|(s, _)| *s > 0.0)
            .collect()
    };

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit.max(1));
    let mut out: Vec<Memory> = scored.into_iter().map(|(_, m)| m).collect();
    if out.is_empty() {
        return out;
    }

    if touch {
        let ids: HashSet<String> = out.iter().map(|m| m.id.clone()).collect();
        let iso = store::now_iso();
        {
            let mut t = table().lock().expect("记忆表被污染");
            for m in t.items.iter_mut() {
                if ids.contains(&m.id) {
                    m.hits = m.hits.saturating_add(1);
                    m.last_used_at = iso.clone();
                }
            }
            t.dirty = true;
        }
        flush(false);
        // 返回的副本也要带上新 hits，否则 UI 看到的是上一次的数
        for m in out.iter_mut() {
            m.hits = m.hits.saturating_add(1);
            m.last_used_at = iso.clone();
        }
    }

    out
}

/// 直接拼进 system prompt 的片段。返回 None 表示这次没什么可提的 ——
/// 空记忆时宁可什么都不加，也别塞一段"你没有任何记忆"的废话污染 prompt。
pub fn prompt_context(query: &str) -> Option<String> {
    let hits = recall(query, CONTEXT_LIMIT, true);
    if hits.is_empty() {
        return None;
    }

    let mut body = String::new();
    for m in &hits {
        let line = format!("- [{}] {}\n", m.label(), m.content.trim());
        if body.chars().count() + line.chars().count() > MAX_CONTEXT_CHARS {
            break;
        }
        body.push_str(&line);
    }
    if body.trim().is_empty() {
        return None;
    }

    Some(format!(
        "## 你记得的关于他的事\n\
         以下是你们相处下来你记住的东西。像一个熟人那样自然地用它们，\
         不要逐条复述，不要说「根据记忆」，也不要说「你之前告诉过我」——\
         直接接话就好。记不清的就问，别编。\n{body}"
    ))
}

// ---------- 归档 / 删除 / 统计 ----------

pub fn delete(id: &str) -> bool {
    let removed = {
        let mut t = table().lock().expect("记忆表被污染");
        let before = t.items.len();
        t.items.retain(|m| m.id != id);
        let removed = t.items.len() != before;
        if removed {
            t.dirty = true;
        }
        removed
    };
    if removed {
        flush(true);
    }
    removed
}

/// scope = "all" 全清；"archived" 只清归档。返回清掉的条数。
pub fn clear(scope: &str) -> usize {
    let removed = {
        let mut t = table().lock().expect("记忆表被污染");
        let before = t.items.len();
        if scope == "archived" {
            t.items.retain(|m| !m.archived);
        } else {
            t.items.clear();
        }
        let removed = before - t.items.len();
        if removed > 0 {
            t.dirty = true;
        }
        removed
    };
    if removed > 0 {
        flush(true);
    }
    removed
}

pub fn stats() -> Value {
    let t = table().lock().expect("记忆表被污染");
    let live: Vec<&Memory> = t.items.iter().filter(|m| !m.archived).collect();
    let mut by_kind = serde_json::Map::new();
    for k in KINDS {
        by_kind.insert(k.to_string(), json!(live.iter().filter(|m| m.kind == k).count()));
    }
    let oldest = live.iter().map(|m| m.created_at.clone()).min();
    let newest = live.iter().map(|m| m.created_at.clone()).max();
    let mut sorted = live.clone();
    sorted.sort_by(|a, b| b.hits.cmp(&a.hits));
    let top: Vec<Value> = sorted
        .iter()
        .take(3)
        .filter(|m| m.hits > 0)
        .map(|m| json!({ "id": m.id, "content": m.content, "hits": m.hits }))
        .collect();

    json!({
        "total": live.len(),
        "archived": t.items.iter().filter(|m| m.archived).count(),
        "pinned": live.iter().filter(|m| m.pinned).count(),
        "byKind": by_kind,
        "oldest": oldest,
        "newest": newest,
        "mostUsed": top,
        "file": memory_file().display().to_string(),
    })
}

// ---------- 正则抽取（兜底路径） ----------

struct Pattern {
    kind: &'static str,
    key: &'static str,
    /// 命中这些关键词之一才尝试正则
    hints: &'static [&'static str],
    source: &'static str,
    confidence: i64,
}

/// 本地正则只管"一定能结构化"的东西：生日、邮箱、称呼、明确说出口的偏好。
/// 语义层面的记忆交给 mind.rs 的 LLM 抽取 —— 正则抄不动"他周三下午总是开完会
/// 才想起来吃饭"这种句子，硬写只会写出一堆误报。
fn patterns() -> Vec<Pattern> {
    vec![
        Pattern {
            kind: "fact",
            key: "用户生日",
            hints: &["生日", "出生日期", "birthday"],
            source: r"(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?)",
            confidence: 90,
        },
        Pattern {
            kind: "person",
            key: "用户邮箱",
            hints: &["邮箱", "email", "@"],
            source: r"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})",
            confidence: 90,
        },
        Pattern {
            kind: "preference",
            key: "用户喜好",
            hints: &["喜欢", "讨厌", "受不了", "偏好"],
            source: r"((?:喜欢|讨厌|受不了|偏好)(的)?(.{1,40}))",
            confidence: 70,
        },
        Pattern {
            kind: "fact",
            key: "工作内容",
            hints: &["工作", "职位", "公司", "职业"],
            source: r"(在|担任|是)(.{1,30})",
            confidence: 60,
        },
        Pattern {
            kind: "person",
            key: "怎么称呼他",
            hints: &["叫我", "我叫", "称呼我"],
            source: r"(?:叫我|我叫|称呼我)(.{1,16})",
            confidence: 95,
        },
    ]
}

fn take_100(s: &str) -> String {
    s.chars().take(100).collect()
}

/// 从对话里抽记忆。入参是 (role, content) 序列。
/// 只抽 user 说的话 —— 把她自己的回复也拿去抽，会把她的猜测记成事实。
pub fn extract_from_conversation(messages: &[(&str, &str)]) {
    let text = messages
        .iter()
        .filter(|(role, _)| *role == "user")
        .map(|(_, content)| content.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return;
    }
    let lower = text.to_lowercase();

    for p in patterns() {
        if !p.hints.iter().any(|h| lower.contains(h)) {
            continue;
        }
        let Ok(re) = Regex::new(p.source) else {
            continue;
        };
        // 在原文（不是小写文本）上找，保留大小写与中文
        if let Some(m) = re.find(&text) {
            let content = take_100(m.as_str().trim());
            if content.chars().count() < 3 {
                continue;
            }
            upsert(p.kind, p.key, &content, "", p.confidence, "regex", &[]);
        }
    }
    flush_now();
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn memory_list(query: Option<String>, kind: Option<String>, limit: Option<usize>) -> Vec<Memory> {
    let cap = limit.unwrap_or(200).clamp(1, MAX_ENTRIES);
    let q = query.unwrap_or_default();
    let want = kind.unwrap_or_default();

    let mut list = if q.trim().is_empty() {
        all()
    } else {
        // 管理端搜索：给足上限，再在下面按 kind 过滤
        recall(&q, MAX_ENTRIES, false)
    };
    if !want.is_empty() && want != "all" {
        list.retain(|m| m.kind == want);
    }
    list.truncate(cap);
    list
}

#[tauri::command]
pub fn memory_add(
    content: String,
    kind: Option<String>,
    key: Option<String>,
    confidence: Option<i64>,
) -> Memory {
    upsert(
        kind.as_deref().unwrap_or("fact"),
        key.as_deref().unwrap_or(""),
        content.trim(),
        "",
        confidence.unwrap_or(100).clamp(1, 100),
        "manual",
        &[],
    )
}

/// 只接受白名单字段，避免渲染端一次 patch 把 hits / createdAt 洗掉
#[tauri::command]
pub fn memory_update(id: String, patch: Value) -> Option<Memory> {
    let mut t = table().lock().expect("记忆表被污染");
    let entry = t.items.iter_mut().find(|m| m.id == id)?;

    if let Some(v) = patch.get("content").and_then(|v| v.as_str()) {
        if !v.trim().is_empty() {
            entry.content = v.trim().to_string();
        }
    }
    if let Some(v) = patch.get("key").and_then(|v| v.as_str()) {
        entry.key = v.trim().to_string();
    }
    if let Some(v) = patch.get("kind").and_then(|v| v.as_str()) {
        if KINDS.contains(&v) {
            entry.kind = v.to_string();
        }
    }
    if let Some(v) = patch.get("confidence").and_then(|v| v.as_i64()) {
        entry.confidence = v.clamp(1, 100);
    }
    if let Some(v) = patch.get("pinned").and_then(|v| v.as_bool()) {
        entry.pinned = v;
    }
    if let Some(v) = patch.get("archived").and_then(|v| v.as_bool()) {
        entry.archived = v;
    }
    entry.updated_at = store::now_iso();
    let out = entry.clone();
    t.dirty = true;
    drop(t);
    flush(true);
    Some(out)
}

#[tauri::command]
pub fn memory_delete(id: String) -> bool {
    delete(&id)
}

#[tauri::command]
pub fn memory_clear(scope: Option<String>) -> usize {
    clear(scope.as_deref().unwrap_or("all"))
}

#[tauri::command]
pub fn memory_stats() -> Value {
    stats()
}

/// 管理端的"她会怎么想起这件事"预览：给她一句话，看她能想起什么。
/// 这是唯一能让人直观判断"记忆到底有没有用"的界面。
#[tauri::command]
pub fn memory_recall_preview(query: String) -> Value {
    let hits = recall(&query, CONTEXT_LIMIT, false);
    let scored: Vec<Value> = hits
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "kind": m.kind,
                "key": m.key,
                "content": m.content,
                "confidence": m.confidence,
                "source": m.source,
                "hits": m.hits,
            })
        })
        .collect();
    json!({
        "context": prompt_context(&query).unwrap_or_default(),
        "hits": scored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("z-bot-memory-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        store::invalidate(&memory_file());
        let _ = std::fs::remove_dir_all(&dir);
        init();
        dir
    }

    fn done(dir: std::path::PathBuf) {
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn birthday_and_email_are_captured() {
        let _g = crate::lock_test_env();
        let dir = fresh();

        extract_from_conversation(&[
            ("user", "我的生日是 1995-03-07，邮箱 zhang@example.com"),
            ("assistant", "记下了"),
        ]);

        let got = all();
        let keys: Vec<&str> = got.iter().map(|m| m.key.as_str()).collect();
        assert!(keys.contains(&"用户生日"), "实际: {keys:?}");
        assert!(keys.contains(&"用户邮箱"), "实际: {keys:?}");
        let birthday = got.iter().find(|m| m.key == "用户生日").unwrap();
        assert_eq!(birthday.content, "1995-03-07");
        assert_eq!(birthday.confidence, 90);

        // 落盘必须真的发生，而且是 v2 形状
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(memory_file()).unwrap()).unwrap();
        assert_eq!(on_disk["version"], json!(2));
        assert_eq!(on_disk["entries"].as_array().unwrap().len(), got.len());
        done(dir);
    }

    #[test]
    fn assistant_side_never_creates_memories() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        // 她自己的猜测不能被记成事实
        extract_from_conversation(&[("assistant", "我猜你的生日是 1995-03-07")]);
        assert!(all().is_empty());
        done(dir);
    }

    #[test]
    fn same_key_updates_instead_of_duplicating() {
        let _g = crate::lock_test_env();
        let dir = fresh();

        upsert("fact", "用户邮箱", "a@example.com", "", 60, "regex", &[]);
        upsert("fact", "用户邮箱", "b@example.com", "", 80, "regex", &[]);
        upsert("fact", "用户邮箱", "c@example.com", "", 40, "regex", &[]);

        let got = all();
        assert_eq!(got.len(), 1, "同 key 应覆盖而不是追加");
        assert_eq!(got[0].content, "c@example.com");
        assert_eq!(got[0].confidence, 80, "置信度取历史最大值");
        done(dir);
    }

    #[test]
    fn irrelevant_chat_writes_nothing() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        extract_from_conversation(&[("user", "今天天气怎么样")]);
        assert!(all().is_empty());
        done(dir);
    }

    #[test]
    fn v1_array_file_migrates_in_place() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        // 造一个 v1 的裸数组文件，模拟老用户升级
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            memory_file(),
            r#"[{"id":"mem_1","key":"用户生日","content":"1995-03-07",
                "createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z",
                "confidence":90}]"#,
        )
        .unwrap();
        store::invalidate(&memory_file());
        init();

        let got = all();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "fact", "旧条目补默认 kind");
        assert_eq!(got[0].source, "migration");

        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(memory_file()).unwrap()).unwrap();
        assert_eq!(on_disk["version"], json!(2), "迁移后必须写成 v2");
        done(dir);
    }

    #[test]
    fn recall_ranks_by_keyword_then_confidence() {
        let _g = crate::lock_test_env();
        let dir = fresh();

        upsert("preference", "咖啡", "喜欢喝冰美式，不加糖", "", 80, "llm", &[]);
        upsert("fact", "生日", "1995 年 3 月 7 日", "", 90, "manual", &[]);
        upsert("plan", "旅行", "下个月想去北海道看雪", "", 70, "llm", &[]);

        let hits = recall("我想喝杯咖啡", 3, false);
        assert!(!hits.is_empty(), "必须能想起咖啡");
        assert_eq!(hits[0].key, "咖啡", "最相关的排第一");

        let hits = recall("我生日是哪天", 3, false);
        assert_eq!(hits[0].key, "生日");

        // 完全不相关的 query 不该硬凑
        assert!(recall("量子色动力学", 3, false).is_empty());
        done(dir);
    }

    #[test]
    fn pinned_memory_survives_empty_query_and_wins_ties() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        let a = upsert("fact", "旧事", "很久以前的事", "", 50, "llm", &[]);
        upsert("fact", "近事", "刚刚发生的事", "", 50, "llm", &[]);
        // 走真实入口而不是直接改内存：置顶是 UI 的置顶按钮打的 patch
        memory_update(a.id.clone(), json!({ "pinned": true })).expect("置顶失败");

        let hits = recall("", 5, false);
        assert_eq!(hits[0].key, "旧事", "置顶在空 query 下排最前");
        done(dir);
    }

    #[test]
    fn prompt_context_carries_recalled_facts_and_bumps_hits() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        upsert("person", "怎么称呼他", "叫他老板", "", 100, "manual", &[]);

        let ctx = prompt_context("老板今天开会吗").expect("应当有上下文");
        assert!(ctx.contains("叫他老板"));
        assert!(ctx.contains("你记得的关于他的事"));

        let m = all().into_iter().find(|m| m.key == "怎么称呼他").unwrap();
        assert_eq!(m.hits, 1, "被用过要计次");
        assert!(!m.last_used_at.is_empty());
        done(dir);
    }

    #[test]
    fn context_respects_char_budget() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        for i in 0..40 {
            let long = "很长的记忆内容".repeat(6);
            upsert("fact", &format!("条目{i}"), &format!("{long}{i}"), "", 90, "llm", &[]);
        }
        let ctx = prompt_context("很长的记忆内容").unwrap();
        assert!(
            ctx.chars().count() <= MAX_CONTEXT_CHARS + 200,
            "实际 {} 字",
            ctx.chars().count()
        );
        done(dir);
    }

    #[test]
    fn archived_entries_are_not_recalled_but_still_listed() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        let m = upsert("fact", "临时事", "明天记得交表", "", 80, "llm", &[]);
        memory_update(m.id.clone(), json!({ "archived": true })).expect("归档失败");

        assert!(recall("交表", 5, false).is_empty());
        assert_eq!(all().len(), 1, "归档 ≠ 删除");
        done(dir);
    }

    #[test]
    fn stats_counts_by_kind_and_clear_works() {
        let _g = crate::lock_test_env();
        let dir = fresh();
        upsert("preference", "咖啡", "喜欢冰美式", "", 80, "llm", &[]);
        upsert("fact", "生日", "1995-03-07", "", 90, "manual", &[]);
        let s = stats();
        assert_eq!(s["total"], json!(2));
        assert_eq!(s["byKind"]["preference"], json!(1));
        assert_eq!(clear("all"), 2);
        assert!(all().is_empty());
        done(dir);
    }

    #[test]
    fn tokenizer_splits_cjk_and_latin_and_drops_stop_bigrams() {
        let t = tokens("我的 MacBook 是 2023 款");
        assert!(t.contains("macbook"));
        assert!(t.contains("2023"));
        assert!(t.contains("款"), "单字汉字也算");
        assert!(!t.contains("我的"), "虚词不应参与匹配");
    }
}

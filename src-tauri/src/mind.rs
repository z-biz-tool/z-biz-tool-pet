//! 心智层：让她「真的在想事」。
//!
//! 三件事，全部由本地/局域网小模型驱动，任何一步失败都静默降级：
//!
//! 1. **抽取记忆**（`extract_and_store`）—— 正则抽不动的语义记忆交给模型。
//!    一次调用同时产出「这次一起做了什么」的摘要，写成 event 记忆，就是她的日记。
//! 2. **内心活动**（`reflect`）—— 两阶段：先发 3 个念头，再自评挑一个拆成动作脚本。
//!    这是"活着"和"死板"的分界线：台词池是常量，同一个场景永远同一句；
//!    而念头是每次现想的，带着当下的时间、她记得的事、他多久没理她。
//! 3. **日记**（`diary`）—— event 类记忆按时间倒序，就是她记事的方式。
//!
//! 为什么要两次调用而不是一次：一次调用让它"想到什么说什么"，产出的是客服话术；
//! 先发散再收敛，第二个 prompt 里明确要求「选最好的那个，不是最像话术的那个」，
//! 出来的东西才有"她自己挑的"感觉。
//!
//! 模型来源：`mindUrl` / `mindModel` 没填就复用主对话 provider。
//! 这样单模型用户也能用，多模型用户（比如本机 ollama 跑 8b 做杂活）能省钱省显存。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::ai::{self, ChatRequest, Message, Provider};
use crate::{memory, state};

/// 动作白名单：必须与前端 animations.ts 的 AnimationType 完全一致，
/// 模型编出来的动作在这里被过滤掉，否则播放器拿到未知 key 会静默不动。
pub const ACTIONS: [&str; 16] = [
    "idle", "float", "walk", "dance", "roll", "jump", "wiggle", "stretch", "spin", "yawn",
    "sleep", "chase", "blink", "bounce", "shake", "wobble",
];

/// 情绪白名单：必须是 shared/emotions.ts 里的 key
pub const EMOTIONS: [&str; 12] = [
    "happy", "cute", "shy", "sleepy", "playful", "proud", "loving", "thinking", "excited",
    "tsundere", "comforting", "neutral",
];

// 超时给得宽，是因为这两件事都在后台跑，用户感觉不到"等"：
// 她发呆想事情本来就不该是即时的。实测一台**没有驻留模型**的机器上，
// 每次请求都要重新加载权重（20~60s），窄超时会让功能看起来完全坏掉；
// 而模型真驻留时一次只要 3~6s。宁可慢，不可用不了。
// ---------- 输出结构（交给 ollama 做语法约束） ----------

fn enum_of(list: &[&str]) -> Value {
    json!(list)
}

/// 抽记忆的输出结构
fn extract_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "memories": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": enum_of(&memory::KINDS) },
                        "key": { "type": "string" },
                        "content": { "type": "string" },
                        // 区间必须写死：不写的话 llama.cpp 的 grammar 约束不住它，
                        // 实测模型会返回 1（把 0~1 的习惯带过来），clamp_conf 只夹到
                        // 1..=100 不会放大 —— 一条 confidence=1 的记忆在检索里等于不存在。
                        "confidence": { "type": "integer", "minimum": 1, "maximum": 100 }
                    },
                    "required": ["kind", "key", "content", "confidence"]
                }
            },
            "summary": { "type": "string" }
        },
        "required": ["memories", "summary"]
    })
}

/// 第一个念头：三选一用的候选表
fn thoughts_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "thoughts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "thought": { "type": "string" },
                        "line": { "type": "string" },
                        "action": { "type": "string", "enum": enum_of(&ACTIONS) },
                        "emotion": { "type": "string", "enum": enum_of(&EMOTIONS) }
                    },
                    "required": ["thought", "line", "action", "emotion"]
                }
            }
        },
        "required": ["thoughts"]
    })
}

/// 第二个阶段：挑一个 + 动作脚本
fn script_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "pick": { "type": "integer" },
            "thought": { "type": "string" },
            "line": { "type": "string" },
            "emotion": { "type": "string", "enum": enum_of(&EMOTIONS) },
            "importance": { "type": "integer" },
            "script": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "anim": { "type": "string", "enum": enum_of(&ACTIONS) },
                        "dur": { "type": "integer" },
                        "line": { "type": "string" }
                    },
                    "required": ["anim", "dur", "line"]
                }
            }
        },
        "required": ["pick", "thought", "line", "emotion", "importance", "script"]
    })
}

const EXTRACT_TIMEOUT: Duration = Duration::from_secs(90);
const REFLECT_TIMEOUT: Duration = Duration::from_secs(90);
/// 抽取节流：每 N 轮用户输入抽一次。每轮都抽会让本地 GPU 一直占着，
/// 主对话的首字延迟肉眼可见地变长。
const EXTRACT_EVERY: usize = 2;
/// 一次抽取最多看多少条消息（换算成 prompt 长度）
const EXTRACT_WINDOW: usize = 14;

fn turn_counter() -> &'static AtomicUsize {
    static N: AtomicUsize = AtomicUsize::new(0);
    &N
}

fn busy() -> &'static AtomicBool {
    static B: AtomicBool = AtomicBool::new(false);
    &B
}

/// 推理互斥：抽取与内心活动抢同一张显卡，撞上就跳过而不是排队。
/// 用原子 CAS 而不是 Mutex —— 持有 MutexGuard 跨 await 会让 future 变成
/// 非 Send，Tauri 的 spawn 直接编不过（stdlib mutex 的 guard 不是 Send）。
fn claim() -> bool {
    busy()
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn release() {
    busy().store(false, Ordering::Release);
}

// ---------- 配置与 provider ----------

fn cfg_str(cfg: &Value, key: &str) -> String {
    cfg.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn enabled(cfg: &Value) -> bool {
    cfg.get("mindEnabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

/// 心智专用 provider。mindUrl 为空时整体复用主对话 provider ——
/// 单模型用户填不了第二个地址，也不该被迫填。
fn provider(cfg: &Value) -> Provider {
    let base = ai::provider_from_config(cfg);
    let url = cfg_str(cfg, "mindUrl");
    if url.is_empty() {
        return base;
    }
    let model = {
        let m = cfg_str(cfg, "mindModel");
        if m.is_empty() {
            base.models.first().cloned().unwrap_or_default()
        } else {
            m
        }
    };
    Provider {
        id: "mind".into(),
        name: "心智模型".into(),
        // ptype 在这里只是"走不走直连"的开关，不是真协议 —— 具体说 ollama 的
        // /api/chat 还是 OpenAI 的 /v1/chat/completions，由 normalize_base
        // 加一次 404 探测决定（见 Wire 一节）。llama.cpp / vLLM / LM Studio
        // 都能用，用户不用知道自己填的是哪一家。
        ptype: "ollama".into(),
        base_url: url,
        api_key: cfg_str(cfg, "mindApiKey"),
        models: vec![model],
        supports_vision: false,
        supports_streaming: false,
        supports_tools: false,
    }
}

fn model_for(provider: &Provider, cfg: &Value) -> String {
    let m = cfg_str(cfg, "mindModel");
    if !m.is_empty() {
        return m;
    }
    provider.models.first().cloned().unwrap_or_default()
}

// ---------- 模型调用 ----------
//
// 心智层不走 ai::chat 的统一抽象，而是对本地推理服务直连，原因有三条，都是实测出来的：
//
// 1. **关思考**。"抽一条记忆""想一个念头"这种短任务，思考链是纯浪费。
//    实测 qwen3:8b 回一句"在的"要 216 个 token（11s），关掉思考后 6 个 token（0.3s）；
//    llama.cpp 上更致命 —— 200 token 预算会全部变成英文 reasoning，正文是空的。
// 2. **keep_alive / 常驻**。本地机器同时只驻留一个模型，换模型代价是 25~90 秒的
//    加载（实测 load_duration 90441ms）。不钉住的话，两次内心活动之间模型会被
//    换出去，下一次她"发呆"能发三分钟。
// 3. **num_predict 上限**。不设上限，模型会在 JSON 后面继续解释。
//
// 非本地的主 provider（openai/claude/…）仍然回落 ai::chat，功能不减。

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .unwrap_or_default()
}

// ---------- 线协议 ----------
//
// 本地推理服务不是一家的。Ollama 说 `/api/chat`，llama.cpp / vLLM / LM Studio /
// 各家代理说 OpenAI 的 `/v1/chat/completions`。只认 ollama 意味着用户填了
// llama.cpp 地址就一直是"连不上"，而且**报错文案会误导他去查模型**。
//
// 所以：地址先归一，猜不出就先按 ollama 试，404 立刻换 OpenAI 线协议重发，
// 结果缓存下来 —— 404 是这类服务端一致且秒回的应答（llama.cpp 实测 0.01s），
// 比预检一个 /health 更可靠，也不用为探测多打一次往返。

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wire {
    Ollama,
    Openai,
}

impl Wire {
    pub fn as_str(self) -> &'static str {
        match self {
            Wire::Ollama => "ollama",
            Wire::Openai => "openai",
        }
    }
}

/// 把用户填的地址归一成 (base, 协议线索)。
///
/// 长后缀必须先匹配：`/chat/completions` 是 `/v1/chat/completions` 的后缀，
/// 顺序反了会把 `/v1` 留在 base 里，拼端点时变成 `/v1/v1/...`。
pub fn normalize_base(raw: &str) -> (String, Wire) {
    let u = raw.trim().trim_end_matches('/').to_string();
    for (suffix, wire) in [
        ("/v1/chat/completions", Wire::Openai),
        ("/chat/completions", Wire::Openai),
        ("/v1", Wire::Openai),
        ("/api/chat", Wire::Ollama),
        ("/api", Wire::Ollama),
    ] {
        if let Some(b) = u.strip_suffix(suffix) {
            // OpenAI 系剥掉 /v1，端点拼接时再加回去
            let b = if wire == Wire::Openai { b.trim_end_matches("/v1") } else { b };
            return (b.to_string(), wire);
        }
    }
    (u, Wire::Ollama)
}

fn wire_cache() -> &'static Mutex<HashMap<String, Wire>> {
    static C: OnceLock<Mutex<HashMap<String, Wire>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 探测结果缓存整个进程生命周期：一个地址的协议不会中途改口。
/// 只拿锁拷贝一份出来就放开，绝不跨 await 持有（guard 不是 Send）。
fn cached_wire(base: &str) -> Option<Wire> {
    wire_cache().lock().ok().and_then(|m| m.get(base).copied())
}

fn remember_wire(base: &str, w: Wire) {
    if let Ok(mut m) = wire_cache().lock() {
        m.insert(base.to_string(), w);
    }
}

/// 最终用哪条线。`mindProtocol` 是用户的手动覆盖，只对 mindUrl 生效 ——
/// 复用主 provider 时不该被心智的设置污染。
fn resolve_wire(cfg: &Value, base: &str, inferred: Wire) -> Wire {
    if cfg_str(cfg, "mindUrl").is_empty() {
        return inferred;
    }
    match cfg_str(cfg, "mindProtocol").to_ascii_lowercase().as_str() {
        "ollama" => Wire::Ollama,
        "openai" | "openai-compatible" | "openai_compatible" => Wire::Openai,
        _ => cached_wire(base).unwrap_or(inferred),
    }
}

/// 404 是"这条路根本不通"，和"这条路通但东西不对"必须分开：
/// 前者要换协议，后者要原样报错，混为一谈会让协议探测吃掉真正的错误信息。
struct CallError {
    msg: String,
    not_found: bool,
}

async fn post_chat(endpoint: &str, body: &Value, budget: Duration) -> Result<(u16, String), String> {
    let call = http().post(endpoint).header("Content-Type", "application/json").json(body).send();
    let resp = match tokio::time::timeout(budget, call).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(format!("心智模型连不上（{endpoint}）：{e}")),
        Err(_) => return Err(format!("心智模型 {}s 内没有响应", budget.as_secs())),
    };
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((code, text))
}

/// 两条线（ollama / OpenAI 兼容）共用同一套 5xx 诊断，避免"换个地址就换一种报错"。
fn http_error(code: u16, text: &str) -> String {
    if code >= 500 {
        return format!("心智模型 {code}{}：{}", hint_for_5xx(code), head(text, 160));
    }
    format!("心智模型 {code}：{}", head(text, 160))
}

/// 一次心智推理的全部入参。
///
/// 用结构体而不是八九个位置参数：`temperature` 和 `max_tokens` 都是数字、紧挨着，
/// 调换顺序编译器一声不吭，只会在运行时静默地用错采样参数 —— 这种 bug
/// 表现为"模型突然变笨"，查起来极其费劲。
struct Req<'a> {
    base: &'a str,
    model: &'a str,
    system: &'a str,
    user: &'a str,
    budget: Duration,
    temperature: f64,
    max_tokens: i64,
    schema: Option<&'a Value>,
}

async fn ollama_complete(r: &Req<'_>) -> Result<String, CallError> {
    let endpoint = format!("{}/api/chat", r.base);
    let mut body = serde_json::json!({
        "model": r.model,
        "messages": [
            { "role": "system", "content": r.system },
            { "role": "user", "content": r.user },
        ],
        "stream": false,
        // 关闭思考链：抽一条记忆、想一个念头这种短任务，思考是纯浪费。
        // 实测回一句"在的"：开思考 216 token/11s，关掉 6 token/0.3s。
        "think": false,
        // 钉住模型：本地机同时只驻留一个模型，换模型的加载代价是 20~90 秒。
        "keep_alive": "30m",
        "options": {
            "temperature": r.temperature,
            "num_predict": r.max_tokens,
            "top_p": 0.9,
        },
    });
    // 结构化输出：把 JSON Schema 交给 ollama 做语法约束，模型就**不可能**
    // 输出非法 JSON，也不会把推理过程混进正文（实测 qwen3:30b-a3b 会这么做，
    // 提示词里写十遍"只输出 JSON"都拦不住）。
    if let Some(schema) = r.schema {
        body["format"] = schema.clone();
    }

    let (code, text) = post_chat(&endpoint, &body, r.budget)
        .await
        .map_err(|e| CallError { msg: e, not_found: false })?;
    if !(200..300).contains(&code) {
        return Err(CallError { msg: http_error(code, &text), not_found: code == 404 });
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| CallError {
        msg: format!("心智模型返回的不是 JSON（{e}）：{}", head(&text, 160)),
        not_found: false,
    })?;
    Ok(data
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}

/// OpenAI 兼容线：llama.cpp / vLLM / LM Studio / 各种代理都走这条。
async fn openai_complete(r: &Req<'_>) -> Result<String, String> {
    let endpoint = if r.base.ends_with("/v1") {
        format!("{}/chat/completions", r.base)
    } else {
        format!("{}/v1/chat/completions", r.base)
    };

    let mut body = serde_json::json!({
        "messages": [
            { "role": "system", "content": r.system },
            { "role": "user", "content": r.user },
        ],
        "stream": false,
        "temperature": r.temperature,
        "max_tokens": r.max_tokens,
        // 思考型模板（llama.cpp --jinja + Qwen3 系）默认开思考，200 个 token 的预算
        // 会全部变成英文 reasoning_content、content 是空的。实测带上这个参数后
        // 同一个请求 1.7s 出合法 JSON。不认识这个字段的服务端一般直接忽略。
        "chat_template_kwargs": { "enable_thinking": false },
    });
    // model 可以不给：llama.cpp 单模型时无所谓填什么，而用户常常不知道该填
    // 全路径还是短名。留空就别发这个字段，比填一个错的强。
    if !r.model.is_empty() {
        body["model"] = Value::String(r.model.into());
    }
    if let Some(schema) = r.schema {
        body["response_format"] = serde_json::json!({
            "type": "json_schema",
            // strict 不敢开 true：llama.cpp 的 grammar 生成器对嵌套数组 + enum
            // 的支持是够用的，但 strict 会再叠一层逐字段校验，老版本直接 400。
            "json_schema": { "name": "mind", "strict": false, "schema": schema },
        });
    }

    let (code, text) = post_chat(&endpoint, &body, r.budget).await?;

    // 老版 llama.cpp / 部分代理不认识 response_format，会 400/422。
    // 剥掉再发一次：模型在提示词 + extract_json 的配合下仍能产出可用 JSON
    //（实测去掉后照样是合法 JSON），只是少了语法级保证。
    if matches!(code, 400 | 422) {
        if let Some(obj) = body.as_object_mut() {
            if obj.remove("response_format").is_some() {
                let (c2, t2) = post_chat(&endpoint, &body, r.budget).await?;
                return parse_openai(c2, &t2);
            }
        }
    }
    parse_openai(code, &text)
}

/// 服务端 5xx 常常只有一句 "Compute error"，用户看了完全不知道该怎么办。
/// 实测过一整轮：Metal 后端一旦显存不足就会进入错误态，**而且不会自愈**，
/// 后续所有请求（哪怕只要 16 个 token）都在 0.02 秒内秒回同一个 500。
/// 这种情况只能重启那台机器上的推理服务，重试和改配置都没用。
/// 所以错误文案要直接把结论说出来，别让用户去猜。
fn hint_for_5xx(code: u16) -> &'static str {
    match code {
        500 => "（服务端算力/显存不足，且已进入错误态——需要重启那台机器上的推理服务，重试无效）",
        502..=504 => "（上游推理服务没起来或正在重启，稍等再试）",
        _ => "（服务端内部错误）",
    }
}

fn parse_openai(code: u16, text: &str) -> Result<String, String> {
    if !(200..300).contains(&code) {
        return Err(http_error(code, text));
    }
    let data: Value =
        serde_json::from_str(text).map_err(|e| format!("心智模型返回的不是 JSON（{e}）：{}", head(text, 160)))?;
    let msg = data.pointer("/choices/0/message").cloned().unwrap_or(Value::Null);
    let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
    if !content.is_empty() {
        return Ok(content);
    }
    // content 空但 reasoning 非空 = 思考模型把预算烧光了。这条错误要能直接指出
    // 该怎么改，不然用户只会看到"她不理我"。
    let reasoned = msg
        .get("reasoning_content")
        .and_then(|r| r.as_str())
        .is_some_and(|s| !s.is_empty());
    if reasoned {
        return Err(
            "模型在思考里把 token 烧光了，正文是空的。llama.cpp 需要 chat_template_kwargs.enable_thinking=false（本客户端已自动带上），或把 num_predict 调大"
                .into(),
        );
    }
    Err("心智模型返回了空内容".into())
}

async fn chat_complete(r: &Req<'_>, wire: Wire) -> Result<String, String> {
    match wire {
        // 404 = 这个地址根本不是 ollama。llama.cpp / vLLM / LM Studio
        // 对 /api/chat 一致地秒回 404（实测 0.01s），是干净的探测信号。
        Wire::Ollama => match ollama_complete(r).await {
            Err(CallError { not_found: true, .. }) => {
                remember_wire(r.base, Wire::Openai);
                openai_complete(r).await
            }
            Err(e) => Err(e.msg),
            Ok(s) => {
                remember_wire(r.base, Wire::Ollama);
                Ok(s)
            }
        },
        Wire::Openai => {
            let out = openai_complete(r).await;
            if out.is_ok() {
                remember_wire(r.base, Wire::Openai);
            }
            out
        }
    }
}

async fn complete(
    cfg: &Value,
    system: &str,
    user: &str,
    budget: Duration,
    temperature: f64,
    max_tokens: i64,
    schema: Option<&Value>,
) -> Result<String, String> {
    let p = provider(cfg);
    let model = model_for(&p, cfg);

    if p.ptype == "ollama" {
        let (base, inferred) = normalize_base(&p.base_url);
        let wire = resolve_wire(cfg, &base, inferred);
        // ollama 必须有模型名；OpenAI 兼容端可以不给（单模型服务端无所谓填什么）
        if model.is_empty() && wire == Wire::Ollama {
            return Err("没有可用的心智模型，请先在设置里选一个".into());
        }
        let req = Req { base: &base, model: &model, system, user, budget, temperature, max_tokens, schema };
        return chat_complete(&req, wire).await;
    }

    let req = ChatRequest {
        messages: vec![
            Message { role: "system".into(), content: system.into(), images: None },
            Message { role: "user".into(), content: user.into(), images: None },
        ],
        model,
        stream: None,
        tools: None,
    };
    match tokio::time::timeout(budget, ai::chat(&p, &req)).await {
        Ok(Ok(r)) => Ok(r.content),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("心智模型 {}s 内没有响应", budget.as_secs())),
    }
}

/// 模型很爱在 JSON 前后加 ```json 或者解释一句。这里把第一个完整 JSON 值抠出来。
pub fn extract_json(raw: &str) -> Option<Value> {
    let s = raw.trim();
    // 去掉围栏
    let s = if let Some(i) = s.find("```") {
        let after = &s[i + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        match after.find("```") {
            Some(j) => after[..j].trim(),
            None => after.trim(),
        }
    } else {
        s
    };

    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return Some(v);
    }

    // 混了说明文字：从**最先出现**的那个括号开始配对。
    // 顺序不能写死 —— "结果：{\"pick\":2,\"script\":[]}" 里先出现的是 '{'，
    // 若按 [ 优先会先匹配到内层的 []，直接返回一个空数组。
    let first = s.char_indices().find(|(_, c)| *c == '{' || *c == '[');
    let order: [(char, char); 2] = match first.map(|(_, c)| c) {
        Some('{') => [('{', '}'), ('[', ']')],
        _ => [('[', ']'), ('{', '}')],
    };
    for (open_ch, close_ch) in order {
        if let Some(start) = s.find(open_ch) {
            let mut depth = 0i32;
            let mut in_str = false;
            let mut esc = false;
            for (off, c) in s[start..].char_indices() {
                if in_str {
                    if esc {
                        esc = false;
                    } else if c == '\\' {
                        esc = true;
                    } else if c == '"' {
                        in_str = false;
                    }
                    continue;
                }
                match c {
                    '"' => in_str = true,
                    c if c == open_ch => depth += 1,
                    c if c == close_ch => {
                        depth -= 1;
                        if depth == 0 {
                            let end = start + off + c.len_utf8();
                            if let Ok(v) = serde_json::from_str::<Value>(&s[start..end]) {
                                return Some(v);
                            }
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

fn clamp_conf(v: &Value) -> i64 {
    v.as_i64().unwrap_or(70).clamp(1, 100)
}

fn sanitize_action(a: &str) -> String {
    let s = a.trim().to_lowercase();
    if ACTIONS.contains(&s.as_str()) {
        s
    } else {
        "idle".into()
    }
}

fn sanitize_emotion(e: &str) -> String {
    let s = e.trim().to_lowercase();
    if EMOTIONS.contains(&s.as_str()) {
        s
    } else {
        "happy".into()
    }
}

// ---------- 1. 记忆抽取 ----------

/// 每 N 轮返回 true。由 router 在每次 chat 后问一次。
pub fn tick_turn() -> bool {
    let n = turn_counter().fetch_add(1, Ordering::Relaxed) + 1;
    n % EXTRACT_EVERY == 0
}

/// 从最近的对话里抽记忆 + 生成一段摘要。返回新写入的条数。
///
/// 现有记忆的 key 会喂回去，让模型知道"这些我已经记住了"，避免每次重复写
/// 同一条 —— 否则聊一晚上，记忆表里会有 20 条"他喜欢喝咖啡"。
pub async fn extract_and_store(cfg: &Value, turns: &[(String, String)]) -> Result<usize, String> {
    if !enabled(cfg) {
        return Err("心智层已关闭".into());
    }
    let auto = cfg
        .get("autoExtractMemory")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !auto {
        return Ok(0);
    }

    // 只留 user/assistant，忽略 system；取最近一小段
    let window: Vec<&(String, String)> = turns
        .iter()
        .filter(|(role, _)| role == "user" || role == "assistant")
        .collect();
    if window.is_empty() {
        return Ok(0);
    }
    let tail: Vec<&(String, String)> = window.iter().rev().take(EXTRACT_WINDOW).rev().copied().collect();
    let user_chars: usize = tail
        .iter()
        .filter(|(r, _)| r == "user")
        .map(|(_, c)| c.chars().count())
        .sum();
    // 只有一句"嗯""好"的对话不值得起一次推理
    if user_chars < 8 {
        return Ok(0);
    }

    let known: Vec<String> = {
        let mut v: Vec<String> = memory::all().iter().map(|m| m.key.clone()).collect();
        v.truncate(60);
        v
    };

    let system = format!(
        "你在维护一只桌面看板娘对她主人（下称「他」）的长期记忆。\n\
         从对话里挑出「以后还用得上」的信息，写成她随时能想起来的一句话。\n\n\
         只记这些：\n\
         - 他的身份、称呼、所在城市、职业、作息\n\
         - 他喜欢/讨厌的东西、口味、习惯、口头禅\n\
         - 他身边的人与关系（同事、家人、宠物）\n\
         - 他正在做的事、定下的计划、答应过的事\n\
         - 他的情绪触发点（什么让他烦、什么让他高兴）\n\n\
         绝对不要记：\n\
         - 一次性的提问、寒暄、天气、通用知识\n\
         - 她自己说的话、她的猜测\n\
         - 任何他没亲口说过的东西\n\n\
         写作要求：\n\
         - content ≤ 40 字，第三人称「他」，陈述句，不要引号，不要「用户说」这种前缀\n\
         - kind 取其一：fact(客观事实) preference(喜好厌恶) person(人物关系) \
           event(发生过的事) plan(打算待办) trait(性格习惯)\n\
         - key 是 2~6 字短标题。**同一件事必须复用同一个 key**（比如都叫「咖啡」），\
           否则会被写成两条\n\
         - confidence：他明确说过的 90，推断的 60\n\n\
         这些是他已有的记忆，不要重复记；如果新信息推翻了旧的，用同一个 key 再写一次：\n{}\n\n\
         另外，如果这段对话是一次完整的任务或一段有内容的聊天，用一句话（≤40 字）\
         概括「这次一起做了什么、结果如何」，写进 summary；闲聊寒暄就给空字符串。\n\n\
         只输出 JSON，不要解释：\n\
         {{\"memories\":[{{\"kind\":\"preference\",\"key\":\"咖啡\",\"content\":\"喜欢冰美式不加糖\",\"confidence\":90}}],\"summary\":\"\"}}\n\
         memories 最多 6 条，宁少勿滥，没有就给空数组。",
        if known.is_empty() {
            "（还没有任何记忆）".to_string()
        } else {
            known.join("、")
        }
    );

    let transcript = tail
        .iter()
        .map(|(role, content)| {
            let who = if role == "user" { "他" } else { "她" };
            format!("{who}: {}", content.chars().take(500).collect::<String>())
        })
        .collect::<Vec<_>>()
        .join("\n");

    // 内心活动正在推理：这轮跳过，记忆不会丢（下一轮窗口里还有）
    if !claim() {
        return Ok(0);
    }
    let raw = complete(cfg, &system, &transcript, EXTRACT_TIMEOUT, 0.3, 900, Some(&extract_schema())).await;
    release();

    let raw = raw?;
    let parsed = extract_json(&raw).ok_or_else(|| format!("模型返回的不是 JSON：{}", head(&raw, 120)))?;

    // 反幻觉闸门：模型会"顺嘴"补出对话里根本没有的信息 ——
    // 实测在一段讲述职和开会的对话里，它抽出了「喜欢冰美式不加糖」。
    // 这种编造的记忆比没有记忆更糟：她会当真事一样在对话里引用。
    // 判据很朴素：content 里的实词必须在原文里真的出现过。
    let source_tokens = memory::tokens(&transcript);

    let mut added = 0usize;
    let mut dropped = 0usize;
    if let Some(list) = parsed.get("memories").and_then(|v| v.as_array()) {
        for item in list.iter().take(6) {
            let content = item
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if content.chars().count() < 2 || content.chars().count() > 120 {
                continue;
            }
            let content_tokens = memory::tokens(&content);
            let overlap = content_tokens
                .iter()
                .filter(|t| source_tokens.contains(*t))
                .count();
            if overlap == 0 {
                dropped += 1;
                println!("[Mind] 丢弃疑似编造的记忆：{content}");
                continue;
            }
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("fact");
            let key = item.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let conf = clamp_conf(item.get("confidence").unwrap_or(&json!(80)));
            memory::upsert(kind, key, &content, "", conf, "llm", &[]);
            added += 1;
        }
    }
    if dropped > 0 {
        println!("[Mind] 本轮丢弃 {dropped} 条无出处的内容");
    }

    // 日记：summary 非空就记一条 event
    if let Some(summary) = parsed.get("summary").and_then(|v| v.as_str()) {
        let s = summary.trim();
        if s.chars().count() >= 6 {
            let now = chrono::Local::now();
            let key = format!("{} 的对话", now.format("%m-%d %H:%M"));
            memory::upsert("event", &key, s, "", 85, "episode", &[]);
            added += 1;
        }
    }

    if added > 0 {
        // 一次抽取会写多条：节流窗口里后几条不能只留在内存
        memory::flush_now();
        println!("[Mind] 抽取完成：{added} 条");
    }
    Ok(added)
}

fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---------- 2. 内心活动 ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub anim: String,
    pub dur: u32,
    pub line: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    /// 内心 OS：不上屏（除非她决定说出来），进日志/日记
    pub thought: String,
    /// 说出口的那一句，可能为空 = 只是做了个动作
    pub line: String,
    pub emotion: String,
    pub script: Vec<Cue>,
    /// 0~100：她以后会不会记得这件事
    pub importance: i64,
    pub model: String,
    /// 两阶段各自的耗时，便于排查"卡在哪一步"
    pub elapsed_ms: u64,
}

/// 她此刻的处境。前端把自己的实时状态喂进来，Rust 不重复维护一份。
fn situation(cfg: &Value, state_in: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    let name = {
        let n = cfg_str(cfg, "petName");
        if n.is_empty() {
            "看板娘".to_string()
        } else {
            n
        }
    };

    let hour = chrono::Local::now().format("%H:%M").to_string();
    parts.push(format!("现在是 {hour}"));

    if let Some(idle) = state_in.get("idleMinutes").and_then(|v| v.as_i64()) {
        if idle >= 30 {
            parts.push(format!("他已经 {idle} 分钟没理我了"));
        } else if idle <= 2 {
            parts.push("他刚刚还在跟我说话".into());
        }
    }
    if let Some(mode) = state_in.get("mode").and_then(|v| v.as_str()) {
        if mode == "focus" {
            parts.push("他在专注做事，我不能打扰".into());
        }
    }
    if let Some(min) = state_in.get("focusToday").and_then(|v| v.as_i64()) {
        if min > 0 {
            parts.push(format!("他今天已经专注了 {min} 分钟"));
        }
    }
    if let Some(aff) = state_in.get("affection").and_then(|v| v.as_i64()) {
        let rel = match aff {
            0..=20 => "我们还不熟",
            21..=50 => "我们算是认识了",
            51..=80 => "我们挺熟的",
            _ => "我很喜欢他，但不会说",
        };
        parts.push(rel.to_string());
    }
    if let Some(energy) = state_in.get("energy").and_then(|v| v.as_i64()) {
        if energy < 30 {
            parts.push("我有点困了".into());
        }
    }

    // 她记得的事（不带 touch，别为了想事情把 hits 刷起来）
    let q = state_in.get("topic").and_then(|v| v.as_str()).unwrap_or("");
    let memories = memory::recall(q, 5, false);
    let mem_block = if memories.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = memories
            .iter()
            .map(|m| format!("- {}", m.content))
            .collect();
        format!("\n你记得关于他的事：\n{}", lines.join("\n"))
    };

    // 她最近做过什么（日记），用来避免一天里重复同一个动作
    let diary = diary(3);
    let diary_block = if diary.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = diary
            .iter()
            .map(|d| format!("- {}", d.get("content").and_then(|v| v.as_str()).unwrap_or("")))
            .collect();
        format!("\n你最近记下的：\n{}", lines.join("\n"))
    };

    format!("{name}。{}{mem_block}{diary_block}", parts.join("，"))
}

/// 两阶段内心活动。返回 Err 时前端退回本地台词池，不显示任何错误 ——
/// 她"发呆"是正常状态，不该弹一个"心智模型不可用"的提示。
pub async fn reflect(cfg: &Value, state_in: Value) -> Result<Beat, String> {
    if !enabled(cfg) {
        return Err("心智层已关闭".into());
    }
    // 上一次还没想完：别排队，直接让前端这次跳过（她偶尔"慢了半拍"是对的）
    if !claim() {
        return Err("还在想上一件事".into());
    }
    let out = reflect_inner(cfg, state_in).await;
    release();
    out
}

async fn reflect_inner(cfg: &Value, state_in: Value) -> Result<Beat, String> {
    let started = Instant::now();
    let sit = situation(cfg, &state_in);
    let actions = ACTIONS.join(" / ");
    let emotions = EMOTIONS.join(" / ");

    // ---- 第一阶段：发散 ----
    let sys_a = format!(
        "你是一个住在别人电脑桌面上的小姑娘，不是助手程序。\n\
         你会走神、会好奇、会想被夸、会偷偷看他、会自己找点事做、会觉得无聊。\n\
         {sit}\n\n\
         以「我此刻真的会想到什么」为准，给我 3 个**完全不同**的念头。\n\
         每个念头 = 一瞬间的内心 OS + 她可能做的一个动作。\n\
         动作只能从这些里选：{actions}\n\
         情绪只能从这些里选：{emotions}\n\n\
         要求：\n\
         - 具体、有画面感。写「他桌面上那个红色的图标又亮了」而不是「我在观察环境」\n\
         - 不要客服话术，不要说「我可以帮你」「有什么需要」\n\
         - 不要每次都撒娇，允许无聊、犯困、走神、赌气\n\
         - 3 个念头要有反差：一个温柔的，一个调皮的，一个安静的\n\n\
         只输出 JSON 数组，不要解释：\n\
         [{{\"thought\":\"内心OS ≤30字\",\"line\":\"说出口的一句 ≤20字，可以空字符串\",\"action\":\"动作\",\"emotion\":\"情绪\"}}]"
    );
    let raw_a = complete(cfg, &sys_a, "现在你脑子里冒出什么？", REFLECT_TIMEOUT, 0.9, 600, Some(&thoughts_schema())).await?;
    let cands = extract_json(&raw_a).ok_or_else(|| "第一阶段的念头不是 JSON".to_string())?;
    let arr = cands
        .as_array()
        .cloned()
        .or_else(|| cands.get("thoughts").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();
    if arr.is_empty() {
        return Err("模型没有给出任何念头".into());
    }

    let listed = arr
        .iter()
        .take(3)
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{}. 内心：{}｜想说：{}｜动作：{}｜情绪：{}",
                i + 1,
                c.get("thought").and_then(|v| v.as_str()).unwrap_or(""),
                c.get("line").and_then(|v| v.as_str()).unwrap_or("（不出声）"),
                c.get("action").and_then(|v| v.as_str()).unwrap_or("idle"),
                c.get("emotion").and_then(|v| v.as_str()).unwrap_or("happy"),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let midpoint = started.elapsed().as_millis() as u64;

    // ---- 第二阶段：收敛 ----
    let sys_b = format!(
        "你就是刚才那个小姑娘。刚才脑子里冒出过这几个念头：\n{listed}\n\n\
         现在挑一个「此刻最像你」的 —— 不是最有用的，是最像你的。\
         如果你正犯困，就挑犯困的那个；如果你在赌气，就挑赌气的那个。\n\n\
         然后把它拆成 1~3 步**能播放的动作脚本**。每步：\n\
         - anim：{actions}\n\
         - dur：这一步持续多少毫秒，800~6000\n\
         - line：这一步说的一句（≤20 字），不说就给空字符串\n\n\
         脚本要像真的动作：比如「先走过去 walk 1800 → 探头 blink 900 → 说一句 idle 1500」。\
         不要 3 步都是同一个动作。\n\n\
         importance：这件事你以后会不会记得（0-100）。日常小动作给 20~40，\
         他难过了你去安慰、他说了重要的话这种给 70+。\n\n\
         只输出 JSON，不要解释：\n\
         {{\"pick\":1,\"thought\":\"\",\"line\":\"\",\"emotion\":\"\",\"importance\":30,\"script\":[{{\"anim\":\"walk\",\"dur\":1800,\"line\":\"\"}}]}}"
    );
    // 第二阶段失败不致命：发散出来的念头本身就是一次完整的内心活动，
    // 拿第一个候选直接播就是了 —— 总比"她想了一下又什么都没做"好。
    let picked = match complete(cfg, &sys_b, "选吧。", REFLECT_TIMEOUT, 0.6, 500, Some(&script_schema())).await {
        Ok(raw) => extract_json(&raw),
        Err(e) => {
            println!("[Mind] 第二阶段失败，用首选念头兜底：{e}");
            None
        }
    };
    let empty = json!({});
    let picked = picked.as_ref().unwrap_or(&empty);

    // 模型偶尔会漏字段：用候选者兜底，保证前端拿到的永远是完整的 Beat
    let pick_idx = picked
        .get("pick")
        .and_then(|v| v.as_i64())
        .unwrap_or(1)
        .clamp(1, arr.len() as i64) as usize;
    let fallback = &arr[pick_idx - 1];

    let mut script: Vec<Cue> = Vec::new();
    if let Some(list) = picked.get("script").and_then(|v| v.as_array()) {
        for step in list.iter().take(4) {
            let line = step
                .get("line")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            script.push(Cue {
                anim: sanitize_action(step.get("anim").and_then(|v| v.as_str()).unwrap_or("idle")),
                dur: step
                    .get("dur")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(1600)
                    .clamp(800, 6000) as u32,
                line: head(&line, 40),
            });
        }
    }
    if script.is_empty() {
        script.push(Cue {
            anim: sanitize_action(
                fallback.get("action").and_then(|v| v.as_str()).unwrap_or("idle"),
            ),
            dur: 1800,
            line: String::new(),
        });
    }

    let str_of = |v: &Value, key: &str| -> String {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };

    let line = {
        let l = str_of(&picked, "line");
        if l.is_empty() {
            str_of(fallback, "line")
        } else {
            l
        }
    };
    let thought = {
        let t = str_of(&picked, "thought");
        if t.is_empty() {
            str_of(fallback, "thought")
        } else {
            t
        }
    };
    let emotion = sanitize_emotion(&{
        let e = str_of(&picked, "emotion");
        if e.is_empty() {
            str_of(fallback, "emotion")
        } else {
            e
        }
    });

    let beat = Beat {
        thought: head(&thought, 80),
        line: head(&line, 40),
        emotion,
        script,
        importance: picked
            .get("importance")
            .and_then(|v| v.as_i64())
            .unwrap_or(30)
            .clamp(0, 100),
        model: model_for(&provider(cfg), cfg),
        elapsed_ms: started.elapsed().as_millis() as u64,
    };

    println!(
        "[Mind] 念头：{}｜{}（{}ms，两段 {midpoint}ms）",
        beat.thought, beat.line, beat.elapsed_ms
    );
    Ok(beat)
}

// ---------- 3. 日记 ----------

/// 她的日记 = event 类记忆按时间倒序。同时也收录 importance 高的
/// 普通记忆（用户手动钉的这种），但只在 kind 上区分不出来时用 source 判断。
pub fn diary(limit: usize) -> Vec<Value> {
    let mut list: Vec<memory::Memory> = memory::all()
        .into_iter()
        .filter(|m| m.kind == "event" && !m.archived)
        .collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    list.truncate(limit.max(1));
    list.iter()
        .map(|m| {
            json!({
                "id": m.id,
                "content": m.content,
                "at": m.created_at,
                "source": m.source,
                "importance": m.confidence,
            })
        })
        .collect()
}

/// 把她这次想的事记下来。importance 够了才写，否则一晚上会攒出几十条废话。
pub fn remember_beat(beat: &Beat) {
    if beat.importance < 70 {
        return;
    }
    let now = chrono::Local::now();
    let key = format!("{} 的心事", now.format("%m-%d %H:%M"));
    let content = if beat.line.is_empty() {
        beat.thought.clone()
    } else {
        format!("{}（心里想：{}）", beat.line, beat.thought)
    };
    memory::upsert(
        "event",
        &key,
        &content,
        "",
        beat.importance,
        "episode",
        &[],
    );
}

// ---------- 命令 ----------

/// 前端定时调用：她现在想干嘛。
#[tauri::command]
pub async fn mind_beat(state_in: Option<Value>) -> Value {
    let cfg = state::load_config();
    match reflect(&cfg, state_in.unwrap_or_else(|| json!({}))).await {
        Ok(beat) => {
            remember_beat(&beat);
            json!({ "ok": true, "beat": beat })
        }
        // 失败要如实返回，但前端不该弹错误：她发呆是正常的
        Err(e) => {
            println!("[Mind] 内心活动跳过：{e}");
            json!({ "ok": false, "error": e })
        }
    }
}

#[tauri::command]
pub fn mind_diary(limit: Option<usize>) -> Vec<Value> {
    diary(limit.unwrap_or(30))
}

/// 探活：设置页的「测试」按钮用它。顺带把延迟报出来 ——
/// 20s 才回一句话的模型，做内心活动会让桌宠看起来像卡住了。
#[tauri::command]
pub async fn mind_ping() -> Value {
    let cfg = state::load_config();
    let p = provider(&cfg);
    let model = model_for(&p, &cfg);
    let (base, inferred) = normalize_base(&p.base_url);
    let guessed = if p.ptype == "ollama" { resolve_wire(&cfg, &base, inferred) } else { inferred };
    let started = Instant::now();
    let probe = complete(&cfg, "只回复两个字：在的", "在吗", Duration::from_secs(15), 0.2, 24, None).await;
    let ms = started.elapsed().as_millis() as u64;
    // 探测后实际用的协议（第一次调用可能已经从 ollama 翻到 openai 了）
    let used = cached_wire(&base).map(|w| w.as_str().to_string());
    let protocol = used.unwrap_or_else(|| guessed.as_str().to_string());
    let switched = guessed == Wire::Ollama && protocol == "openai";
    match probe {
        Ok(text) => json!({
            "ok": true,
            "model": model,
            "baseUrl": p.base_url,
            "protocol": protocol,
            "switched": switched,
            "latencyMs": ms,
            "reply": head(text.trim(), 40),
            "verdict": if ms > 8000 {
                "太慢了，内心活动会看起来像卡住。本地机只驻留一个模型时最容易撞上换模型，建议让心智用一个常驻的小模型"
            } else if ms > 3000 {
                "可用，但不够利索"
            } else {
                "可用"
            },
        }),
        Err(e) => json!({
            "ok": false,
            "model": model,
            "baseUrl": p.base_url,
            "protocol": protocol,
            "switched": switched,
            "latencyMs": ms,
            "error": e,
        }),
    }
}

/// 手动触发一次抽取（管理端的「现在就整理记忆」）。不节流，方便调试。
#[tauri::command]
pub async fn mind_extract_now() -> Value {
    let cfg = state::load_config();
    let turns = state::history_load()
        .iter()
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?.to_string();
            let content = m.get("content")?.as_str()?.to_string();
            Some((role, content))
        })
        .collect::<Vec<_>>();

    match extract_and_store(&cfg, &turns).await {
        Ok(n) => json!({ "ok": true, "added": n }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 心智层是不是在忙（前端据此决定"再等一会儿"而不是连发请求）
#[tauri::command]
pub fn mind_busy() -> bool {
    busy().load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_extraction_survives_fences_and_prose() {
        let a = extract_json("```json\n[{\"a\":1}]\n```").unwrap();
        assert_eq!(a[0]["a"], 1);

        let b = extract_json("好的，这是结果：{\"pick\":2,\"script\":[]} 希望能帮到你").unwrap();
        assert_eq!(b["pick"], 2);

        let c = extract_json("[{\"s\":\"含 ] 和 } 的字符串\"}]").unwrap();
        assert_eq!(c[0]["s"], "含 ] 和 } 的字符串");

        assert!(extract_json("完全没有 JSON").is_none());
    }

    #[test]
    fn unknown_actions_and_emotions_fall_back() {
        assert_eq!(sanitize_action("teleport"), "idle");
        assert_eq!(sanitize_action("WALK"), "walk");
        assert_eq!(sanitize_emotion("furious"), "happy");
        assert_eq!(sanitize_emotion("Shy"), "shy");
    }

    #[test]
    fn normalize_base_hands_out_protocol_and_base() {
        // 用户会把端点整条粘进去，也只填个 host —— 两种都得能用
        assert_eq!(normalize_base("http://x:11434"), ("http://x:11434".into(), Wire::Ollama));
        assert_eq!(normalize_base("http://x:11434/api"), ("http://x:11434".into(), Wire::Ollama));
        assert_eq!(normalize_base("http://x:11434/api/chat"), ("http://x:11434".into(), Wire::Ollama));
        assert_eq!(normalize_base("http://x:52741/v1"), ("http://x:52741".into(), Wire::Openai));
        assert_eq!(
            normalize_base("http://x:52741/v1/chat/completions"),
            ("http://x:52741".into(), Wire::Openai)
        );
        assert_eq!(
            normalize_base("http://x:8000/v1/"),
            ("http://x:8000".into(), Wire::Openai)
        );
        assert_eq!(
            normalize_base("  http://x:8000/openai/v1/chat/completions "),
            ("http://x:8000/openai".into(), Wire::Openai)
        );
        assert_eq!(normalize_base(" https://api.x.com "), ("https://api.x.com".into(), Wire::Ollama));
    }

    #[test]
    fn openai_base_rejoins_v1_so_the_endpoint_is_not_double_prefixed() {
        let (base, wire) = normalize_base("http://x:52741/v1/chat/completions");
        assert_eq!(wire, Wire::Openai);
        // 端点拼接要求 base 不带 /v1，否则会变成 /v1/v1/chat/completions
        let endpoint = if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        };
        assert_eq!(endpoint, "http://x:52741/v1/chat/completions");
    }

    #[test]
    fn manual_protocol_override_beats_guess_but_only_for_the_mind_endpoint() {
        let own = json!({"mindUrl": "http://x:11434", "mindProtocol": "openai"});
        assert_eq!(resolve_wire(&own, "http://x:11434", Wire::Ollama), Wire::Openai);

        let own = json!({"mindUrl": "http://x:52741", "mindProtocol": "ollama"});
        assert_eq!(resolve_wire(&own, "http://x:52741", Wire::Openai), Wire::Ollama);

        // mindUrl 留空 = 复用主 provider：这时心智的协议设置不许插手，
        // 否则用户只想给自建端点指定协议，却把主对话的 ollama 也带偏了。
        let reuse = json!({"mindUrl": "", "mindProtocol": "openai", "ollamaUrl": "http://x:11434"});
        assert_eq!(resolve_wire(&reuse, "http://x:11434", Wire::Ollama), Wire::Ollama);
    }

    #[test]
    fn detected_wire_wins_over_the_guess_once_cached() {
        remember_wire("http://x:9999", Wire::Openai);
        let cfg = json!({"mindUrl": "http://x:9999", "mindProtocol": "auto"});
        // 地址长得像 ollama（没 /v1），但探测已经证明它是 OpenAI 兼容端
        assert_eq!(resolve_wire(&cfg, "http://x:9999", Wire::Ollama), Wire::Openai);
    }

    #[test]
    fn server_side_failures_tell_the_user_what_to_do() {
        // "Compute error" 原样抛给用户等于什么都没说。实测 Metal 后端显存不足后
        // 会卡死在错误态，所有请求 0.02s 秒回 500 —— 重试、改配置都没用。
        let e500 = http_error(500, "{\"error\":{\"message\":\"Compute error.\"}}");
        assert!(e500.contains("重启"), "500 必须指出重启那台机器的服务：{e500}");
        assert!(e500.contains("重试无效"), "必须打消重试的念头：{e500}");
        assert!(e500.contains("Compute error"), "原始信息要保留：{e500}");

        let e503 = http_error(503, "upstream down");
        assert!(e503.contains("稍等再试"), "503 是可以等的：{e503}");

        // 4xx 是用户能自己修的，不该套上"重启服务"这种误导性建议
        let e404 = http_error(404, "File Not Found");
        assert!(!e404.contains("重启"));
        assert!(e404.contains("404"));
    }

    #[test]
    fn extraction_ticks_every_other_turn() {
        // 计数器是全局的，只验证节奏而不是绝对值
        let mut hits = 0;
        for _ in 0..6 {
            if tick_turn() {
                hits += 1;
            }
        }
        assert_eq!(hits, 3);
    }

    /// 真机联调：对着一台跑本地推理的机器跑通两条链路。
    ///
    /// Ollama（/api/chat）：
    ///     ZBOT_MIND_URL=http://192.168.31.249:11434 ZBOT_MIND_MODEL=qwen3:8b \
    ///       cargo test --lib mind_live -- --ignored --nocapture
    ///
    /// OpenAI 兼容（llama.cpp / vLLM / LM Studio）：
    ///     ZBOT_MIND_URL=http://192.168.31.249:52741/v1 ZBOT_MIND_MODEL=local_model \
    ///       cargo test --lib mind_live -- --ignored --nocapture
    ///
    /// 标 ignore 是因为它依赖局域网里那台机器；CI 上跑必然红。
    /// 但它值得留着 —— 提示词改一句就可能让模型不再输出合法 JSON，
    /// 而单测只能验证"解析器能吃下什么样的字符串"，验证不了"模型会不会给"。
    ///
    /// ⚠️ 32GB 的机器上别同时驻留两个大模型：llama.cpp 显存不足时 Metal 后端会
    /// **进入错误态且不自愈**，之后每个请求 0.02s 秒回 500 "Compute error"，
    /// 只能重启那个服务。跑这个测试前先确认 ollama 里没有几十 GB 的模型在驻留。
    #[tokio::test]
    #[ignore = "需要局域网内跑着 ollama 的机器"]
    async fn mind_live_extract_and_reflect() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-live-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        let _ = std::fs::remove_dir_all(&dir);
        crate::store::invalidate(&memory::memory_file());
        memory::init();

        let url = std::env::var("ZBOT_MIND_URL").expect("需要 ZBOT_MIND_URL");
        let model = std::env::var("ZBOT_MIND_MODEL").unwrap_or_else(|_| "qwen3:8b".into());
        let cfg = json!({
            "mindEnabled": true,
            "autoExtractMemory": true,
            "mindUrl": url,
            "mindModel": model,
            "petName": "茉白",
        });

        // ---- 抽取 ----
        let turns = vec![
            ("user".to_string(), "我们公司这周四要述职，我负责讲增长那块，PPT 还差三页".to_string()),
            ("assistant".to_string(), "增长那块你打算讲哪几个指标？".to_string()),
            ("user".to_string(), "DAU 和留存吧。对了以后开会都别给我排早上九点，我起不来".to_string()),
        ];
        let n = extract_and_store(&cfg, &turns).await.expect("抽取失败");
        let got = memory::all();
        println!("抽出 {n} 条：");
        for m in &got {
            println!("  [{}] {} = {}", m.kind, m.key, m.content);
        }
        assert!(!got.is_empty(), "一条记忆都没抽出来");

        // ---- 内心活动 ----
        let beat = reflect(
            &cfg,
            json!({ "idleMinutes": 42, "affection": 65, "focusToday": 75, "mode": "normal", "energy": 45 }),
        )
        .await
        .expect("内心活动失败");
        println!(
            "念头：{}｜台词：{}｜情绪：{}｜脚本：{:?}｜重要度：{}｜{}ms",
            beat.thought, beat.line, beat.emotion, beat.script, beat.importance, beat.elapsed_ms
        );
        assert!(!beat.script.is_empty());
        assert!(ACTIONS.contains(&beat.script[0].anim.as_str()));

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn low_importance_beats_are_not_written_to_diary() {
        let _g = crate::lock_test_env();
        let dir = std::env::temp_dir().join(format!("z-bot-mind-{}", uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        crate::store::invalidate(&memory::memory_file());
        let _ = std::fs::remove_dir_all(&dir);
        memory::init();

        let quiet = Beat {
            thought: "他好像有点累".into(),
            line: String::new(),
            emotion: "neutral".into(),
            script: vec![],
            importance: 30,
            model: "test".into(),
            elapsed_ms: 0,
        };
        remember_beat(&quiet);
        assert!(diary(10).is_empty(), "小事不写日记");

        let big = Beat { importance: 85, ..quiet };
        remember_beat(&big);
        assert_eq!(diary(10).len(), 1, "重要的事要留下来");

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

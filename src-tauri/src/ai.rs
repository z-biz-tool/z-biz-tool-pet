//! AI 通道：对照 src/main/ai-providers.ts（T4.1 提供商抽象 + T4.3 流式）。
//!
//! 6 家内置提供商、请求体形状、错误文案都按 Electron 版原样搬，因为模型侧的
//! 容错（同一个 prompt 在 ollama/openai/claude/gemini 上的差异）是当年一项项试出来的。
//! 与 Electron 的差别只有两处，都是"照搬会掉洞里"的：
//! - 非流式聊天加了 15s 连接超时（Electron 一个 fetch 超时都没有，上游挂了 invoke 就永远悬着）。
//! - 流式解码按完整 UTF-8 边界切，中文跨 chunk 不再出现半个字。

use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub ptype: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_streaming: bool,
    #[serde(default)]
    pub supports_tools: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<Value>>,
}

fn provider(
    id: &str,
    name: &str,
    ptype: &str,
    base_url: &str,
    api_key: &str,
    models: &[&str],
    vision: bool,
) -> Provider {
    Provider {
        id: id.into(),
        name: name.into(),
        ptype: ptype.into(),
        base_url: base_url.into(),
        api_key: api_key.into(),
        models: models.iter().map(|m| m.to_string()).collect(),
        supports_vision: vision,
        supports_streaming: true,
        supports_tools: true,
    }
}

/// 内置模板：顺序与 ai-providers.ts:29-95 一致，UI 拿第一个（ollama）当不可删除的默认项
pub fn builtin_providers() -> Vec<Provider> {
    vec![
        provider("ollama", "Ollama (本地)", "ollama", "http://localhost:11434", "", &["qwen2.5:7b-instruct-q4_K_M", "llama3.2-vision", "gemma2:9b"], true),
        provider("openai", "OpenAI", "openai", "https://api.openai.com", "", &["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"], true),
        provider("deepseek", "DeepSeek", "deepseek", "https://api.deepseek.com", "", &["deepseek-chat", "deepseek-reasoner"], false),
        provider("qwen", "通义千问", "qwen", "https://dashscope.aliyuncs.com/compatible-mode", "", &["qwen-plus", "qwen-turbo", "qwen-vl-plus"], true),
        provider("claude", "Claude", "claude", "https://api.anthropic.com", "", &["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"], true),
        provider("gemini", "Gemini", "gemini", "https://generativelanguage.googleapis.com", "", &["gemini-2.0-flash", "gemini-1.5-pro"], true),
    ]
}

fn find_builtin(id: &str) -> Option<Provider> {
    builtin_providers().into_iter().find(|p| p.id == id)
}

/// 三级解析：providers 列表 → 内置模板（旧配置）→ 回落 ollama。
/// 注意回落分支只认 ollamaUrl/modelName，Electron 就是这样（aiBaseUrl/aiApiKey 被丢掉）。
pub fn provider_from_config(cfg: &Value) -> Provider {
    let ai_provider = cfg.get("aiProvider").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(list) = cfg.get("providers").and_then(|v| v.as_array()) {
        for raw in list {
            if let Ok(p) = serde_json::from_value::<Provider>(raw.clone()) {
                if p.id == ai_provider {
                    return p;
                }
            }
        }
    }
    let field = |key: &str| -> String {
        cfg.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    if let Some(builtin) = find_builtin(ai_provider) {
        let base_url = or_default(field("aiBaseUrl"), builtin.base_url.clone());
        let api_key = or_default(field("aiApiKey"), builtin.api_key.clone());
        let mut models = builtin.models.clone();
        let ai_model = field("aiModel");
        if !ai_model.is_empty() {
            models.insert(0, ai_model);
        }
        return Provider { base_url, api_key, models, ..builtin };
    }
    let ollama = find_builtin("ollama").expect("内置提供商表不可为空");
    let mut fallback = ollama;
    fallback.base_url = or_default(field("ollamaUrl"), fallback.base_url.clone());
    let model = or_default(field("modelName"), fallback.models[0].clone());
    fallback.models = vec![model];
    fallback.api_key = String::new();
    fallback
}

fn or_default(value: String, def: String) -> String {
    if value.is_empty() { def } else { value }
}

/// 模型三级优先：request.model → config.aiModel → config.modelName（ai-router.ts:261）
pub fn resolve_model(request_model: &str, cfg: &Value, provider: &Provider) -> String {
    if !request_model.is_empty() {
        return request_model.to_string();
    }
    for key in ["aiModel", "modelName"] {
        let v = cfg.get(key).and_then(|x| x.as_str()).unwrap_or("");
        if !v.is_empty() {
            return v.to_string();
        }
    }
    provider.models.first().cloned().unwrap_or_default()
}

const ANTHROPIC_VERSION: &str = "2023-06-01";

fn is_openai_compatible(ptype: &str) -> bool {
    matches!(ptype, "openai" | "deepseek" | "qwen" | "custom")
}

/// 流式路径下 claude/gemini 不收 tool_use（Electron 也没收），所以带工具的回合不能流式
pub fn can_stream_tools(ptype: &str) -> bool {
    matches!(ptype, "ollama" | "openai" | "deepseek" | "qwen" | "custom")
}

fn client(total: Option<Duration>) -> reqwest::Client {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15));
    if let Some(t) = total {
        b = b.timeout(t);
    }
    b.build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn body_error(label: &str, resp: reqwest::Response) -> String {
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    format!("{label} 请求失败 ({status}): {text}")
}

// ---------- 各家的消息形状 ----------

fn ollama_messages(req: &ChatRequest) -> Vec<Value> {
    req.messages
        .iter()
        .map(|m| match m.images.as_deref() {
            Some(imgs) if !imgs.is_empty() => json!({ "role": m.role, "content": m.content, "images": imgs }),
            _ => json!({ "role": m.role, "content": m.content }),
        })
        .collect()
}

fn openai_messages(req: &ChatRequest) -> Vec<Value> {
    req.messages
        .iter()
        .map(|m| match m.images.as_deref() {
            Some(imgs) if !imgs.is_empty() => {
                let mut parts = vec![json!({ "type": "text", "text": m.content })];
                for img in imgs {
                    let url = if img.starts_with("data:") {
                        img.clone()
                    } else {
                        format!("data:image/jpeg;base64,{img}")
                    };
                    parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
                json!({ "role": m.role, "content": parts })
            }
            _ => json!({ "role": m.role, "content": m.content }),
        })
        .collect()
}

fn first_system(req: &ChatRequest) -> Option<&Message> {
    req.messages.iter().find(|m| m.role == "system")
}

fn claude_messages(req: &ChatRequest) -> Vec<Value> {
    req.messages
        .iter()
        .filter(|m| !(m.role == "system"))
        .map(|m| {
            let role = if m.role == "assistant" { "assistant" } else { "user" };
            let content = match m.images.as_deref() {
                Some(imgs) if !imgs.is_empty() => {
                    let mut parts = vec![json!({ "type": "text", "text": m.content })];
                    for img in imgs {
                        let data = img.split(',').next_back().unwrap_or(img);
                        parts.push(json!({
                            "type": "image",
                            "source": { "type": "base64", "media_type": "image/jpeg", "data": data }
                        }));
                    }
                    Value::Array(parts)
                }
                _ => json!(m.content),
            };
            json!({ "role": role, "content": content })
        })
        .collect()
}

fn gemini_contents(req: &ChatRequest) -> Vec<Value> {
    req.messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            let mut parts = vec![json!({ "text": m.content })];
            for img in m.images.as_deref().unwrap_or_default() {
                let data = img.split(',').next_back().unwrap_or(img);
                parts.push(json!({
                    "inline_data": { "mime_type": "image/jpeg", "data": data }
                }));
            }
            json!({ "role": role, "parts": parts })
        })
        .collect()
}

/// claude/gemini 把 OpenAI 形状的工具声明换成自己那套，输入形状也各自不同
fn claude_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let f = t.get("function").unwrap_or(t);
            json!({
                "name": f.get("name").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or(Value::Null),
                "input_schema": f.get("parameters").cloned().unwrap_or(Value::Null)
            })
        })
        .collect()
}

fn gemini_tools(tools: &[Value]) -> Vec<Value> {
    let declarations: Vec<Value> = tools
        .iter()
        .map(|t| {
            let f = t.get("function").unwrap_or(t);
            json!({
                "name": f.get("name").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or(Value::Null),
                "parameters": f.get("parameters").cloned().unwrap_or(Value::Null)
            })
        })
        .collect();
    vec![json!({ "functionDeclarations": declarations })]
}

fn has_tools(req: &ChatRequest) -> bool {
    req.tools.as_deref().map(|t| !t.is_empty()).unwrap_or(false)
}

fn openai_tool_calls(value: Option<&Value>) -> Option<Vec<Value>> {
    value
        .filter(|v| v.is_array())
        .map(|v| v.as_array().cloned().unwrap_or_default())
}

/// claude 的 tool_use 块换回 OpenAI 形状，否则工具执行层要认两套结构
fn claude_tool_blocks(data: &Value) -> Option<Vec<Value>> {
    let blocks = data.get("content")?.as_array()?;
    let calls: Vec<Value> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .map(|b| {
            json!({
                "id": b.get("id").cloned().unwrap_or(Value::Null),
                "type": "function",
                "function": {
                    "name": b.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": b.get("input").map(|i| i.to_string()).unwrap_or_default()
                }
            })
        })
        .collect();
    if calls.is_empty() {
        None
    } else {
        Some(calls)
    }
}

fn gemini_function_calls(data: &Value) -> Option<Vec<Value>> {
    let parts = data
        .get("candidates")?
        .get(0)?
        .get("content")?
        .get("parts")?
        .as_array()?
        .clone();
    let calls: Vec<Value> = parts
        .iter()
        .filter_map(|p| p.get("functionCall"))
        .map(|fc| {
            json!({
                "type": "function",
                "function": {
                    "name": fc.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": fc.get("args").map(|a| a.to_string()).unwrap_or_default()
                }
            })
        })
        .collect();
    if calls.is_empty() {
        None
    } else {
        Some(calls)
    }
}

// ---------- 非流式 ----------

pub async fn chat(provider: &Provider, request: &ChatRequest) -> Result<ChatResponse, String> {
    let http = client(None);
    match provider.ptype.as_str() {
        "ollama" => {
            let mut body = json!({ "model": request.model, "messages": ollama_messages(request), "stream": false });
            if has_tools(request) {
                body["tools"] = json!(request.tools);
            }
            let resp = http
                .post(format!("{}/api/chat", provider.base_url))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("Ollama", resp).await);
            }
            let data: Value = resp.json().await.map_err(|e| e.to_string())?;
            Ok(ChatResponse {
                content: data
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                tool_calls: openai_tool_calls(data.get("message").and_then(|m| m.get("tool_calls"))),
            })
        }
        t if is_openai_compatible(t) => {
            let mut body = json!({ "model": request.model, "messages": openai_messages(request), "stream": false });
            if has_tools(request) {
                body["tools"] = json!(request.tools);
            }
            let mut req = http
                .post(format!("{}/v1/chat/completions", provider.base_url))
                .header("Content-Type", "application/json");
            if !provider.api_key.is_empty() {
                req = req.bearer_auth(&provider.api_key);
            }
            let resp = req.json(&body).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("OpenAI兼容", resp).await);
            }
            let data: Value = resp.json().await.map_err(|e| e.to_string())?;
            let choice = data.get("choices").and_then(|c| c.get(0));
            let message = choice.and_then(|c| c.get("message"));
            Ok(ChatResponse {
                content: message
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                tool_calls: openai_tool_calls(message.and_then(|m| m.get("tool_calls"))),
            })
        }
        "claude" => {
            let mut body = json!({ "model": request.model, "max_tokens": 4096, "messages": claude_messages(request) });
            if let Some(sys) = first_system(request) {
                body["system"] = json!(sys.content);
            }
            if has_tools(request) {
                body["tools"] = json!(claude_tools(request.tools.as_deref().unwrap_or_default()));
            }
            let resp = http
                .post(format!("{}/v1/messages", provider.base_url))
                .header("Content-Type", "application/json")
                .header("x-api-key", &provider.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("anthropic-dangerous-direct-browser-access", "true")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("Claude", resp).await);
            }
            let data: Value = resp.json().await.map_err(|e| e.to_string())?;
            let text = data
                .get("content")
                .and_then(|c| c.as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .map(|b| b.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            Ok(ChatResponse { content: text, tool_calls: claude_tool_blocks(&data) })
        }
        "gemini" => {
            let mut body = json!({ "contents": gemini_contents(request) });
            if let Some(sys) = first_system(request) {
                body["systemInstruction"] = json!({ "parts": [{ "text": sys.content }] });
            }
            if has_tools(request) {
                body["tools"] = json!(gemini_tools(request.tools.as_deref().unwrap_or_default()));
            }
            let url = format!(
                "{}/v1beta/models/{}:generateContent?key={}",
                provider.base_url, request.model, provider.api_key
            );
            let resp = http
                .post(url)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("Gemini", resp).await);
            }
            let data: Value = resp.json().await.map_err(|e| e.to_string())?;
            let parts = data
                .get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            let text = parts
                .iter()
                .map(|p| p.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string())
                .collect::<Vec<_>>()
                .join("");
            Ok(ChatResponse { content: text, tool_calls: gemini_function_calls(&data) })
        }
        other => Err(format!("不支持的提供商类型: {other}")),
    }
}

// ---------- 流式 ----------

/// 只处理"完整行"，末尾半行留在 pending 里等下一个 chunk（对齐 Electron 的行缓冲）
fn drain_lines(pending: &mut String, text: &str) -> Vec<String> {
    pending.push_str(text);
    let ended_with_newline = pending.ends_with('\n');
    let mut lines: Vec<String> = pending.split('\n').map(|l| l.to_string()).filter(|l| !l.trim().is_empty()).collect();
    pending.clear();
    if !ended_with_newline {
        if let Some(last) = lines.pop() {
            pending.push_str(&last);
        }
    }
    lines
}

/// chunk 边界可能切在 UTF-8 序列中间，直接 lossy 会把中文变成问号
fn decode_streamed(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(_) => String::from_utf8(std::mem::take(buf)).unwrap_or_default(),
        Err(e) => {
            let valid = e.valid_up_to();
            let incomplete_only = e.error_len().is_none();
            if !incomplete_only || valid == 0 {
                let out = String::from_utf8_lossy(buf).to_string();
                buf.clear();
                out
            } else {
                let out = String::from_utf8_lossy(&buf[..valid]).to_string();
                buf.drain(..valid);
                out
            }
        }
    }
}

fn sse_payload(content: &str, done: bool) -> Value {
    json!({ "content": content, "done": done })
}

async fn stream_lines(
    resp: reqwest::Response,
    label: &str,
    mut on_line: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut stream = resp.bytes_stream();
    let mut raw: Vec<u8> = vec![];
    let mut pending = String::new();
    let mut got_any = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{label} 流式请求失败: {e}"))?;
        got_any = true;
        raw.extend_from_slice(&chunk);
        for line in drain_lines(&mut pending, &decode_streamed(&mut raw)) {
            on_line(&line)?;
        }
    }
    if !got_any {
        return Err(format!("{label} 流式响应无 body"));
    }
    Ok(())
}

/// `emit` 收到 `{ content, done }`，对应 Electron 的 ai:streamChunk
pub async fn stream_chat(
    provider: &Provider,
    request: &ChatRequest,
    // Tauri 把 async command 的 future spawn 到 tokio 上（要求 Send），
    // 所以投递器必须显式带上 Send；WebviewWindow 本身是 Send+Sync，闭包捕获它没问题。
    emit: &mut (dyn FnMut(Value) + Send),
) -> Result<ChatResponse, String> {
    let mut request = request.clone();
    request.stream = Some(true);
    let http = client(None);
    match provider.ptype.as_str() {
        "ollama" => {
            let body = json!({ "model": request.model, "messages": ollama_messages(&request), "stream": true });
            let req = http
                .post(format!("{}/api/chat", provider.base_url))
                .header("Content-Type", "application/json")
                .json(&body);
            let resp = req.send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("Ollama 流式", resp).await);
            }
            let mut full = String::new();
            let mut tool_calls: Option<Vec<Value>> = None;
            let mut err: Option<String> = None;
            let mut on_line = |line: &str| -> Result<(), String> {
                let Ok(data) = serde_json::from_str::<Value>(line) else { return Ok(()) };
                let message = data.get("message");
                if let Some(c) = message.and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                    if !c.is_empty() {
                        full.push_str(c);
                        emit(sse_payload(c, false));
                    }
                }
                if let Some(calls) = message.and_then(|m| m.get("tool_calls")).and_then(|c| c.as_array()) {
                    if !calls.is_empty() {
                        tool_calls = Some(calls.clone());
                    }
                }
                if data.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                    emit(sse_payload("", true));
                }
                Ok(())
            };
            if let Err(e) = stream_lines(resp, "Ollama", &mut on_line).await {
                err = Some(e);
            }
            drop(on_line);
            match err {
                Some(e) => Err(e),
                None => Ok(ChatResponse { content: full, tool_calls }),
            }
        }
        t if is_openai_compatible(t) => {
            let body = json!({ "model": request.model, "messages": openai_messages(&request), "stream": true });
            let mut builder = http
                .post(format!("{}/v1/chat/completions", provider.base_url))
                .header("Content-Type", "application/json");
            if !provider.api_key.is_empty() {
                builder = builder.bearer_auth(&provider.api_key);
            }
            let resp = builder.json(&body).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("OpenAI兼容 流式", resp).await);
            }
            let mut full = String::new();
            // OpenAI 把 tool_calls 按 index 分片下发，必须聚合才能还原完整参数
            let mut partial: Vec<Option<Value>> = vec![];
            let mut err: Option<String> = None;
            let mut on_line = |line: &str| -> Result<(), String> {
                let trimmed = line.trim();
                let Some(rest) = trimmed.strip_prefix("data:") else { return Ok(()) };
                let data_str = rest.trim();
                if data_str == "[DONE]" {
                    emit(sse_payload("", true));
                    return Ok(());
                }
                let Ok(data) = serde_json::from_str::<Value>(data_str) else { return Ok(()) };
                let choice = data.get("choices").and_then(|c| c.get(0));
                let delta = choice.and_then(|c| c.get("delta"));
                if let Some(text) = delta.and_then(|d| d.get("content")).and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        full.push_str(text);
                        emit(sse_payload(text, false));
                    }
                }
                if let Some(deltas) = delta.and_then(|d| d.get("tool_calls")).and_then(|t| t.as_array()) {
                    for t in deltas {
                        let i = t.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                        partial.resize(i + 1, None);
                        let mut slot = partial[i]
                            .clone()
                            .unwrap_or_else(|| json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
                        if let Some(id) = t.get("id").and_then(|x| x.as_str()) {
                            slot["id"] = json!(id);
                        }
                        let f = t.get("function");
                        if let Some(name) = f.and_then(|f| f.get("name")).and_then(|n| n.as_str()) {
                            let acc = slot["function"]["name"].as_str().unwrap_or("").to_string();
                            slot["function"]["name"] = json!(acc + name);
                        }
                        if let Some(args) = f.and_then(|f| f.get("arguments")).and_then(|a| a.as_str()) {
                            let acc = slot["function"]["arguments"].as_str().unwrap_or("").to_string();
                            slot["function"]["arguments"] = json!(acc + args);
                        }
                        partial[i] = Some(slot);
                    }
                }
                Ok(())
            };
            if let Err(e) = stream_lines(resp, "OpenAI兼容 流式", &mut on_line).await {
                err = Some(e);
            }
            drop(on_line);
            match err {
                Some(e) => Err(e),
                None => {
                    let calls: Vec<Value> = partial.into_iter().flatten().collect();
                    Ok(ChatResponse {
                        content: full,
                        tool_calls: if calls.is_empty() { None } else { Some(calls) },
                    })
                }
            }
        }
        "claude" => {
            let mut body = json!({ "model": request.model, "max_tokens": 4096, "messages": claude_messages(&request), "stream": true });
            if let Some(sys) = first_system(&request) {
                body["system"] = json!(sys.content);
            }
            let resp = http
                .post(format!("{}/v1/messages", provider.base_url))
                .header("Content-Type", "application/json")
                .header("x-api-key", &provider.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("anthropic-dangerous-direct-browser-access", "true")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("Claude 流式", resp).await);
            }
            let mut full = String::new();
            let mut err: Option<String> = None;
            let mut on_line = |line: &str| -> Result<(), String> {
                let trimmed = line.trim();
                let Some(rest) = trimmed.strip_prefix("data:") else { return Ok(()) };
                let data_str = rest.trim();
                if data_str == "[DONE]" || data_str.is_empty() {
                    return Ok(());
                }
                let Ok(data) = serde_json::from_str::<Value>(data_str) else { return Ok(()) };
                if data.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                    if let Some(text) = data.get("delta").and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        full.push_str(text);
                        emit(sse_payload(text, false));
                    }
                } else if data.get("type").and_then(|t| t.as_str()) == Some("message_stop") {
                    emit(sse_payload("", true));
                }
                Ok(())
            };
            if let Err(e) = stream_lines(resp, "Claude 流式", &mut on_line).await {
                err = Some(e);
            }
            drop(on_line);
            match err {
                Some(e) => Err(e),
                None => Ok(ChatResponse { content: full, tool_calls: None }),
            }
        }
        "gemini" => {
            let mut body = json!({ "contents": gemini_contents(&request) });
            if let Some(sys) = first_system(&request) {
                body["systemInstruction"] = json!({ "parts": [{ "text": sys.content }] });
            }
            let url = format!(
                "{}/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
                provider.base_url, request.model, provider.api_key
            );
            let resp = http
                .post(url)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(body_error("Gemini 流式", resp).await);
            }
            let mut full = String::new();
            let mut err: Option<String> = None;
            let mut on_line = |line: &str| -> Result<(), String> {
                let trimmed = line.trim();
                let Some(rest) = trimmed.strip_prefix("data:") else { return Ok(()) };
                let Ok(data) = serde_json::from_str::<Value>(rest.trim()) else { return Ok(()) };
                let parts = data
                    .get("candidates")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("content"))
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                    .cloned()
                    .unwrap_or_default();
                for p in parts {
                    if let Some(text) = p.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            full.push_str(text);
                            emit(sse_payload(text, false));
                        }
                    }
                }
                Ok(())
            };
            if let Err(e) = stream_lines(resp, "Gemini 流式", &mut on_line).await {
                err = Some(e);
            }
            drop(on_line);
            match err {
                // gemini 不发 done 帧，收尾由这里补
                Some(e) => Err(e),
                None => {
                    emit(sse_payload("", true));
                    Ok(ChatResponse { content: full, tool_calls: None })
                }
            }
        }
        other => Err(format!("不支持的流式提供商类型: {other}")),
    }
}

// ---------- 连接测试与模型列表 ----------

pub async fn test_connection(provider: &Provider) -> Value {
    let probe = |timeout_secs: u64| client(Some(Duration::from_secs(timeout_secs)));
    let result: Result<bool, String> = match provider.ptype.as_str() {
        "ollama" => {
            let resp = probe(5).get(format!("{}/api/tags", provider.base_url)).send().await;
            resp.map(|r| r.status().is_success()).map_err(|e| e.to_string())
        }
        t if is_openai_compatible(t) => {
            let mut req = probe(5)
                .get(format!("{}/v1/models", provider.base_url))
                .header("Content-Type", "application/json");
            if !provider.api_key.is_empty() {
                req = req.bearer_auth(&provider.api_key);
            }
            req.send().await.map(|r| r.status().is_success()).map_err(|e| e.to_string())
        }
        "claude" => {
            // 模型名不对也说明连得上，所以 5xx 才算失败（Electron 同款判断）
            let model = provider.models.first().cloned().unwrap_or_else(|| "claude-3-5-haiku-20241022".to_string());
            let body = json!({ "model": model, "max_tokens": 1, "messages": [{ "role": "user", "content": "hi" }] });
            let resp = probe(10)
                .post(format!("{}/v1/messages", provider.base_url))
                .header("Content-Type", "application/json")
                .header("x-api-key", &provider.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("anthropic-dangerous-direct-browser-access", "true")
                .json(&body)
                .send()
                .await;
            resp.map(|r| (r.status().as_u16()) < 500).map_err(|e| e.to_string())
        }
        "gemini" => {
            let url = format!("{}/v1beta/models?key={}", provider.base_url, provider.api_key);
            probe(5).get(url).send().await.map(|r| r.status().is_success()).map_err(|e| e.to_string())
        }
        other => Err(format!("不支持的提供商类型: {other}")),
    };
    match result {
        Ok(true) => json!({ "success": true }),
        Ok(false) => json!({ "success": false, "error": "HTTP 请求未通过" }),
        Err(e) => json!({ "success": false, "error": if e.is_empty() { "连接超时".to_string() } else { e } }),
    }
}

/// 拉取失败一律回落到提供商自带的模型列表，绝不返回空数组（空列表会让设置页没法保存）
pub async fn get_models(provider: &Provider) -> Vec<String> {
    let fallback = provider.models.clone();
    let http = client(Some(Duration::from_secs(5)));
    let fetched: Option<Vec<String>> = match provider.ptype.as_str() {
        "ollama" => get_json(http.get(format!("{}/api/tags", provider.base_url)))
            .await
            .map(|data| names_from(&data, "models", &["name", "model"], None)),
        t if is_openai_compatible(t) => {
            let mut req = http.get(format!("{}/v1/models", provider.base_url));
            if !provider.api_key.is_empty() {
                req = req.bearer_auth(&provider.api_key);
            }
            get_json(req).await.map(|data| names_from(&data, "data", &["id"], None))
        }
        // Claude 没有公开的模型列表 API
        "claude" => Some(fallback.clone()),
        "gemini" => get_json(http.get(format!("{}/v1beta/models?key={}", provider.base_url, provider.api_key)))
            .await
            .map(|data| names_from(&data, "models", &["name"], Some(&"models/"))),
        _ => None,
    };
    match fetched {
        Some(list) if !list.is_empty() => list,
        _ => fallback,
    }
}

async fn get_json(req: reqwest::RequestBuilder) -> Option<Value> {
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()
}

/// 只取 name_keys 里的第一个字符串字段；prefix 用于剥掉 gemini 的 `models/` 前缀，
/// contains 是 gemini 的额外过滤（只要名字里带 gemini 的）
fn names_from(data: &Value, key: &str, name_keys: &[&str], prefix: Option<&str>) -> Vec<String> {
    let list = match data.get(key).and_then(|v| v.as_array()) {
        Some(l) => l,
        None => return vec![],
    };
    let mut out: Vec<String> = list
        .iter()
        .filter_map(|m| {
            name_keys
                .iter()
                .find_map(|k| m.get(*k).and_then(|v| v.as_str()))
                .map(|s| s.strip_prefix(prefix.unwrap_or("")).unwrap_or(s).to_string())
        })
        .collect();
    if prefix.is_some() {
        out.retain(|n| n.contains("gemini"));
    }
    out
}

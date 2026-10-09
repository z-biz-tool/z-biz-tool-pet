//! AI 路由与工具编排：对照 src/main/ai-router.ts（T3.1，04 §3.3/§3.4，修 D08/D09）。
//!
//! 这一层是"AI 能驱动工具"之后的总闸，顺序不能调：
//! 高危命令特征 → 单轮封顶 → 频率窗口/熔断 → 用户确认 → 执行 → 记账。
//! 流式与非流式共用同一个 run_tool_calls，两条路径的安全逻辑不分叉（当年就是分叉出的洞）。
//!
//! 确认走 toolCallId 契约：主进程把 tools:confirmRequest 广播给所有窗口，
//! 谁先答谁算（渲染端两个窗口都有对话框，Electron 也是这个语义）；60 秒无人应答按拒绝。
//!
//! 与 Electron 的有意差异两处，都写在代码注释里：
//! - tool_calls 的 arguments 解析失败时不再让整个聊天 reject，而是当成空参数交给工具自己报错。
//! - 管理端窗口在 Tauri 里是声明式的（tauri.conf.json 两个窗口都在），
//!   "没建过窗口"因此改成"没显示"，只补一次 show，不重建。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;

use crate::{actions, ai, limiter, memory, security, state, tools};

const PET: &str = "pet";
const ADMIN: &str = "admin";
const CONFIRM_TIMEOUT: Duration = Duration::from_millis(60_000);

// ---------- 会话内白名单与未决确认 ----------

/// "总是允许"名单只对 SENSITIVE 开放。用 Vec 而不是 HashSet：JS 的 Set 迭代是插入序，
/// tools:alwaysAllowed 直接把这个列表显示给用户，顺序不该每次刷新都不一样。
fn always_allowed() -> &'static Mutex<Vec<String>> {
    static SET: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

fn is_always_allowed(name: &str) -> bool {
    always_allowed().lock().expect("白名单被污染").iter().any(|n| n == name)
}

fn add_always_allowed(name: &str) {
    let mut list = always_allowed().lock().expect("白名单被污染");
    if !list.iter().any(|n| n == name) {
        list.push(name.to_string());
    }
}

fn revoke_always_allowed(name: &str) -> Vec<String> {
    let mut list = always_allowed().lock().expect("白名单被污染");
    list.retain(|n| n != name);
    list.clone()
}

fn list_always_allowed() -> Vec<String> {
    always_allowed().lock().expect("白名单被污染").clone()
}

type Decision = (bool, bool); // (approved, alwaysAllow)

fn pending() -> &'static Mutex<std::collections::HashMap<String, oneshot::Sender<Decision>>> {
    static P: OnceLock<Mutex<std::collections::HashMap<String, oneshot::Sender<Decision>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// 结算一个未决确认：只有第一个应答者有效，重复应答（弹窗 + 超时）会被丢弃。
fn settle(tool_call_id: &str, decision: Decision) -> bool {
    if let Some(tx) = pending().lock().expect("确认表被污染").remove(tool_call_id) {
        return tx.send(decision).is_ok();
    }
    false
}

/// DANGEROUS 每次必确认，不接受"总是允许"
pub fn needs_confirmation(name: &str) -> bool {
    if security::risk_level(name) == security::ToolRisk::Dangerous {
        return true;
    }
    if is_always_allowed(name) {
        return false;
    }
    tools::tool_requires_confirmation(name)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 归一化各提供商的 tool_call 形状：ollama 的 arguments 是对象、openai/claude/gemini 经
/// ai.rs 统一成了 `{id, function:{name, arguments: string}}`，但流式 ollama 直接透传原始形状。
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

pub fn normalize_tool_call(raw: &Value) -> ToolCall {
    let id = raw
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("call_{}", now_ms()));
    let func = raw.get("function");
    let name = func
        .and_then(|f| f.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("name").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    // Electron 在这里 JSON.parse，坏参数会把整轮聊天打成"AI请求失败"；
    // 参数是模型生成的，出错是常态，不该连带丢掉已经回完的正文。
    let arguments = match func.and_then(|f| f.get("arguments")) {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).unwrap_or_else(|e| {
            eprintln!("[Z-Bot Main] 工具参数不是合法 JSON，按空参数处理: {e}");
            json!({})
        }),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    };
    ToolCall { id, name, arguments }
}

/// 广播确认请求并等待用户应答；超时按拒绝。
async fn request_confirmation(
    app: &AppHandle,
    call: &ToolCall,
    description_override: Option<&str>,
) -> Decision {
    let described = security::describe_tool_call(&call.name, &call.arguments);
    let description = match description_override {
        Some(prefix) => format!("{prefix}\n{described}"),
        None => described,
    };
    let payload = json!({
        "toolCallId": call.id,
        "name": call.name,
        "arguments": call.arguments,
        "riskLevel": security::risk_level(&call.name) as i32,
        "description": description,
        "timeout": CONFIRM_TIMEOUT.as_millis() as u64,
        "allowAlways": security::allow_always_on_approval(&call.name),
    });

    let (tx, rx) = oneshot::channel();
    pending().lock().expect("确认表被污染").insert(call.id.clone(), tx);

    // 超时后弹窗并不撤销（Electron 也没撤），用户之后点的应答会因为条目已删而被丢掉
    let timed_out = call.id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CONFIRM_TIMEOUT).await;
        if settle(&timed_out, (false, false)) {
            eprintln!("[Z-Bot Main] 工具确认超时，按拒绝处理");
        }
    });

    if let Err(e) = app.emit("tools:confirmRequest", &payload) {
        eprintln!("[Z-Bot] 确认请求广播失败: {e}");
    }
    if let Some(w) = app.get_webview_window(ADMIN) {
        if !w.is_visible().unwrap_or(false) {
            actions::show_admin(app);
        }
    }

    match rx.await {
        Ok(decision) => decision,
        // sender 被丢弃只可能是进程关闭，按拒绝处理
        Err(_) => (false, false),
    }
}

// ---------- 工具执行主循环 ----------

fn push_error(results: &mut Vec<tools::ToolResult>, id: String, reason: String) {
    results.push(tools::ToolResult::err(&id, reason));
}

/// control_pet 的副作用：动画发给两个窗口，颜色额外发一份皮肤数据（Electron 同两条）。
fn apply_pet_side_effects(app: &AppHandle, call: &ToolCall) {
    let action = call.arguments.get("action").cloned().unwrap_or(Value::Null);
    for label in [PET, ADMIN] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.emit("pet:triggerAnimation", &action);
        }
    }
    if let Some(color) = call.arguments.get("color").and_then(|v| v.as_str()) {
        if let Some(w) = app.get_webview_window(PET) {
            let _ = w.emit(
                "pet:applySkinData",
                &json!({
                    "id": "ai-theme",
                    "name": "AI主题",
                    "colors": {
                        "body": color,
                        "bodyLight": color,
                        "bodyDark": color,
                        "eye": "#fff",
                        "blush": "rgba(255,105,180,0.5)",
                        "accent": color,
                    },
                    "isCustom": true,
                }),
            );
        }
    }
}

pub async fn run_tool_calls(
    app: &AppHandle,
    provider: &ai::Provider,
    original: &[ai::Message],
    model: &str,
    response: &ai::ChatResponse,
    mut emit: Option<&mut (dyn FnMut(Value) + Send)>,
) -> Result<(Vec<tools::ToolResult>, ai::ChatResponse), String> {
    let mut results: Vec<tools::ToolResult> = Vec::new();
    let mut executed = 0usize;

    for raw in response.tool_calls.clone().unwrap_or_default() {
        let call = normalize_tool_call(&raw);

        // 高危命令在进入确认前直接拒绝（04 §3.3 FORBIDDEN），连弹窗都不弹
        if call.name == "execute_command" {
            let command = call.arguments.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let guard = security::guard_command(command);
            if !guard.allowed {
                push_error(
                    &mut results,
                    call.id,
                    format!("操作被安全策略拒绝: {}", guard.reason.unwrap_or_default()),
                );
                continue;
            }
        }

        // 限流/熔断在确认弹窗之前判定，避免无谓打扰用户（02 §2.9）
        if executed >= limiter::MAX_TOOL_CALLS_PER_TURN {
            push_error(
                &mut results,
                call.id,
                format!("本轮工具调用已达上限 {} 次，请基于已有结果直接回答", limiter::MAX_TOOL_CALLS_PER_TURN),
            );
            continue;
        }
        let ticket = match limiter::acquire(&call.name) {
            limiter::Decision::Allowed(ticket) => ticket,
            limiter::Decision::Blocked(reason) => {
                push_error(&mut results, call.id, reason);
                continue;
            }
        };

        if needs_confirmation(&call.name) {
            let (approved, always_allow) = request_confirmation(app, &call, None).await;
            if !approved {
                // 未真正执行，归还频率配额
                limiter::release(&call.name, ticket);
                push_error(&mut results, call.id, "用户拒绝了此操作".to_string());
                continue;
            }
            if always_allow && security::allow_always_on_approval(&call.name) {
                add_always_allowed(&call.name);
            }
        }

        let mut result = tools::execute_tool(app, &call.name, call.arguments.clone()).await;
        result.tool_call_id = call.id.clone();
        limiter::record_outcome(&call.name, !result.is_error);
        executed += 1;
        results.push(result);

        if call.name == "control_pet" {
            apply_pet_side_effects(app, &call);
        }
    }

    // 追问：原始消息 + 助手的工具调用轮 + 每条工具结果（role: tool）
    let mut messages = original.to_vec();
    messages.push(ai::Message {
        role: "assistant".to_string(),
        content: response.content.clone(),
        images: None,
    });
    for r in &results {
        messages.push(ai::Message {
            role: "tool".to_string(),
            content: r.result.clone(),
            images: None,
        });
    }
    let streaming = emit.is_some();
    let follow_up = ai::ChatRequest {
        messages,
        model: model.to_string(),
        stream: Some(streaming),
        tools: None,
    };
    let final_response = match emit.as_mut() {
        Some(f) => ai::stream_chat(provider, &follow_up, *f).await?,
        None => ai::chat(provider, &follow_up).await?,
    };
    Ok((results, final_response))
}

/// 定时任务的命令必须经确认才执行（T1.3，修 D03）。task-system 走这一条，不走 AI。
#[allow(dead_code)] // P3 的 task.rs 落地后即接上
pub async fn request_task_command(app: &AppHandle, task_name: &str, command: &str) -> Value {
    let guard = security::guard_command(command);
    if !guard.allowed {
        eprintln!("[Z-Bot Main] 任务命令被安全策略拒绝: {:?}", guard.reason);
        return json!({ "ok": false, "error": format!("命令被安全策略拒绝: {}", guard.reason.unwrap_or_default()) });
    }
    let short_id: String = uuid::Uuid::new_v4().simple().to_string().chars().take(6).collect();
    let call = ToolCall {
        id: format!("task_{}_{short_id}", now_ms()),
        name: "execute_command".to_string(),
        arguments: json!({ "command": command }),
    };
    println!("[Z-Bot Main] 任务「{task_name}」请求执行命令，等待用户确认");
    let (approved, _) = request_confirmation(app, &call, Some(&format!("定时任务「{task_name}」想要执行命令"))).await;
    if !approved {
        return json!({ "ok": false, "error": "用户拒绝执行任务命令" });
    }
    match tools::run_task_shell(command).await {
        Ok(output) => json!({ "ok": true, "output": output }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

// ---------- 快捷指令（对照 quick-commands.ts，只在 ai:* 里做一次子串匹配）----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QuickCommand {
    trigger: &'static str,
    response: &'static str,
}

/// 五条内置指令全为 enabled；Electron 的 commands 数组只存在内存里，没有任何持久化与增删入口。
const QUICK_COMMANDS: [QuickCommand; 5] = [
    QuickCommand { trigger: "今天天气", response: "好的！让我帮你查一下天气~ 🌤️" },
    QuickCommand { trigger: "番茄钟", response: "好的！开始25分钟专注时间~ 🍅" },
    QuickCommand { trigger: "讲个笑话", response: "为什么程序员分不清万圣节和圣诞节？因为 Oct 31 == Dec 25！😂" },
    QuickCommand { trigger: "休息一下", response: "好呀！起来活动一下身体吧~ 🧘" },
    QuickCommand { trigger: "加油", response: "你一定可以的！我相信你！💪🐱" },
];

pub fn check_quick_command(text: &str) -> Option<&'static QuickCommand> {
    let lower = text.to_lowercase();
    QUICK_COMMANDS.iter().find(|c| lower.contains(c.trigger))
}

fn last_message_text(messages: &[ai::Message]) -> String {
    messages.last().map(|m| m.content.clone()).unwrap_or_default()
}

/// 对照 ai-router.ts 的 maybeExtractMemory：抽的是**请求**消息，不是回复。
fn maybe_extract_memory(messages: &[ai::Message]) {
    let pairs: Vec<(&str, &str)> =
        messages.iter().map(|m| (m.role.as_str(), m.content.as_str())).collect();
    memory::extract_from_conversation(&pairs);
}

/// 补上模型解析与工具定义注入，与 Electron 的 `{...request, model, tools}` 同一步
fn equipped(mut req: ai::ChatRequest, cfg: &Value, provider: &ai::Provider) -> ai::ChatRequest {
    req.model = ai::resolve_model(&req.model, cfg, provider);
    if provider.supports_tools {
        req.tools = Some(tools::tool_definitions());
    }
    req
}

/// ChatResponse + 工具链路结果，拼成渲染端看到的 `{...final, toolCalls, toolResults}`
fn with_tools(final_response: &ai::ChatResponse, calls: &Option<Vec<Value>>, results: &[tools::ToolResult]) -> Value {
    let mut out = serde_json::to_value(final_response).unwrap_or_else(|_| json!({ "content": "" }));
    if let Some(obj) = out.as_object_mut() {
        if let Some(calls) = calls {
            obj.insert("toolCalls".into(), json!(calls));
        }
        obj.insert("toolResults".into(), json!(results));
    }
    out
}

// ---------- IPC: AI 引擎 ----------

/// Electron: ai:chat。错误一律 resolve 成文案，绝不 reject（渲染端没有 catch）。
#[tauri::command]
pub async fn ai_chat(app: AppHandle, request: Value) -> Value {
    let outcome = chat_inner(&app, request).await;
    match outcome {
        Ok(value) => value,
        Err(e) => {
            eprintln!("[Z-Bot Main] AI聊天错误: {e}");
            json!({ "content": format!("抱歉，AI请求失败: {e}") })
        }
    }
}

async fn chat_inner(app: &AppHandle, request: Value) -> Result<Value, String> {
    let cfg = state::load_config();
    let provider = ai::provider_from_config(&cfg);
    // 先留住原始请求消息：快捷指令与记忆抽取都按**进来的**最后一条消息算
    let incoming: ai::ChatRequest =
        serde_json::from_value(request).map_err(|e| format!("请求格式非法: {e}"))?;
    let original = incoming.messages.clone();
    let req = equipped(incoming, &cfg, &provider);

    let response = ai::chat(&provider, &req).await?;

    if let Some(matched) = check_quick_command(&last_message_text(&original)) {
        println!("[Z-Bot Main] 匹配到快捷指令: {}", matched.trigger);
        return Ok(json!({ "content": matched.response }));
    }

    if response.tool_calls.as_deref().map(|c| !c.is_empty()).unwrap_or(false) {
        let (results, final_response) =
            run_tool_calls(app, &provider, &original, &req.model, &response, None).await?;
        maybe_extract_memory(&original);
        return Ok(with_tools(&final_response, &response.tool_calls, &results));
    }

    maybe_extract_memory(&original);
    serde_json::to_value(&response).map_err(|e| e.to_string())
}

/// Electron: ai:testConnection —— 传了 providerConfig 就用它，否则回落到当前配置。
#[tauri::command]
pub async fn ai_test_connection(provider_config: Option<Value>) -> Value {
    let cfg = state::load_config();
    let provider = match provider_config {
        Some(raw) => match serde_json::from_value::<ai::Provider>(raw) {
            Ok(p) => p,
            Err(e) => return json!({ "success": false, "error": format!("请求格式非法: {e}") }),
        },
        None => ai::provider_from_config(&cfg),
    };
    ai::test_connection(&provider).await
}

/// Electron: ai:getModels 返回裸数组；渲染端把它当 `{success,models}` 用是既有 bug，
/// 这里不跟着改形状（改了 SettingsPanel 反而拿不到东西）。
#[tauri::command]
pub async fn ai_get_models(provider_config: Option<Value>) -> Vec<String> {
    let cfg = state::load_config();
    let provider = match provider_config {
        Some(raw) => match serde_json::from_value::<ai::Provider>(raw) {
            Ok(p) => p,
            Err(_) => return vec![],
        },
        None => ai::provider_from_config(&cfg),
    };
    ai::get_models(&provider).await
}

/// Electron: ai:streamChunk 只发给发起方窗口，admin 的流式内容不能串进 pet。
/// Tauri 的 `WebviewWindow` 命令参数就是调用方自己，天然等价于 event.sender。
#[tauri::command]
pub async fn ai_stream_chat(webview: WebviewWindow, app: AppHandle, request: Value) -> Value {
    let outcome = stream_inner(&app, &webview, request).await;
    match outcome {
        Ok(value) => value,
        Err(e) => {
            eprintln!("[Z-Bot Main] 流式聊天错误: {e}");
            json!({ "content": format!("流式请求失败: {e}") })
        }
    }
}

async fn stream_inner(
    app: &AppHandle,
    webview: &WebviewWindow,
    request: Value,
) -> Result<Value, String> {
    let cfg = state::load_config();
    let provider = ai::provider_from_config(&cfg);
    let incoming: ai::ChatRequest =
        serde_json::from_value(request).map_err(|e| format!("请求格式非法: {e}"))?;
    let original = incoming.messages.clone();
    let req = equipped(incoming, &cfg, &provider);

    let mut emit = {
        let w = webview.clone();
        move |payload: Value| {
            if let Err(e) = w.emit("ai:streamChunk", &payload) {
                eprintln!("[Z-Bot] ai:streamChunk 投递失败: {e}");
            }
        }
    };

    // 不支持工具型流式的提供商（claude/gemini 的 SSE 未收集 tool_use）整段下发
    let whole_text = !provider.supports_streaming
        || (provider.supports_tools && !ai::can_stream_tools(&provider.ptype));
    let response = if whole_text {
        let mut plain = req.clone();
        plain.stream = Some(false);
        let response = ai::chat(&provider, &plain).await?;
        emit(json!({ "content": response.content, "done": false }));
        emit(json!({ "content": "", "done": true }));
        response
    } else {
        ai::stream_chat(&provider, &req, &mut emit).await?
    };

    if response.tool_calls.as_deref().map(|c| !c.is_empty()).unwrap_or(false) {
        let (results, final_response) = run_tool_calls(
            app,
            &provider,
            &original,
            &req.model,
            &response,
            Some(&mut emit),
        )
        .await?;
        maybe_extract_memory(&original);
        return Ok(with_tools(&final_response, &response.tool_calls, &results));
    }

    maybe_extract_memory(&original);
    serde_json::to_value(&response).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_get_builtin_providers() -> Vec<ai::Provider> {
    ai::builtin_providers()
}

// ---------- IPC: MCP 工具 ----------

#[tauri::command]
pub fn tools_list() -> Vec<Value> {
    tools::tool_list()
        .into_iter()
        .map(|t| {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut t = t;
            if let Some(obj) = t.as_object_mut() {
                obj.insert("riskLevel".into(), json!(security::risk_level(&name) as i32));
            }
            t
        })
        .collect()
}

#[tauri::command]
pub fn tools_confirm(tool_call_id: String, approved: bool, always_allow: Option<bool>) -> bool {
    // 渲染端可能不带 alwaysAllow（旧弹窗），按 false 处理
    settle(&tool_call_id, (approved, always_allow.unwrap_or(false)))
}

#[tauri::command]
pub fn tools_cancel(tool_call_id: String) -> bool {
    // D09：渲染端主动取消也要能解开等待中的 AI 轮次
    settle(&tool_call_id, (false, false))
}

#[tauri::command]
pub fn tools_always_allowed() -> Vec<String> {
    list_always_allowed()
}

#[tauri::command]
pub fn tools_revoke_always_allowed(name: String) -> Vec<String> {
    revoke_always_allowed(&name)
}

/// 确认表在退出前不该留未决项（否则 onboarding 期间重复弹同一个 toolCallId 会被判为已完成）
#[cfg(test)]
pub fn reset_for_tests() {
    pending().lock().expect("确认表被污染").clear();
    always_allowed().lock().expect("白名单被污染").clear();
    limiter::reset(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_gate_matches_electron_risk_table() {
        // Safe：不确认
        assert!(!needs_confirmation("get_weather"));
        assert!(!needs_confirmation("get_datetime"));
        assert!(!needs_confirmation("control_pet"));
        // Sensitive：要确认
        assert!(needs_confirmation("execute_command"), "DANGEROUS 必须确认");
        assert!(needs_confirmation("clipboard_read"));
        // 未知工具按最危险处理
        assert!(needs_confirmation("不存在的工具"));
    }

    #[test]
    fn always_allowed_skips_confirmation_but_not_dangerous() {
        let _g = crate::lock_test_env();
        reset_for_tests();
        assert!(needs_confirmation("clipboard_read"));
        add_always_allowed("clipboard_read");
        add_always_allowed("clipboard_read");
        assert_eq!(list_always_allowed(), vec!["clipboard_read".to_string()], "重复登记不该出现两次");
        assert!(!needs_confirmation("clipboard_read"));
        // DANGEROUS 不接受总是允许
        add_always_allowed("execute_command");
        assert!(needs_confirmation("execute_command"));
        assert_eq!(revoke_always_allowed("clipboard_read"), vec!["execute_command".to_string()]);
        assert!(needs_confirmation("clipboard_read"));
        reset_for_tests();
    }

    #[test]
    fn tool_call_shapes_from_all_providers_normalize() {
        let openai = json!({ "id": "call_1", "function": { "name": "get_weather", "arguments": "{\"city\":\"上海\"}" } });
        let call = normalize_tool_call(&openai);
        assert_eq!(call.id, "call_1");
        assert_eq!(call.name, "get_weather");
        assert_eq!(call.arguments["city"], json!("上海"));

        // ollama：无 id，arguments 是对象
        let ollama = json!({ "function": { "name": "control_pet", "arguments": { "action": "dance" } } });
        let call = normalize_tool_call(&ollama);
        assert!(call.id.starts_with("call_"), "缺 id 要补时间戳 id");
        assert_eq!(call.arguments["action"], json!("dance"));

        // 坏 JSON 参数不该抛错
        let broken = json!({ "id": "x", "function": { "name": "read_url", "arguments": "{oops" } });
        assert_eq!(normalize_tool_call(&broken).arguments, json!({}));
    }

    #[test]
    fn quick_command_is_substring_and_case_insensitive() {
        assert_eq!(check_quick_command("今天天气怎么样").map(|c| c.response), Some("好的！让我帮你查一下天气~ 🌤️"));
        assert_eq!(check_quick_command("加油!").map(|c| c.trigger), Some("加油"));
        assert_eq!(check_quick_command("Give me a TOMATO 番茄钟 task").map(|c| c.trigger), Some("番茄钟"));
        assert!(check_quick_command("随便说点什么").is_none());
    }

    #[test]
    fn timeout_settles_as_rejection() {
        let _g = crate::lock_test_env();
        reset_for_tests();
        let (tx, _rx) = oneshot::channel();
        pending().lock().unwrap().insert("t1".to_string(), tx);
        assert!(settle("t1", (false, false)), "首次应答应生效");
        assert!(!settle("t1", (true, true)), "重复应答应被丢弃");
        reset_for_tests();
    }
}

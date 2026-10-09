//! 工具注册表：对照 src/main/mcp-tools.ts（T4.5 的 11 个工具）。
//!
//! 名称、描述、JSON Schema、requiresConfirmation 全部原样搬 —— 这些文案是给模型看的，
//! 改一个字的措辞都可能让某个模型不再调用它。与 Electron 的三处刻意差异：
//! - `validateFetchUrl` 修掉了 `172.(1[6-9]|2\\d|3[01])` 里那个多反斜杠的正则（Electron 漏掉了
//!   172.20–172.29 整段），并且会把域名解析成 IP 再判一次内网，堵住"域名指向 127.0.0.1"。
//! - `screenshot_analyze` 真的截图并交给视觉模型；Electron 只回了一句
//!   `截图分析请求: xxx` 让模型以为分析完成了。
//! - `execute_command` 输出上限 1MB（Electron 靠 exec 默认 maxBuffer 撞上才报错），
//!   超限截断并标注，不再整条命令报错。

use std::time::Duration;

use data_encoding::BASE64;
use regex::Regex;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{ai, notify, screenshot, security, state};

#[derive(Debug, Clone)]
pub struct ToolMeta {
    pub name: &'static str,
    pub description: &'static str,
    pub requires_confirmation: bool,
}

/// 顺序即 tools:list 与发给模型的 tools 数组顺序，不要重排
pub const TOOLS: [ToolMeta; 11] = [
    ToolMeta { name: "web_search", description: "搜索网页，获取搜索结果摘要。输入搜索关键词，返回相关结果。", requires_confirmation: true },
    ToolMeta { name: "read_url", description: "读取URL网页内容，提取纯文本。输入URL地址，返回页面文本内容。", requires_confirmation: true },
    ToolMeta { name: "get_weather", description: "获取指定城市的天气信息。输入城市名称（中文或英文），返回当前天气状况。", requires_confirmation: false },
    ToolMeta { name: "get_datetime", description: "获取当前日期和时间信息。", requires_confirmation: false },
    ToolMeta { name: "set_reminder", description: "设置提醒，在指定分钟后发送系统通知。参数: message(提醒内容), delayMinutes(延迟分钟数)", requires_confirmation: true },
    ToolMeta { name: "open_app", description: "打开应用程序。macOS使用应用名称打开。此操作需要用户确认。", requires_confirmation: true },
    ToolMeta { name: "execute_command", description: "执行终端命令。此操作需要用户确认，请谨慎使用。", requires_confirmation: true },
    ToolMeta { name: "control_pet", description: "控制桌面宠物的动画和行为。可触发动画(dance/roll/jump/wave/sleep)或改变皮肤颜色。", requires_confirmation: false },
    ToolMeta { name: "screenshot_analyze", description: "截取屏幕截图并分析内容。截图后发送给视觉语言模型进行分析。", requires_confirmation: true },
    ToolMeta { name: "clipboard_read", description: "读取系统剪贴板内容。", requires_confirmation: true },
    ToolMeta { name: "clipboard_write", description: "写入内容到系统剪贴板。此操作需要用户确认。", requires_confirmation: true },
];

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub result: String,
    pub is_error: bool,
}

impl ToolResult {
    pub(crate) fn ok(tool_call_id: &str, result: impl Into<String>) -> Self {
        Self { tool_call_id: tool_call_id.to_string(), result: result.into(), is_error: false }
    }
    pub(crate) fn err(tool_call_id: &str, result: impl Into<String>) -> Self {
        Self { tool_call_id: tool_call_id.to_string(), result: result.into(), is_error: true }
    }
}

fn parameters(name: &str) -> Value {
    match name {
        "web_search" => json!({ "type": "object", "properties": { "query": { "type": "string", "description": "搜索关键词" } }, "required": ["query"] }),
        "read_url" => json!({ "type": "object", "properties": { "url": { "type": "string", "description": "要读取的URL地址" } }, "required": ["url"] }),
        "get_weather" => json!({ "type": "object", "properties": { "city": { "type": "string", "description": "城市名称，如\"北京\"或\"Beijing\"" } }, "required": ["city"] }),
        "get_datetime" => json!({ "type": "object", "properties": {} }),
        "set_reminder" => json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "提醒内容" },
                "delayMinutes": { "type": "number", "description": "延迟分钟数" }
            },
            "required": ["message", "delayMinutes"]
        }),
        "open_app" => json!({ "type": "object", "properties": { "appName": { "type": "string", "description": "应用名称，如\"Safari\"、\"微信\"、\"Finder\"" } }, "required": ["appName"] }),
        "execute_command" => json!({ "type": "object", "properties": { "command": { "type": "string", "description": "要执行的命令" } }, "required": ["command"] }),
        "control_pet" => json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["dance", "roll", "jump", "wave", "sleep"], "description": "要触发的动作" },
                "color": { "type": "string", "description": "可选的皮肤颜色" }
            },
            "required": ["action"]
        }),
        "screenshot_analyze" => json!({ "type": "object", "properties": { "question": { "type": "string", "description": "想让模型分析什么" } }, "required": ["question"] }),
        "clipboard_read" => json!({ "type": "object", "properties": {} }),
        "clipboard_write" => json!({ "type": "object", "properties": { "text": { "type": "string", "description": "要写入剪贴板的文本" } }, "required": ["text"] }),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

/// OpenAI function-call 形状；ollama 用的是同一套
pub fn tool_definitions() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": parameters(t.name) } }))
        .collect()
}

/// tools:list 的条目（riskLevel 由调用方补，Electron 也是在这里叠的）
pub fn tool_list() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "requiresConfirmation": t.requires_confirmation }))
        .collect()
}

pub fn tool_requires_confirmation(name: &str) -> bool {
    TOOLS.iter().find(|t| t.name == name).map(|t| t.requires_confirmation).unwrap_or(true)
}

fn param_str(params: &Value, key: &str) -> String {
    params.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn clip_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// ---------- 网络与进程 ----------

async fn http_get(url: &str, timeout: Duration) -> Result<String, String> {
    // Electron 用裸 http.get：不跟随重定向、不设 UA，这里保持一致，
    // 否则 read_url 会拿到一个跟原来不同的最终页面。
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

const MAX_COMMAND_OUTPUT: usize = 1024 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 带超时的子进程输出。windowsHide 在 Rust 侧对应 CREATE_NO_WINDOW。
/// voice.rs 的 whisper/ffmpeg/PowerShell 也走这一个入口（超时与 CREATE_NO_WINDOW 语义一致）
pub(crate) async fn run_captured(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    // tokio::process::Command 自带 creation_flags，不需要 std 的 CommandExt trait
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "命令执行超时".to_string())?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        // 按字符截：按字节切中文输出会踩在非 UTF-8 边界上直接 panic
        if stdout.chars().count() > MAX_COMMAND_OUTPUT {
            return Ok(format!("{}\n…(输出超过 1MB 已截断)", stdout.chars().take(MAX_COMMAND_OUTPUT).collect::<String>()));
        }
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("进程退出码 {}", output.status.code().unwrap_or(-1)))
    } else {
        Err(stderr)
    }
}

/// Electron 的 exec 在 Windows 走 `%ComSpec% /d /s /c`，其他平台走 $SHELL -c
async fn exec_shell(command: &str, timeout: Duration) -> Result<String, String> {
    #[cfg(windows)]
    {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        run_captured(&comspec, &["/d", "/s", "/c", command], timeout).await
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        run_captured(&shell, &["-c", command], timeout).await
    }
}

// ---------- read_url 的 SSRF 闸门 ----------

#[derive(Debug, Clone)]
pub struct FetchCheck {
    pub ok: bool,
    pub url: Option<String>,
    pub reason: Option<String>,
}

fn is_blocked_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host.is_empty() {
        return true;
    }
    if host == "::1"
        || host == "0:0:0:0:0:0:0:1"
        || host == "localhost"
        || host == "metadata.google.internal"
        || host == "0.0.0.0"
    {
        return true;
    }
    if host.ends_with(".internal") || host.ends_with(".local") {
        return true;
    }
    if host.starts_with("fc") || host.starts_with("fd") || host.starts_with("fe80:") {
        return true;
    }
    if host.contains(':') || host.contains('.') {
        // v6 一律按内网处理（除了纯映射地址太复杂，这里不区分）
        if host.contains(':') {
            return true;
        }
        let octets: Vec<&str> = host.split('.').collect();
        if let Some(first) = octets.first() {
            let n: u32 = first.parse().unwrap_or(u32::MAX);
            match n {
                0 | 10 | 127 | 169 => return true,
                172 => {
                    if let Some(second) = octets.get(1) {
                        let s: u32 = second.parse().unwrap_or(u32::MAX);
                        if (16..=31).contains(&s) {
                            return true;
                        }
                    }
                }
                192 => {
                    if octets.get(1).and_then(|v| v.parse::<u32>().ok()) == Some(168) {
                        return true;
                    }
                }
                _ => {}
            }
        }
    }
    false
}

/// 域名还要解析一次：否则 `evil.com → 127.0.0.1` 能绕过所有字符串规则。
/// 解析失败按"拦"处理（fail closed），但给出独立原因，别把 DNS 故障说成内网地址。
fn blocked_by_resolution(host: &str) -> Option<bool> {
    use std::net::{IpAddr, ToSocketAddrs};
    let internal = |ip: IpAddr| match ip {
        // is_private / is_link_local 只在 Ipv4Addr 上是稳定 API，Ipv6 用等价判据补齐
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_unspecified()
                || v4.is_link_local()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            // fe80::/10：Ipv6Addr::is_unicast_link_local 仍在 unstable，按前缀自己判
            let link_local = (v6.segments()[0] & 0xffc0) == 0xfe80;
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || link_local
        }
    };
    match (host, 80u16).to_socket_addrs() {
        Ok(addrs) => Some(addrs.into_iter().any(|a| internal(a.ip()))),
        Err(_) => None,
    }
}

pub fn validate_fetch_url(raw: Option<&str>) -> FetchCheck {
    let input = raw.unwrap_or("").trim().to_string();
    if input.is_empty() {
        return FetchCheck { ok: false, url: None, reason: Some("缺少 url 参数".into()) };
    }
    let parsed = match url::Url::parse(&input) {
        Ok(u) => u,
        Err(_) => return FetchCheck { ok: false, url: None, reason: Some("url 格式非法".into()) },
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return FetchCheck { ok: false, url: None, reason: Some("只允许 http/https".into()) };
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if is_blocked_host(&host) {
        return FetchCheck { ok: false, url: None, reason: Some("禁止访问内网/环回地址".into()) };
    }
    // 字面 IP 不必解析；域名要解析，否则 rebinding 能绕过字符串规则
    if host.parse::<std::net::IpAddr>().is_err() {
        match blocked_by_resolution(&host) {
            Some(true) => {
                return FetchCheck { ok: false, url: None, reason: Some("禁止访问内网/环回地址".into()) }
            }
            None => return FetchCheck { ok: false, url: None, reason: Some("域名解析失败".into()) },
            Some(false) => {}
        }
    }
    FetchCheck { ok: true, url: Some(parsed.to_string()), reason: None }
}

fn strip_html(html: &str) -> String {
    let re_block = |pattern: &str, src: &str, repl: &str| -> String {
        Regex::new(pattern)
            .map(|r| r.replace_all(src, repl).to_string())
            .unwrap_or_else(|_| src.to_string())
    };
    let without_scripts = re_block(r"(?is)<script.*?</script>", html, "");
    let without_styles = re_block(r"(?is)<style.*?</style>", &without_scripts, "");
    // 标签换成空格而不是空串：`<div>a</div><div>b</div>` 直连会变成 "ab"，Electron 给的是 "a b"
    let without_tags = re_block(r"(?s)<[^>]+>", &without_styles, " ");
    let unescaped = without_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"");
    let collapsed = Regex::new(r"\s+")
        .map(|r| r.replace_all(&unescaped, " ").to_string())
        .unwrap_or(unescaped);
    clip_chars(collapsed.trim(), 5000)
}

// ---------- 各工具实现 ----------

async fn web_search(params: &Value) -> String {
    let query = param_str(params, "query").trim().to_string();
    if query.is_empty() {
        return "缺少 query 参数，无法搜索。".to_string();
    }
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    match http_get(&url, Duration::from_secs(10)).await {
        Ok(text) => {
            let parsed: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(e) => return format!("搜索失败: {e}"),
            };
            let mut results: Vec<String> = vec![];
            if let Some(abstract_text) = parsed.get("AbstractText").and_then(|v| v.as_str()) {
                if !abstract_text.is_empty() {
                    results.push(format!("摘要: {abstract_text}"));
                }
            }
            if let Some(topics) = parsed.get("RelatedTopics").and_then(|v| v.as_array()) {
                for topic in topics.iter().take(5) {
                    if let Some(text) = topic.get("Text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            results.push(format!("- {text}"));
                        }
                    }
                }
            }
            if results.is_empty() {
                return "未找到相关搜索结果。".to_string();
            }
            results.join("\n")
        }
        Err(e) => format!("搜索失败: {e}"),
    }
}

async fn read_url(params: &Value) -> String {
    let check = validate_fetch_url(params.get("url").and_then(|v| v.as_str()));
    if !check.ok {
        return format!("读取URL失败: {}", check.reason.unwrap_or_default());
    }
    match http_get(check.url.as_deref().unwrap_or_default(), Duration::from_secs(15)).await {
        Ok(html) => {
            let text = strip_html(&html);
            if text.is_empty() {
                "无法提取页面文本内容。".to_string()
            } else {
                text
            }
        }
        Err(e) => format!("读取URL失败: {e}"),
    }
}

async fn get_weather(params: &Value) -> String {
    let city = param_str(params, "city");
    let encoded = url::form_urlencoded::byte_serialize(city.as_bytes()).collect::<String>();
    let url = format!("https://wttr.in/{encoded}?format=j1&lang=zh");
    match http_get(&url, Duration::from_secs(10)).await {
        Ok(text) => {
            let parsed: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(e) => return format!("获取天气失败: {e}"),
            };
            let current = match parsed.get("current_condition").and_then(|c| c.get(0)) {
                Some(c) => c,
                None => return "无法获取天气信息。".to_string(),
            };
            let field = |path: &[&str]| -> String {
                let mut node: &Value = current;
                for key in path {
                    node = match node.get(*key) {
                        Some(v) => v,
                        None => return String::new(),
                    };
                }
                match node {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                }
            };
            let desc = {
                let zh = field(&["lang_zh", "0", "value"]);
                if zh.is_empty() { field(&["weatherDesc", "0", "value"]) } else { zh }
            };
            format!(
                "天气: {}\n温度: {}°C (体感 {}°C)\n湿度: {}%\n风速: {} km/h {}",
                desc,
                field(&["temp_C"]),
                field(&["FeelsLikeC"]),
                field(&["humidity"]),
                field(&["windspeedKmph"]),
                field(&["winddir16Point"])
            )
        }
        Err(e) => format!("获取天气失败: {e}"),
    }
}

fn get_datetime() -> String {
    use chrono::{Datelike, Local, Timelike};
    let now = Local::now();
    let weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    // 年月日不补零、时分秒补零 —— 与 Electron 的 padStart 逐个对齐
    format!(
        "当前时间: {}年{}月{}日 星期{} {:02}:{:02}:{:02}",
        now.year(),
        now.month(),
        now.day(),
        weekdays[now.weekday().num_days_from_sunday() as usize],
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// Electron 只在主进程事件循环里挂了个 setTimeout：不落盘、不可取消、退出即失效。
/// 这里同样只做进程内定时器（用 async sleep），但重启后不会"复活"是刻意保持一致的行为。
fn set_reminder(app: &AppHandle, params: &Value) -> String {
    let message = param_str(params, "message");
    let raw = params.get("delayMinutes").and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
    let minutes = if raw.is_finite() { raw.max(1.0) } else { 1.0 };
    let echo = params
        .get("delayMinutes")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "1".to_string());
    let handle = app.clone();
    let body = message.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs_f64(minutes * 60.0)).await;
        notify::notify(&handle, "⏰ Z-Bot 提醒", &body);
    });
    format!("已设置提醒: {echo}分钟后提醒\"{message}\"")
}

async fn open_app(params: &Value) -> String {
    let guard = security::guard_app_name(&param_str(params, "appName"));
    if !guard.allowed {
        return format!("打开应用失败: {}", guard.reason.unwrap_or_default());
    }
    let name = guard.resolved.unwrap_or_default();
    let program = if cfg!(target_os = "macos") {
        ("open", vec!["-a".to_string(), name.clone()])
    } else if cfg!(windows) {
        // start 的空标题参数不能省，否则第一个引号参数会被当成窗口标题吃掉
        ("cmd", vec!["/d".into(), "/s".into(), "/c".into(), "start".into(), "\"\"".into(), name.clone()])
    } else {
        ("xdg-open", vec![name.clone()])
    };
    let args: Vec<&str> = program.1.iter().map(|s| s.as_str()).collect();
    match run_captured(program.0, &args, Duration::from_secs(10)).await {
        Ok(_) => format!("已打开应用: {name}"),
        Err(e) => format!("打开应用失败: {}", e.trim()),
    }
}

async fn execute_command(params: &Value) -> String {
    let command = param_str(params, "command");
    let guard = security::guard_command(&command);
    if !guard.allowed {
        return format!("操作被安全策略拒绝: {}", guard.reason.unwrap_or_default());
    }
    match exec_shell(&command, Duration::from_secs(10)).await {
        Ok(out) => {
            if out.is_empty() {
                "(命令执行成功，无输出)".to_string()
            } else {
                out
            }
        }
        Err(e) => format!("命令执行失败: {e}"),
    }
}

/// 定时任务的命令执行器（对照 ai-router.ts 的 runShellWithTimeout）：
/// 已经过确认，所以不再走 guard；输出/错误分别截 5000/500，与 Electron 一致。
pub async fn run_task_shell(command: &str) -> Result<String, String> {
    match exec_shell(command, Duration::from_secs(10)).await {
        Ok(out) => Ok(clip_chars(&out, 5000)),
        Err(e) => Err(clip_chars(&e, 500)),
    }
}

fn control_pet(params: &Value) -> String {
    let action = param_str(params, "action");
    let color = param_str(params, "color");
    if color.is_empty() {
        format!("宠物执行动作: {action}")
    } else {
        format!("宠物执行动作: {action}，颜色变为: {color}")
    }
}

async fn clipboard_read(app: &AppHandle) -> String {
    match app.clipboard().read_text() {
        Ok(text) if !text.is_empty() => format!("剪贴板内容: {}", clip_chars(&text, 2000)),
        // Electron 这时会再读一次图片；tauri-plugin-clipboard-manager 没有 read_image，
        // 只能报空。宁可少给模型一条信息，也不要谎报"已获取"。
        Ok(_) => "剪贴板为空".to_string(),
        Err(e) => format!("读取剪贴板失败: {e}"),
    }
}

fn clipboard_write(app: &AppHandle, params: &Value) -> String {
    let text = param_str(params, "text");
    match app.clipboard().write_text(text.clone()) {
        Ok(()) => format!("已写入剪贴板: {}", clip_chars(&text, 100)),
        Err(e) => format!("写入剪贴板失败: {e}"),
    }
}

async fn screenshot_analyze(params: &Value) -> String {
    let question = param_str(params, "question");
    let bytes = match screenshot::grab_screen() {
        Ok(b) if !b.is_empty() => b,
        Ok(_) => return "无法获取屏幕截图".to_string(),
        Err(e) => return format!("截图失败: {e}"),
    };
    let image_base64 = BASE64.encode(&bytes);
    let cfg = state::load_config();
    let provider = ai::provider_from_config(&cfg);
    if !provider.supports_vision {
        return "当前AI引擎不支持视觉分析，请切换到支持Vision的模型".to_string();
    }
    let request = ai::ChatRequest {
        messages: vec![
            ai::Message { role: "user".into(), content: question, images: Some(vec![image_base64]) },
        ],
        model: ai::resolve_model("", &cfg, &provider),
        stream: Some(false),
        tools: None,
    };
    match ai::chat(&provider, &request).await {
        Ok(response) => response.content,
        Err(e) => format!("截图分析失败: {e}"),
    }
}

pub async fn execute_tool(app: &AppHandle, name: &str, params: Value) -> ToolResult {
    let result = match name {
        "web_search" => web_search(&params).await,
        "read_url" => read_url(&params).await,
        "get_weather" => get_weather(&params).await,
        "get_datetime" => get_datetime(),
        "set_reminder" => set_reminder(app, &params),
        "open_app" => open_app(&params).await,
        "execute_command" => execute_command(&params).await,
        "control_pet" => control_pet(&params),
        "screenshot_analyze" => screenshot_analyze(&params).await,
        "clipboard_read" => clipboard_read(app).await,
        "clipboard_write" => clipboard_write(app, &params),
        // executeTool 是唯一会给出 isError=true 的分支（除了限流/拒绝）
        other => return ToolResult::err("", format!("未知工具: {other}")),
    };
    ToolResult::ok("", result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_keeps_the_electron_order_and_confirmation_flags() {
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            vec![
                "web_search", "read_url", "get_weather", "get_datetime", "set_reminder", "open_app",
                "execute_command", "control_pet", "screenshot_analyze", "clipboard_read", "clipboard_write"
            ]
        );
        // 免确认的只有这三个，其余一律要过确认弹窗
        for free in ["get_weather", "get_datetime", "control_pet"] {
            assert!(!tool_requires_confirmation(free), "{free} 不该要确认");
        }
        assert!(tool_requires_confirmation("execute_command"));
        assert!(tool_requires_confirmation("不存在的工具"), "未知工具默认要确认");
        assert_eq!(tool_definitions().len(), 11);
        assert_eq!(tool_list().len(), 11);
    }

    #[test]
    fn every_tool_declaration_is_valid_json_schema() {
        for def in tool_definitions() {
            let func = def.get("function").expect("function 字段");
            let schema = func.get("parameters").expect("parameters 字段");
            assert_eq!(schema["type"], json!("object"), "{} 的 schema 形状不对", func["name"]);
            assert!(schema.get("properties").is_some(), "{} 必须带 properties", func["name"]);
            assert_eq!(def["type"], json!("function"));
        }
    }

    #[test]
    fn ssrf_gate_blocks_private_and_loopback() {
        // 这些都是按名字/字面 IP 就能判的，不依赖 DNS，测试不会因离线而假通过
        for bad in [
            "http://localhost:8084/transcribe",
            "http://127.0.0.1/x",
            "http://10.1.2.3/x",
            "http://192.168.1.1/x",
            "http://169.254.169.254/meta",
            "http://[::1]:8084/x",
            "http://0.0.0.0/x",
            "http://intranet.internal/x",
            "http://printer.local/x",
        ] {
            let check = validate_fetch_url(Some(bad));
            assert!(!check.ok, "{bad} 必须被挡住");
            assert_eq!(check.reason.as_deref(), Some("禁止访问内网/环回地址"), "{bad}");
        }
        // 非 http/https 走的是另一条拒绝理由
        let file = validate_fetch_url(Some("file:///C:/windows/win.ini"));
        assert!(!file.ok);
        assert_eq!(file.reason.as_deref(), Some("只允许 http/https"));
        assert_eq!(validate_fetch_url(None).reason.as_deref(), Some("缺少 url 参数"));
        assert_eq!(validate_fetch_url(Some("不是 url")).reason.as_deref(), Some("url 格式非法"));
    }

    #[test]
    fn ssrf_gate_covers_the_whole_172_range_electron_missed() {
        // Electron 的正则写成 `2\\d`，172.20–172.29 整段漏判；这里必须全部拦住
        for second in [16u32, 17, 19, 20, 25, 29, 30, 31] {
            let url = format!("http://172.{second}.1.1/x");
            assert!(!validate_fetch_url(Some(&url)).ok, "{url} 属于内网段，必须拦住");
        }
        assert!(validate_fetch_url(Some("http://172.15.1.1/x")).ok, "172.15 是公网段");
    }

    #[test]
    fn strip_html_matches_the_electron_output() {
        // 期望值不是推出来的：迁移当时用 node 跑 Electron 版 mcp-tools.ts:86 的原实现逐条对齐（该文件已随壳删除）
        for (html, want) in [
            (
                "<div><script>var a=1;</script><style>.a{color:red}</style>你好&nbsp;&amp;再见   <b>粗</b></div>",
                "你好 &再见 粗",
            ),
            ("<div>aaa</div><div>bbb</div>", "aaa bbb"),
            ("正文<p>段落</p>尾部", "正文 段落 尾部"),
            ("<a href=\"x\">链接</a>\n\t换行  空格", "链接 换行 空格"),
            ("A&amp;B&quot;C&quot;", "A&B\"C\""),
        ] {
            assert_eq!(strip_html(html), want, "输入: {html}");
        }
    }

    #[test]
    fn strip_html_caps_at_five_thousand_chars() {
        let long = "字".repeat(6000);
        assert_eq!(strip_html(&long).chars().count(), 5000);
    }

    #[test]
    fn datetime_line_matches_the_electron_format() {
        let line = get_datetime();
        assert!(line.starts_with("当前时间: "), "前缀变了模型就认不出来: {line}");
        assert!(line.contains("星期"), "缺星期: {line}");
    }
}

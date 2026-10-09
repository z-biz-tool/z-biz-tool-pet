//! 会议实时转录（P3）。对照 src/main/meeting-transcriber.ts。
//!
//! 抓取系统音频 → 每 10 秒切一段增量 wav → whisper 转写 → 每 5 段做一次滚动摘要 →
//! 结束时落盘 `~/.z-bot/meetings/{id}.txt` 并让 AI 出结构化总结。
//!
//! 与 Electron 的三处有意差异，其余行为逐条对齐：
//! - STT 不再走 HTTP（sidecar 已被 voice.rs 取代），切块直接调本进程的 `voice::transcribe`，
//!   15 秒预算就是原来那个 AbortController 超时。
//! - 切块用完即删。Electron 把 `{id}_chunk_N.wav` 全留在 meetings 目录里，
//!   16k 单声道 10 秒一段 ≈ 每小时 68 MB，是纯泄漏。
//! - 默认会议标题的时间格式：JS 用 `toLocaleString('zh-CN')`，Rust 没有 ICU，
//!   退成 `%Y/%m/%d %H:%M:%S`（可读性一致，字段顺序不同）。

use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::{ai, state, store, voice};

const CHUNK_INTERVAL_MS: u64 = 10_000;
/// 原来那次 fetch 的 AbortController 超时
const STT_BUDGET: Duration = Duration::from_secs(15);
/// 小于这个字节数的切块只剩头和静音，Electron 直接跳过
const MIN_CHUNK_BYTES: u64 = 1000;
/// 每 5 段触发一次滚动摘要
const SUMMARY_EVERY: usize = 5;
/// 摘要只看最近 10 段
const SUMMARY_WINDOW: usize = 10;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn meetings_dir() -> PathBuf {
    store::data_dir().join("meetings")
}

// ---------- 会议状态 ----------

fn idle_state() -> Value {
    json!({
        "id": "", "title": "", "startedAt": "", "segments": [], "rollingSummary": "", "status": "idle"
    })
}

static MEETING: Mutex<Option<Value>> = Mutex::new(None);

fn state_of() -> Value {
    MEETING
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(idle_state)
}

fn status() -> String {
    state_of()
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("idle")
        .to_string()
}

fn segments_of() -> Vec<Value> {
    state_of()
        .get("segments")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn field(st: &Value, key: &str) -> String {
    st.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// 改状态并广播 `meeting:state`；Electron 的 broadcast 打给所有窗口
fn update_state(app: &AppHandle, f: impl FnOnce(&mut Value)) {
    let snapshot = {
        let mut guard = match MEETING.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.is_none() {
            *guard = Some(idle_state());
        }
        let st = guard.as_mut().unwrap();
        f(st);
        st.clone()
    };
    broadcast(app, "meeting:state", &snapshot);
}

fn broadcast(app: &AppHandle, event: &str, payload: &Value) {
    for window in app.webview_windows().values() {
        let _ = window.emit(event, payload);
    }
}

// ---------- 捕获进程生命周期 ----------

/// 一次捕获的全部句柄。子进程放进 Arc：看门狗线程要 poll，会议结束时要 kill。
struct Capture {
    child: Arc<Mutex<std::process::Child>>,
    /// ffmpeg 的诊断输出（同一时刻只有一场会议，挂在 Capture 上即可）
    stderr: Arc<Mutex<String>>,
    /// 主动结束（end/cancel）时 kill 掉 ffmpeg 属正常，不能当成失败
    stopping: Arc<AtomicBool>,
    /// 让切块循环退出
    stop: Arc<AtomicBool>,
}

static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

/// 已经切走多少字节 PCM（对应 Electron 的模块级 chunkByteOffset）
static CHUNK_OFFSET: AtomicU64 = AtomicU64::new(0);

/// 停止捕获：先立 stopping 再 kill，否则看门狗会把正常退出报成会议失败
fn shutdown_capture() {
    let cap = CAPTURE.lock().ok().and_then(|mut g| g.take());
    if let Some(cap) = cap {
        cap.stopping.store(true, Ordering::SeqCst);
        cap.stop.store(true, Ordering::SeqCst);
        if let Ok(mut child) = cap.child.lock() {
            let _ = child.kill();
        }
    }
}

/// 捕获进程在 recording 期间自己退出：立刻把会议置为 error 并停掉切块循环
fn fail_capture(app: &AppHandle, reason: String) {
    let intentional = CAPTURE
        .lock()
        .map(|g| match g.as_ref() {
            Some(c) => c.stopping.load(Ordering::SeqCst),
            // 句柄已被 end/cancel 取走，属于正常收尾
            None => true,
        })
        .unwrap_or(true);
    if intentional || status() != "recording" {
        return;
    }
    if let Ok(g) = CAPTURE.lock() {
        if let Some(c) = g.as_ref() {
            c.stop.store(true, Ordering::SeqCst);
        }
    }
    eprintln!("[Meeting] 音频捕获失败: {reason}");
    update_state(app, |st| {
        st["status"] = json!("error");
        st["error"] = json!(reason);
    });
}

/// ffmpeg 意外退出的原因文案：dyld 损坏单独点出来，其余给 stderr 尾部
pub fn capture_exit_reason(code: i32, stderr: &str) -> String {
    let mut base = format!("音频捕获进程意外退出 (code={code})。");
    if is_broken_install(stderr) {
        base.push_str(" ffmpeg 安装已损坏（动态库缺失），需重装 ffmpeg");
    } else if !stderr.trim().is_empty() {
        base.push(' ');
        base.push_str(&collapse_tail(stderr, 200));
    } else {
        base.push_str(" 请检查麦克风/系统音频权限与 ffmpeg 是否可用");
    }
    base
}

fn is_broken_install(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("library not loaded") || lower.contains("dyld")
}

/// 只留尾部 keep 个字符，并把空白串压成一个空格
pub fn collapse_tail(text: &str, keep: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(keep);
    let mut out = String::new();
    for c in &chars[start..] {
        if c.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(*c);
        }
    }
    out
}

// ---------- wav 头解析与增量切块（D19 的 Rust 版）----------

#[derive(Debug, Clone, PartialEq)]
pub struct WavInfo {
    /// data 块在文件中的起始字节
    pub data_offset: usize,
    pub byte_rate: u32,
    pub bits_per_sample: u16,
    pub channels: u16,
    pub sample_rate: u32,
}

fn u16_at(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([buf[at], buf[at + 1]])
}

fn u32_at(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
}

/// 解析 RIFF/WAVE 头，容忍 fmt 之后还有 LIST 之类的块
pub fn parse_wav_header(buf: &[u8]) -> Option<WavInfo> {
    if buf.len() < 12 {
        return None;
    }
    if &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12usize;
    let mut byte_rate = 0u32;
    let mut bits_per_sample = 16u16;
    let mut channels = 1u16;
    let mut sample_rate = 16000u32;
    loop {
        if pos + 8 > buf.len() {
            break;
        }
        let id = &buf[pos..pos + 4];
        let size = u32_at(buf, pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= buf.len() {
            channels = u16_at(buf, body + 2);
            sample_rate = u32_at(buf, body + 4);
            byte_rate = u32_at(buf, body + 8);
            bits_per_sample = u16_at(buf, body + 14);
        } else if id == b"data" {
            let fallback = sample_rate * channels as u32 * (bits_per_sample / 8) as u32;
            return Some(WavInfo {
                data_offset: body,
                byte_rate: if byte_rate != 0 { byte_rate } else { fallback },
                bits_per_sample,
                channels,
                sample_rate,
            });
        }
        if size == 0 {
            break;
        }
        // RIFF 块按偶数字节对齐
        pos = body + size + (size % 2);
    }
    None
}

/// 给切出来的 PCM 重新套一个 44 字节头，whisper 才认这是 wav
pub fn build_wav_header(pcm_length: u64, info: &WavInfo) -> Vec<u8> {
    let byte_rate = if info.byte_rate != 0 {
        info.byte_rate
    } else {
        info.sample_rate * info.channels as u32 * (info.bits_per_sample / 8) as u32
    };
    let block_align = (((info.bits_per_sample / 8) as u32 * info.channels as u32).max(1)) as u16;
    let mut h = vec![0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + pcm_length as u32).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&info.channels.to_le_bytes());
    h[24..28].copy_from_slice(&info.sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&block_align.to_le_bytes());
    h[34..36].copy_from_slice(&info.bits_per_sample.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&(pcm_length as u32).to_le_bytes());
    h
}

fn read_at(path: &Path, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut done = 0usize;
    while done < buf.len() {
        match file.read(&mut buf[done..]) {
            Ok(0) => break,
            Ok(n) => done += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(done)
}

/// 只切出"上次到现在"的 PCM 增量，返回 (本次写出的字节数, 这段在音频时间轴上的起点)。
/// 没有新音频返回 None；头部不可解析也必须 None —— 退化成正好会把前面的内容重转一遍。
pub fn extract_audio_chunk(src: &Path, dst: &Path, offset: u64) -> Option<(u64, u64)> {
    let size = std::fs::metadata(src).ok()?.len();
    let head_len = (4096usize.min(size as usize)).max(1);
    let mut head = vec![0u8; head_len];
    let got = read_at(src, 0, &mut head).ok()?;
    head.truncate(got);

    let info = parse_wav_header(&head)?;
    let available = size.checked_sub(info.data_offset as u64)?;
    if available <= offset {
        return None;
    }
    let mut take = available - offset;
    // 对齐到采样边界，避免切出半个采样点
    let frame = ((info.bits_per_sample / 8) as u64 * info.channels as u64).max(1);
    take -= take % frame;
    if take == 0 {
        return None;
    }
    let mut slice = vec![0u8; take as usize];
    if read_at(src, info.data_offset as u64 + offset, &mut slice).ok()? != take as usize {
        return None;
    }
    let mut out = build_wav_header(take, &info);
    out.extend_from_slice(&slice);
    std::fs::write(dst, out).ok()?;
    // byteRate 为 0 只可能来自畸形头部，按 0 去除会算出天文数字的时间轴
    let start_ms = (offset as f64 / info.byte_rate.max(1) as f64 * 1000.0).round() as u64;
    Some((take, start_ms))
}

// ---------- 转录片段与摘要 ----------

fn add_segment(app: &AppHandle, text: &str, audio_start_ms: Option<u64>) {
    let now = chrono::Utc::now().timestamp_millis();
    // 增量切块后段落的起点应落在音频时间轴上；STT 返回有快有慢，用完成时刻会串位
    let start_ms = match audio_start_ms {
        Some(ms) => ms,
        None => {
            let started = field(&state_of(), "startedAt");
            let ms = chrono::DateTime::parse_from_rfc3339(&started)
                .map(|d| d.timestamp_millis())
                .unwrap_or(now);
            (now - ms).max(0) as u64
        }
    };
    let rid = uuid::Uuid::new_v4().simple().to_string();
    let segment = json!({
        "id": format!("seg_{now}_{}", &rid[..4]),
        "text": text,
        "timestamp": store::now_iso(),
        "startMs": start_ms,
    });
    update_state(app, |st| {
        if let Some(arr) = st.get_mut("segments").and_then(|v| v.as_array_mut()) {
            arr.push(segment.clone());
        }
    });
    broadcast(app, "meeting:segment", &segment);
}

/// 滚动摘要 prompt（逐字照搬，改文案会让模型输出风格漂移）
pub fn rolling_prompt(previous: &str, recent: &str) -> String {
    format!(
        "你是一个会议摘要助手。以下是最近的会议转录片段，请用 3-5 句话总结当前讨论的核心内容。\
如果之前已有摘要，请在此基础上增量更新。\n\n之前的摘要:\n{}\n\n最近的转录:\n{}\n\n请输出新的累计摘要（中文，简洁）:",
        if previous.is_empty() { "（暂无）" } else { previous },
        recent
    )
}

/// 结尾总结 prompt
pub fn final_prompt(transcript: &str) -> String {
    format!(
        "你是会议总结助手。请根据以下会议转录，输出结构化的最终总结：\n\n## 要点\n\
（用 3-6 条项目符号列出关键讨论点）\n\n## 行动项\n\
（用列表列出具体行动项和负责人，若没有明确负责人则写\"待定\"）\n\n会议转录:\n{transcript}"
    )
}

/// 非流式问一次模型，两处摘要共用
async fn ask(system: &str, user: &str) -> Result<String, String> {
    let cfg = state::load_config();
    let provider = ai::provider_from_config(&cfg);
    let req = ai::ChatRequest {
        // 空串 = 走 resolve_model 的 aiModel || modelName，与 Electron 取值顺序一致
        model: ai::resolve_model("", &cfg, &provider),
        messages: vec![
            ai::Message { role: "system".into(), content: system.into(), images: None },
            ai::Message { role: "user".into(), content: user.into(), images: None },
        ],
        stream: Some(false),
        tools: None,
    };
    ai::chat(&provider, &req).await.map(|r| r.content)
}

/// 每 5 段更新一次滚动摘要
async fn update_rolling_summary(app: &AppHandle) {
    let st = state_of();
    let segments = match st.get("segments").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => return,
    };
    if segments.is_empty() || segments.len() % SUMMARY_EVERY != 0 {
        return;
    }
    let recent: Vec<String> = segments
        .iter()
        .rev()
        .take(SUMMARY_WINDOW)
        .rev()
        .filter_map(|s| s.get("text").and_then(|t| t.as_str()).map(|t| t.to_string()))
        .collect();
    let previous = field(&st, "rollingSummary");
    let prompt = rolling_prompt(&previous, &recent.join("\n"));
    match ask("你是会议摘要助手，输出简洁的中文摘要。", &prompt).await {
        Ok(content) => {
            update_state(app, |st| st["rollingSummary"] = json!(content.clone()));
            // 渲染层拿到的是裸字符串，不是对象
            broadcast(app, "meeting:rollingSummary", &json!(content));
        }
        Err(e) => eprintln!("[Meeting] 滚动摘要失败: {e}"),
    }
}

/// `[mm:ss] 正文`，段间空一行
pub fn transcript_text(segments: &[Value]) -> String {
    segments
        .iter()
        .map(|s| {
            let start_ms = s.get("startMs").and_then(|v| v.as_u64()).unwrap_or(0);
            let m = start_ms / 60_000;
            let sec = (start_ms % 60_000) / 1000;
            format!(
                "[{m:02}:{sec:02}] {}",
                s.get("text").and_then(|t| t.as_str()).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn transcript_file_body(
    title: &str,
    started_at: &str,
    ended_at: &str,
    transcript: &str,
    rolling: &str,
) -> String {
    format!("# {title}\n时间: {started_at} - {ended_at}\n\n{transcript}\n\n# 滚动摘要\n{rolling}\n")
}

// ---------- 音频捕获 ----------

/// 与 Electron 的 spawnAudioCapture 逐参对齐：16k 单声道，直接写 wav
#[cfg(windows)]
pub fn capture_args(out: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "dshow".into(),
        "-i".into(),
        "audio=virtual-audio-capturer".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-y".into(),
        out.into(),
    ]
}

#[cfg(target_os = "macos")]
pub fn capture_args(out: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "avfoundation".into(),
        "-i".into(),
        ":0".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-y".into(),
        out.into(),
    ]
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn capture_args(out: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "pulse".into(),
        "-i".into(),
        "default".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-y".into(),
        out.into(),
    ]
}

/// 起 ffmpeg；进程起不来（没装 ffmpeg）在这里返回 Err
fn spawn_capture(out: &Path) -> Result<Capture, String> {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(capture_args(&out.to_string_lossy()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(pipe) = child.stderr.take() {
        // 缓冲存全文：只留尾部会截掉 dyld 的标识前缀，展示时再截
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut reader = pipe;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut g = match sink.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        if g.chars().count() < 4000 {
                            g.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    Ok(Capture {
        child: Arc::new(Mutex::new(child)),
        stderr,
        stopping: Arc::new(AtomicBool::new(false)),
        stop: Arc::new(AtomicBool::new(false)),
    })
}

/// 看门狗：捕获进程自己退出就把会议判死。
/// 原来没人监听 close，ffmpeg 一死会议就永远停在 recording 且 0 段（静默失败）。
fn watch_capture(app: AppHandle, cap: &Capture) {
    let child = Arc::clone(&cap.child);
    let stopping = Arc::clone(&cap.stopping);
    let stderr = Arc::clone(&cap.stderr);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let exited = match child.lock() {
            Ok(mut c) => c.try_wait().ok().flatten(),
            Err(_) => break,
        };
        let Some(code) = exited else { continue };
        if stopping.load(Ordering::SeqCst) {
            break;
        }
        let text = stderr.lock().map(|g| g.clone()).unwrap_or_default();
        fail_capture(&app, capture_exit_reason(code.code().unwrap_or(-1), &text));
        break;
    });
}

/// 切块循环：每 10 秒一段，只把新增音频送去转写
fn spawn_chunk_loop(app: AppHandle, id: String, wav: PathBuf, stop: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        let mut index: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(CHUNK_INTERVAL_MS)).await;
            if stop.load(Ordering::SeqCst) || status() != "recording" {
                break;
            }
            index += 1;
            let chunk = meetings_dir().join(format!("{id}_chunk_{index}.wav"));
            let offset = CHUNK_OFFSET.load(Ordering::SeqCst);
            let Some((bytes, start_ms)) = extract_audio_chunk(&wav, &chunk, offset) else {
                continue;
            };
            CHUNK_OFFSET.store(offset + bytes, Ordering::SeqCst);
            if std::fs::metadata(&chunk).map(|m| m.len()).unwrap_or(0) <= MIN_CHUNK_BYTES {
                let _ = std::fs::remove_file(&chunk);
                continue;
            }
            let audio = match std::fs::read(&chunk) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[Meeting] 切块读取失败: {e}");
                    continue;
                }
            };
            let encoded = data_encoding::BASE64.encode(&audio);
            match voice::transcribe(&encoded, STT_BUDGET).await {
                Ok(text) if !text.trim().is_empty() => {
                    let trimmed = text.trim().to_string();
                    add_segment(&app, &trimmed, Some(start_ms));
                    update_rolling_summary(&app).await;
                }
                Ok(_) => {}
                Err(e) => eprintln!("[Meeting] 转录块失败: {e}"),
            }
            let _ = std::fs::remove_file(&chunk);
        }
    });
}

// ---------- 结束流程 ----------

async fn end_meeting(app: &AppHandle) -> Result<Value, String> {
    if status() != "recording" {
        return Ok(state_of());
    }
    update_state(app, |st| st["status"] = json!("processing"));
    shutdown_capture();

    let ended_at = store::now_iso();
    update_state(app, |st| st["endedAt"] = json!(ended_at.clone()));

    let st = state_of();
    let segments = segments_of();
    if segments.is_empty() {
        // 一段都没转出来时总结毫无意义；原来仍会去调 AI，还把 fetch 失败当"总结"回给用户
        let existing = field(&st, "error");
        let reason = if existing.is_empty() {
            "本次会议没有转录到任何内容：音频捕获未取到数据，或 STT 服务不可用（检查 ffmpeg 与 whisper 模型）"
                .to_string()
        } else {
            existing
        };
        update_state(app, |st| {
            st["status"] = json!("error");
            st["error"] = json!(reason);
        });
        return Ok(state_of());
    }

    let transcript = transcript_text(&segments);
    let body = transcript_file_body(
        &field(&st, "title"),
        &field(&st, "startedAt"),
        &ended_at,
        &transcript,
        &field(&st, "rollingSummary"),
    );
    let path = meetings_dir().join(format!("{}.txt", field(&st, "id")));
    std::fs::write(&path, body.as_bytes()).map_err(|e| e.to_string())?;
    let shown = path.to_string_lossy().to_string();
    update_state(app, |st| st["transcriptPath"] = json!(shown.clone()));

    // 总结失败也要给出转录位置，不能把会议卡在 processing。
    // 追加写失败同样算失败：Electron 的 catch 覆盖的就是同一个字段。
    let prompt = final_prompt(&transcript);
    let summary = match ask("你是会议总结助手。", &prompt).await {
        Ok(content) => match append_summary(&path, &content) {
            Ok(()) => content,
            Err(e) => format!("总结生成失败: 转录追加失败: {e}\n\n请查看完整转录: {shown}"),
        },
        Err(e) => format!("总结生成失败: {e}\n\n请查看完整转录: {shown}"),
    };
    update_state(app, |st| {
        st["finalSummary"] = json!(summary);
        st["status"] = json!("done");
    });
    Ok(state_of())
}

fn append_summary(path: &Path, content: &str) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new().append(true).open(path)?;
    file.write_all(format!("\n\n# 最终总结\n{content}\n").as_bytes())
}

// ---------- 端点（channel 名与 Electron 一致）----------

/// Electron: meeting:start —— `{success, state}` / `{success:false, error}`
#[tauri::command]
pub async fn meeting_start(app: AppHandle, title: String) -> Value {
    if status() == "recording" {
        return json!({ "success": false, "error": "会议已在进行中" });
    }
    if let Err(e) = std::fs::create_dir_all(meetings_dir()) {
        return json!({ "success": false, "error": format!("无法创建会议目录: {e}") });
    }
    CHUNK_OFFSET.store(0, Ordering::SeqCst);
    let id = format!("meeting_{}", chrono::Utc::now().timestamp_millis());
    let title = if title.trim().is_empty() {
        format!("会议 {}", chrono::Local::now().format("%Y/%m/%d %H:%M:%S"))
    } else {
        title
    };
    let fresh = json!({
        "id": id,
        "title": title,
        "startedAt": store::now_iso(),
        "segments": [],
        "rollingSummary": "",
        "status": "recording",
    });
    if let Ok(mut g) = MEETING.lock() {
        *g = Some(fresh.clone());
    }

    let wav = meetings_dir().join(format!("{id}.wav"));
    let cap = match spawn_capture(&wav) {
        Ok(cap) => cap,
        Err(e) => {
            // 状态里给完整指引，返回值只给原始原因（Electron 的 throw e 就是这个形状）
            let decorated = format!("无法启动音频捕获: {e}。请安装 sox (brew install sox) 或 ffmpeg");
            update_state(&app, |st| {
                st["status"] = json!("error");
                st["error"] = json!(decorated);
            });
            return json!({ "success": false, "error": e });
        }
    };
    let stop = Arc::clone(&cap.stop);
    watch_capture(app.clone(), &cap);
    if let Ok(mut g) = CAPTURE.lock() {
        *g = Some(cap);
    }
    broadcast(&app, "meeting:state", &fresh);
    spawn_chunk_loop(app, id, wav, stop);
    json!({ "success": true, "state": state_of() })
}

/// Electron: meeting:end
#[tauri::command]
pub async fn meeting_end(app: AppHandle) -> Value {
    match end_meeting(&app).await {
        Ok(st) => json!({ "success": true, "state": st }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Electron: meeting:cancel —— 无条件回 idle
#[tauri::command]
pub fn meeting_cancel(app: AppHandle) -> Value {
    shutdown_capture();
    if let Ok(mut g) = MEETING.lock() {
        *g = None;
    }
    broadcast(&app, "meeting:state", &idle_state());
    json!({ "success": true })
}

/// Electron: meeting:getState —— 裸状态对象，不包 success
#[tauri::command]
pub fn meeting_get_state() -> Value {
    state_of()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> WavInfo {
        WavInfo { data_offset: 44, byte_rate: 32000, bits_per_sample: 16, channels: 1, sample_rate: 16000 }
    }

    /// 造一个 16k 单声道 16 bit 的 wav，PCM 内容按 i%251 递增，方便核对切片位置
    fn make_wav(pcm: &[u8]) -> Vec<u8> {
        let mut out = build_wav_header(pcm.len() as u64, &info());
        out.extend_from_slice(pcm);
        out
    }

    fn temp_case(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zbot-meeting-{}-{}",
            name,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("临时目录");
        dir
    }

    #[test]
    fn wav_header_walks_past_extra_blocks() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&[1, 0, 1, 0]); // PCM, 单声道
        buf.extend_from_slice(&16000u32.to_le_bytes());
        buf.extend_from_slice(&32000u32.to_le_bytes()); // byteRate
        buf.extend_from_slice(&[2, 0]); // blockAlign
        buf.extend_from_slice(&[16, 0]); // bits
        // fmt 之后还有一块奇数长度的 LIST，正文 5 字节 + 1 个补位，所以 data 落在 50
        buf.extend_from_slice(b"LIST");
        buf.extend_from_slice(&5u32.to_le_bytes());
        buf.extend_from_slice(b"INFO!x");
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&8u32.to_le_bytes());

        let parsed = parse_wav_header(&buf).expect("必须解析出 data 块");
        assert_eq!(
            parsed,
            WavInfo { data_offset: 58, byte_rate: 32000, bits_per_sample: 16, channels: 1, sample_rate: 16000 }
        );
    }

    #[test]
    fn wav_header_rejects_non_riff_and_truncation() {
        assert_eq!(parse_wav_header(b"not a wav file at all"), None);
        assert_eq!(parse_wav_header(b"RIFF"), None);
        // fmt 之后没有 data 块
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_wav_header(&buf), None, "size=0 必须停下，不能死循环");
    }

    #[test]
    fn rebuilt_header_round_trips() {
        let h = build_wav_header(3200, &info());
        assert_eq!(h.len(), 44);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32_at(&h, 4), 36 + 3200, "RIFF 长度算的是头之后全部字节");
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[36..40], b"data");
        assert_eq!(u32_at(&h, 40), 3200);
        assert_eq!(parse_wav_header(&h).unwrap(), info());
    }

    #[test]
    fn chunk_reads_only_the_new_pcm() {
        let dir = temp_case("increment");
        let src = dir.join("m.wav");
        let dst = dir.join("chunk.wav");
        let pcm: Vec<u8> = (0..1000usize).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, make_wav(&pcm)).unwrap();

        // 第二段：只拿 offset 500 之后的部分，时间轴按 byteRate 推
        let (bytes, start_ms) = extract_audio_chunk(&src, &dst, 500).expect("有增量就必须切出一块");
        assert_eq!(bytes, 500);
        assert_eq!(start_ms, 16, "500 B / 32000 B/s = 15.625 ms");
        let out = std::fs::read(&dst).unwrap();
        assert_eq!(out.len(), 44 + 500);
        assert_eq!(&out[44..], &pcm[500..], "切片内容必须正好从上次停下的地方继续");

        // 已经没有新音频
        assert_eq!(extract_audio_chunk(&src, &dst, 1000), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunk_cuts_to_sample_boundary_and_skips_unparsable_files() {
        let dir = temp_case("align");
        let src = dir.join("m.wav");
        let dst = dir.join("chunk.wav");

        // 奇数字节：半个采样点必须丢掉，否则 whisper 会把这一字节当新采样读
        std::fs::write(&src, make_wav(&(0..1001u32).map(|i| i as u8).collect::<Vec<u8>>())).unwrap();
        let (bytes, _) = extract_audio_chunk(&src, &dst, 0).unwrap();
        assert_eq!(bytes, 1000);

        // 头部解析不了就整块跳过：退化成正好会把前面所有音频重转一遍
        let junk = dir.join("junk.wav");
        std::fs::write(&junk, vec![0u8; 200]).unwrap();
        let out = dir.join("from-junk.wav");
        assert_eq!(extract_audio_chunk(&junk, &out, 0), None);
        assert!(!out.exists(), "跳过的块不能留下半个文件");

        // 空文件 / 不存在
        assert_eq!(extract_audio_chunk(&dir.join("nope.wav"), &out, 0), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_lines_use_padded_audio_time() {
        let segments = vec![
            json!({ "startMs": 0, "text": "开始" }),
            json!({ "startMs": 70_000, "text": "一分钟前" }),
            json!({ "startMs": 3_661_000, "text": "一小时" }),
            json!({ "text": "没有时间轴就按 0 记" }),
        ];
        assert_eq!(
            transcript_text(&segments),
            "[00:00] 开始\n\n[01:10] 一分钟前\n\n[61:01] 一小时\n\n[00:00] 没有时间轴就按 0 记"
        );
    }

    #[test]
    fn transcript_file_keeps_the_electron_sections() {
        let body = transcript_file_body("周会", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", "[00:00] 甲", "摘要");
        assert_eq!(
            body,
            "# 周会\n时间: 2026-01-01T00:00:00.000Z - 2026-01-01T01:00:00.000Z\n\n[00:00] 甲\n\n# 滚动摘要\n摘要\n"
        );
    }

    #[test]
    fn prompts_keep_the_electron_wording() {
        let first = rolling_prompt("", "甲\n乙");
        assert!(first.starts_with("你是一个会议摘要助手。以下是最近的会议转录片段，请用 3-5 句话总结当前讨论的核心内容。"));
        assert!(first.contains("\n\n之前的摘要:\n（暂无）\n\n最近的转录:\n甲\n乙\n\n请输出新的累计摘要（中文，简洁）:"));
        // 有前文时是增量更新，不是"暂无"
        assert!(rolling_prompt("已有摘要", "甲").contains("之前的摘要:\n已有摘要"));

        let last = final_prompt("转录正文");
        assert!(last.starts_with("你是会议总结助手。请根据以下会议转录，输出结构化的最终总结：\n\n## 要点\n"));
        // 这里的引号是半角，逐字来自 meeting-transcriber.ts:266
        assert!(last.contains("（用列表列出具体行动项和负责人，若没有明确负责人则写\"待定\"）\n\n会议转录:\n转录正文"));
    }

    #[test]
    fn capture_wants_16k_mono_wav() {
        let args = capture_args("C:/tmp/m.wav");
        assert_eq!(args.last().unwrap(), "C:/tmp/m.wav");
        assert!(args.windows(2).any(|w| w[0] == "-ac" && w[1] == "1"));
        assert!(args.windows(2).any(|w| w[0] == "-ar" && w[1] == "16000"));
        assert!(args.iter().any(|a| a == "-y"), "重名文件必须直接覆盖");
        #[cfg(windows)]
        assert_eq!(&args[2..4], ["-i".to_string(), "audio=virtual-audio-capturer".to_string()]);
        #[cfg(windows)]
        assert_eq!(&args[0..2], ["-f".to_string(), "dshow".to_string()], "Windows 走 dshow");
    }

    #[test]
    fn exit_reason_distinguishes_broken_ffmpeg_from_silence() {
        let dyld = capture_exit_reason(1, "dyld: Library not loaded: /usr/local/opt/x/liby.dylib");
        assert!(dyld.contains("音频捕获进程意外退出 (code=1)。"), "{dyld}");
        assert!(dyld.contains("ffmpeg 安装已损坏（动态库缺失），需重装 ffmpeg"), "{dyld}");

        let noisy = capture_exit_reason(
            1,
            "some device\n    error line with 空格\n",
        );
        assert!(noisy.starts_with("音频捕获进程意外退出 (code=1)。 some device error line with 空格"), "{noisy}");

        let silent = capture_exit_reason(-1, "   \n ");
        assert!(silent.ends_with("请检查麦克风/系统音频权限与 ffmpeg 是否可用"), "{silent}");
    }

    #[test]
    fn tail_collapse_flattens_whitespace_runs() {
        let long: String = (0..400).map(|i| if i % 7 == 0 { '\n' } else { 'x' }).collect();
        let out = collapse_tail(&long, 200);
        assert_eq!(out.chars().count(), 200);
        assert!(!out.contains('\n'));
        assert!(!out.contains("  "), "连续空白要压成一个空格");
    }

    #[test]
    fn state_starts_idle_and_holds_no_segments() {
        let st = state_of();
        assert_eq!(st.get("status").unwrap().as_str().unwrap(), "idle");
        assert_eq!(st.get("segments").unwrap().as_array().unwrap().len(), 0);
        // 渲染层按 key 是否存在决定要不要显示"结束时间"，未结束时不能出现 endedAt
        assert!(st.get("endedAt").is_none());
    }
}

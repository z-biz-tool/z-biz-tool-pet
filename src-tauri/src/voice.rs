//! 语音（P3）。Electron 的实现是两个 Node sidecar —— stt.js :8084 / tts.js :8086，
//! 主进程只做 HTTP 代理（token 只存在于主进程）。纯 Rust 路线把 sidecar 去掉：
//! 本进程直接驱动 whisper-cli / ffmpeg / PowerShell System.Speech，不再占端口、
//! 不再需要一次性 token，端点的返回形状保持不变。
//!
//! 唯一有意的偏离：Electron 的 error 字段是 `服务返回 503: {"error":"…"}` 这种 HTTP
//! 包装串；没有 HTTP 层之后直接给底层原因文本，字段类型和位置不变。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::state;
use crate::store;
use crate::tools::run_captured;

const STT_PORT: u16 = 8084;
const TTS_PORT: u16 = 8086;
/// Electron 侧 postJson 的默认预算就是 60s（sidecar 内部对子进程不设超时）
const STT_BUDGET: Duration = Duration::from_secs(60);
const TTS_BUDGET: Duration = Duration::from_secs(60);
/// 转码/压缩这类辅助进程不给满额，失败要快
const FFMPEG_BUDGET: Duration = Duration::from_secs(30);
/// powershell「成功」退出却留下一个只有头的 wav 是实测踩过的坑（64 B）
const MIN_TTS_BYTES: u64 = 1000;
const MAX_TTS_TEXT: usize = 2000;

static B64: data_encoding::Encoding = data_encoding::BASE64;

// ---------- 临时文件：处理完即删（D07 的教训），错误路径也要删 ----------

struct TempFile(PathBuf);

impl TempFile {
    fn new(prefix: &str, ext: &str) -> Self {
        let name = format!(
            "zbot-{prefix}-{}-{}.{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default(),
            &uuid::Uuid::new_v4().simple().to_string()[..8],
            ext.trim_start_matches('.')
        );
        TempFile(std::env::temp_dir().join(name))
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn text(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---------- 纯函数：都能离线测 ----------

/// Buffer.from(x,'base64') 是宽松的：忽略空白、不要求补齐 padding。
/// data_encoding 默认严格，这里把宽松语义补回来，否则录音笔一段带换行的 base64 就整段失败。
pub fn decode_audio_b64(raw: &str) -> Result<Vec<u8>, String> {
    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err("音频为空".to_string());
    }
    let padded = match compact.len() % 4 {
        0 => compact.clone(),
        n => format!("{}{}", compact, "=".repeat(4 - n)),
    };
    B64.decode(padded.as_bytes())
        .or_else(|_| data_encoding::BASE64URL.decode(compact.as_bytes()))
        .map_err(|e| format!("音频 base64 解码失败: {e}"))
}

fn is_wav(buf: &[u8]) -> bool {
    buf.len() > 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WAVE"
}

/// 语速倍率归一到 [0.5, 2]，非法值回退 1（tts.js:98）
pub fn normalize_speed(raw: f64) -> f64 {
    if !raw.is_finite() || raw <= 0.0 {
        return 1.0;
    }
    raw.clamp(0.5, 2.0)
}

/// SAPI 的 Rate 是 -10..10 的对数档位，倍率 1 对应 0（tts.js:116）
pub fn sapi_rate(speed: f64) -> i32 {
    (10.0 * speed.log2()).round().clamp(-10.0, 10.0) as i32
}

/// PowerShell 单引号字面量：内部单引号翻倍
pub fn ps_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "''"))
}

/// Windows 上可执行文件必须带 .exe —— 按 POSIX 名字找会永远落空，
/// 于是这台机器明明装了 whisper 却一路报不可用（stt.js:34 的注释就是这个坑）
pub fn whisper_bin_name() -> &'static str {
    if cfg!(windows) {
        "whisper-cli.exe"
    } else {
        "whisper-cli"
    }
}

/// 解析顺序：ZBOT_WHISPER_BIN → 随仓库的构建产物（仅调试构建）→ PATH
pub fn resolve_whisper_bin<F>(lookup: F, path_dirs: &[String], exe_dir: Option<&Path>) -> PathBuf
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(v) = lookup("ZBOT_WHISPER_BIN") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    let name = whisper_bin_name();
    // 打包后 Resources 里不放二进制，只有开发态能命中源码树里的 whisper.cpp 构建产物
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("whisper.cpp").join("build").join("bin").join(name);
        if manifest.is_file() {
            return manifest;
        }
    }
    if let Some(dir) = exe_dir {
        let beside = dir.join(name);
        if beside.is_file() {
            return beside;
        }
    }
    for d in path_dirs {
        let p = PathBuf::from(d).join(name);
        if p.is_file() {
            return p;
        }
    }
    // 一路落空时返回随仓库的候选路径，错误信息里能告诉用户去哪儿放
    PathBuf::from(name)
}

fn whisper_bin() -> PathBuf {
    let dirs: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(if cfg!(windows) { ';' } else { ':' })
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    resolve_whisper_bin(|k| std::env::var(k).ok(), &dirs, exe_dir.as_deref())
}

/// 模型选择沿用 config.sttModel（缺省 base），文件名仍是 ggml-<model>.bin
pub fn whisper_model_path(cfg: &Value) -> PathBuf {
    let model = cfg
        .get("sttModel")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("base");
    store::data_dir().join("models").join(format!("ggml-{model}.bin"))
}

/// 缺 bin / 缺模型时的原因文本，与 stt.js 的 missingWhisper 同形
fn missing_whisper(bin: &Path, model: &Path) -> Option<String> {
    if !bin.is_file() {
        return Some(format!(
            "whisper-cli 未找到: {}（可用 ZBOT_WHISPER_BIN 指定）",
            bin.to_string_lossy()
        ));
    }
    if !model.is_file() {
        return Some(format!(
            "whisper 模型未找到: {}，请参考 whisper.cpp/README.md 下载模型",
            model.to_string_lossy()
        ));
    }
    None
}

// ---------- STT ----------

/// 转一段 base64 音频。budget 是单个子进程的超时：语音输入给 60s，会议分块给 15s。
pub async fn transcribe(audio_b64: &str, budget: Duration) -> Result<String, String> {
    let cfg = state::load_config();
    let bin = whisper_bin();
    let model = whisper_model_path(&cfg);
    if let Some(problem) = missing_whisper(&bin, &model) {
        return Err(problem);
    }

    let buffer = decode_audio_b64(audio_b64)?;
    if buffer.is_empty() {
        return Err("音频为空".to_string());
    }

    let wav = TempFile::new("stt", "wav");
    if is_wav(&buffer) {
        // 会议分块本身就是 16k 单声道 wav，再转一次码纯属浪费
        std::fs::write(wav.path(), &buffer).map_err(|e| format!("写入临时文件失败: {e}"))?;
    } else {
        let src = TempFile::new("stt", "webm");
        std::fs::write(src.path(), &buffer).map_err(|e| format!("写入临时文件失败: {e}"))?;
        let args = [
            "-i",
            &src.text(),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &wav.text(),
            "-y",
        ];
        if let Err(e) = run_captured("ffmpeg", &args, FFMPEG_BUDGET).await {
            // webm 必须靠 ffmpeg 转成 16k wav；坏掉/缺失时给出可定位的原因
            let hint = if e.contains("Library not loaded") || e.to_lowercase().contains("dyld") {
                "ffmpeg 安装已损坏（动态库缺失），需重装 ffmpeg，否则语音输入与会议转录不可用"
            } else if e.contains("program not found") || e.contains("系统找不到指定") || e.contains("No such file") {
                "ffmpeg 不可用，无法转换音频"
            } else {
                "ffmpeg 转码失败"
            };
            return Err(format!("{hint}：{}", tail(&e, 300)));
        }
    }

    // 参数逐条照抄 stt.js 的 runWhisper，包括 --no-timestamps 与 -nt 的重复
    let model_text = model.to_string_lossy().to_string();
    let args = [
        "-m",
        &model_text,
        "-f",
        &wav.text(),
        "-l",
        "auto",
        "--no-timestamps",
        "-pp",
        "-nt",
        "-dt",
        "30000",
    ];
    let bin_text = bin.to_string_lossy().to_string();
    match run_captured(&bin_text, &args, budget).await {
        Ok(out) => Ok(out.trim().to_string()),
        Err(e) => Err(format!("Transcription failed：{}", tail(&e, 300))),
    }
}

/// 错误串只保留尾部：子进程的噪声都在末尾，头部永远是固定的 banner
fn tail(s: &str, chars: usize) -> String {
    let owned: String = s.chars().collect();
    if owned.chars().count() <= chars {
        return owned;
    }
    owned.chars().skip(owned.chars().count() - chars).collect()
}

// ---------- TTS ----------

/// SAPI 走 UTF-8 临时文件而不是 stdin：`-NonInteractive` + 管道 stdin 下
/// `[Console]::In.ReadToEnd()` 会读到空串，PowerShell 于是"成功"退出并留下一个
/// 只有头的 wav，上层把静音当成合成成功播了出去（tts.js:152 的注释）。
fn powershell_script(text_file: &str, out_file: &str, speed: f64) -> String {
    let mut lines = vec![
        "$ErrorActionPreference='Stop'".to_string(),
        "Add-Type -AssemblyName System.Speech".to_string(),
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer".to_string(),
    ];
    if speed != 1.0 {
        lines.push(format!("$s.Rate = {}", sapi_rate(speed)));
    }
    lines.extend([
        format!("$s.SetOutputToWaveFile({})", ps_quote(out_file)),
        format!("$t = Get-Content -Raw -Encoding UTF8 {}", ps_quote(text_file)),
        "if ([string]::IsNullOrWhiteSpace($t)) { throw \"文本读取为空\" }".to_string(),
        "$s.Speak($t)".to_string(),
        "$s.Dispose()".to_string(),
    ]);
    lines.join("\n")
}

/// 合成 → 尝试统一转 mp3，ffmpeg 不可用就原样返回。返回 (base64, format)
pub async fn speak(text: &str, voice: Option<&str>, raw_speed: f64) -> Result<(String, String), String> {
    if text.trim().is_empty() {
        return Err("No text provided".to_string());
    }
    let speed = normalize_speed(raw_speed);
    let clipped: String = text.chars().take(MAX_TTS_TEXT).collect();

    let synth = synthesize(&clipped, voice, speed).await?;
    // 引擎产物统一转 mp3；失败不致命，退回原始格式
    let mp3 = TempFile::new("tts", "mp3");
    let conv = run_captured(
        "ffmpeg",
        &["-i", &synth.text(), "-codec:a", "libmp3lame", "-q:a", "4", &mp3.text(), "-y"],
        FFMPEG_BUDGET,
    )
    .await;
    let (file, format) = match conv {
        Ok(_) if mp3.path().is_file() => (mp3.path().to_path_buf(), "mp3"),
        _ => (synth.path().to_path_buf(), synth_format()),
    };
    let bytes = std::fs::read(&file).map_err(|e| format!("Failed to read audio: {e}"))?;
    Ok((B64.encode(&bytes), format.to_string()))
}

fn synth_format() -> &'static str {
    if cfg!(target_os = "macos") {
        "aiff"
    } else {
        "wav"
    }
}

async fn synthesize(text: &str, voice: Option<&str>, speed: f64) -> Result<TempFile, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = voice; // System.Speech 不吃音色名，Electron 也没传
        synthesize_windows(text, speed).await
    }
    #[cfg(target_os = "macos")]
    {
        synthesize_mac(text, voice, speed).await
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        synthesize_linux(text, speed).await
    }
}

#[cfg(target_os = "windows")]
async fn synthesize_windows(text: &str, speed: f64) -> Result<TempFile, String> {
    let txt = TempFile::new("tts", "txt");
    std::fs::write(txt.path(), text).map_err(|e| format!("文本写入失败: {e}"))?;
    let out = TempFile::new("tts", "wav");
    let script = powershell_script(&txt.text(), &out.text(), speed);
    if let Err(e) = run_captured(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        TTS_BUDGET,
    )
    .await
    {
        return Err(format!("powershell 合成失败: {}", tail(&e, 300)));
    }
    let size = out.path().metadata().map(|m| m.len()).unwrap_or(0);
    // 阈值留够余量，宁肯报错也不回一段静音
    if size <= MIN_TTS_BYTES {
        return Err(format!("powershell 产出 {size} B，不足 {MIN_TTS_BYTES} B，按静音失败处理"));
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
async fn synthesize_mac(text: &str, voice: Option<&str>, speed: f64) -> Result<TempFile, String> {
    const ZH: [&str; 3] = ["Ting-Ting", "Mei-Jia", "Sin-ji"];
    let out = TempFile::new("tts", "aiff");
    let picked = match voice {
        Some(v) if !v.is_empty() => Some(v.to_string()),
        _ => {
            let probe = run_captured("say", &["-v", "?"], Duration::from_secs(5)).await.unwrap_or_default();
            ZH.iter().find(|v| probe.contains(**v)).map(|v| v.to_string())
        }
    };
    let mut args: Vec<String> = Vec::new();
    if let Some(v) = &picked {
        args.extend(["-v".to_string(), v.clone()]);
    }
    if speed != 1.0 {
        args.extend(["-r".to_string(), (180.0 * speed).round().to_string()]);
    }
    args.extend(["-o".to_string(), out.text(), text.to_string()]);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_captured("say", &refs, TTS_BUDGET).await.map_err(|e| format!("say 失败: {}", tail(&e, 300)))?;
    Ok(out)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
async fn synthesize_linux(text: &str, speed: f64) -> Result<TempFile, String> {
    let out = TempFile::new("tts", "wav");
    if std::process::Command::new("espeak-ng").arg("--help").output().is_ok() {
        let args: Vec<String> = if speed != 1.0 {
            vec!["-s".into(), (175.0 * speed).round().to_string(), "-w".into(), out.text(), text.into()]
        } else {
            vec!["-w".into(), out.text(), text.into()]
        };
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        return run_captured("espeak-ng", &refs, TTS_BUDGET)
            .await
            .map(|_| out)
            .map_err(|e| format!("espeak-ng 失败: {}", tail(&e, 300)));
    }
    Err("当前平台无可用离线 TTS 引擎".to_string())
}

/// 等价于 Electron 的 hasBinary：只看程序能不能拉起来，不看退出码
/// （`--help`/`-v ?` 这类探活参数在个别版本上返回非 0，但二进制确实是装好的）
fn launches(program: &str, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok()
}

/// 本机有没有可用的合成引擎（对应 Electron 的 engineAvailable）
pub fn tts_engine_ready() -> bool {
    #[cfg(windows)]
    return launches("powershell", &["-NoProfile", "-Command", "exit 0"]);
    #[cfg(target_os = "macos")]
    return launches("say", &["-v", "?"]);
    #[cfg(not(any(windows, target_os = "macos")))]
    return launches("espeak-ng", &["--help"]) || launches("festival", &["--version"]);
}

fn stt_ready() -> bool {
    missing_whisper(&whisper_bin(), &whisper_model_path(&state::load_config())).is_none()
}

// ---------- 端点（channel 名与 Electron 一致）----------

/// Electron: voice:transcribe
#[tauri::command]
pub async fn voice_transcribe(base64_audio: String) -> Value {
    match transcribe(&base64_audio, STT_BUDGET).await {
        Ok(text) => json!({ "success": true, "text": text }),
        Err(e) => {
            eprintln!("[Z-Bot] STT 失败: {e}");
            json!({ "success": false, "error": e })
        }
    }
}

/// Electron: voice:speak —— 语速取自主进程配置，渲染进程伪造不了
#[tauri::command]
pub async fn voice_speak(text: String, voice: Option<String>) -> Value {
    let speed = state::load_config()
        .get("voiceSpeed")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    match speak(&text, voice.as_deref(), speed).await {
        Ok((audio, format)) => json!({ "success": true, "audio": audio, "format": format }),
        Err(e) => {
            eprintln!("[Z-Bot] TTS 失败: {e}");
            json!({ "success": false, "error": e })
        }
    }
}

/// Electron: voice:status —— 没有常驻子进程了，healthy 改成"本机能力是否就绪"，
/// restarts 恒为 0：字段留着是为了不破坏调用方读到的形状
#[tauri::command]
pub fn voice_status() -> Value {
    json!({
        "services": [
            { "name": "stt", "port": STT_PORT, "healthy": stt_ready(), "restarts": 0 },
            { "name": "tts", "port": TTS_PORT, "healthy": tts_engine_ready(), "restarts": 0 },
        ]
    })
}

/// Electron: voice:interrupt —— 两个窗口都要收到
#[tauri::command]
pub fn voice_interrupt(app: AppHandle) -> bool {
    for label in ["pet", "admin"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.emit("voice:interrupt", ());
        }
    }
    true
}

/// Electron: voice:checkMicrophone —— 只有 macOS 需要主动申请权限，
/// 而 Tauri 在 macOS 上把这件事交给了 WKWebView 自己弹框，这里等价返回"可用"
#[tauri::command]
pub fn voice_check_microphone() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decoding_is_as_lenient_as_buffer_from() {
        let raw = "hello 中文!";
        let enc = B64.encode(raw.as_bytes());
        assert!(enc.ends_with("=="), "样本必须带 padding，否则缺 padding 那条断言是空的");
        assert_eq!(decode_audio_b64(&enc).unwrap(), raw.as_bytes());
        // 缺 padding 与夹带换行都要能吃下（Buffer.from 就是这么宽松）
        let unpadded = enc.trim_end_matches('=');
        assert_eq!(decode_audio_b64(unpadded).unwrap(), raw.as_bytes());
        let half = enc.len() / 2;
        let with_newline = format!("{}\n{}", &enc[..half], &enc[half..]);
        assert_eq!(decode_audio_b64(&with_newline).unwrap(), raw.as_bytes());
        assert_eq!(decode_audio_b64("   ").unwrap_err(), "音频为空");
        assert!(decode_audio_b64("!!!!").is_err());
    }

    #[test]
    fn wav_detection_needs_both_magic_words() {
        let mut wav = vec![0u8; 44];
        wav[..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert!(is_wav(&wav));
        assert!(!is_wav(&wav[..12].to_vec()), "刚好 12 字节不算 wav");
        let mut only_riff = wav.clone();
        only_riff[8..12].copy_from_slice(b"XXXX");
        assert!(!is_wav(&only_riff));
        assert!(!is_wav(b"webm...."));
    }

    #[test]
    fn speed_math_matches_tts_js() {
        assert_eq!(normalize_speed(0.0), 1.0);
        assert_eq!(normalize_speed(-3.0), 1.0);
        assert_eq!(normalize_speed(f64::NAN), 1.0);
        assert_eq!(normalize_speed(99.0), 2.0);
        assert_eq!(normalize_speed(0.1), 0.5);
        assert_eq!(normalize_speed(1.0), 1.0);
        // Rate 是 -10..10 的对数档位
        assert_eq!(sapi_rate(1.0), 0);
        assert_eq!(sapi_rate(2.0), 10);
        assert_eq!(sapi_rate(0.5), -10);
        assert_eq!(sapi_rate(1.2), 3);
        assert_eq!(sapi_rate(1.5), 6);
    }

    #[test]
    fn powershell_quoting_and_script_shape() {
        assert_eq!(ps_quote("C:\\a'b.wav"), "'C:\\a''b.wav'");
        let s = powershell_script("in.txt", "out.wav", 1.0);
        assert!(s.contains("$ErrorActionPreference='Stop'"));
        assert!(s.contains("Add-Type -AssemblyName System.Speech"));
        assert!(s.contains("$s.SetOutputToWaveFile('out.wav')"));
        assert!(s.contains("$t = Get-Content -Raw -Encoding UTF8 'in.txt'"));
        assert!(!s.contains("$s.Rate"), "倍速 1 不该动 Rate");
        assert!(powershell_script("a", "b", 1.5).contains("$s.Rate = 6"));
    }

    #[test]
    fn whisper_binary_prefers_env_then_bundled_then_path() {
        let dirs = vec!["/tmp/nope".to_string(), "/usr/local/bin".to_string()];
        let got = resolve_whisper_bin(|k| if k == "ZBOT_WHISPER_BIN" { Some("  /opt/w  ".to_string()) } else { None }, &dirs, None);
        assert_eq!(got, PathBuf::from("  /opt/w  "), "环境变量优先级最高");

        // 空白值等于没设，不能让 PATH 扫描被跳过
        let none = resolve_whisper_bin(|_| Some("   ".to_string()), &dirs, None);
        assert_eq!(none, PathBuf::from(whisper_bin_name()));

        // 真实存在的 PATH 目录要命中
        let dir = std::env::temp_dir();
        let hit = dir.join(whisper_bin_name());
        std::fs::write(&hit, b"x").unwrap();
        let found = resolve_whisper_bin(|_| None, &[dir.to_string_lossy().to_string()], None);
        assert_eq!(found, hit);
        std::fs::remove_file(&hit).unwrap();
    }

    #[test]
    fn model_path_follows_config_and_keeps_ggml_naming() {
        let p = whisper_model_path(&json!({ "sttModel": "small" }));
        assert_eq!(p.file_name().unwrap(), "ggml-small.bin");
        // 只有「空串/缺字段」才回退 base —— Electron 写的是 `sttModel || 'base'`，
        // 空白串是真值会原样用下去。这里保持同形，不做额外的 trim（改了就和旧配置不一致）
        for cfg in [json!({ "sttModel": "" }), json!({}), json!({ "sttModel": null })] {
            assert_eq!(whisper_model_path(&cfg).file_name().unwrap(), "ggml-base.bin", "{cfg}");
        }
        assert!(p.starts_with(store::data_dir()), "模型必须留在 ~/.z-bot/models 里");
    }

    #[test]
    fn missing_whisper_reports_bin_before_model() {
        let problem = missing_whisper(Path::new("no-such-bin"), Path::new("no-such-model"));
        let text = problem.expect("两者都缺时必须先报 bin");
        assert!(text.starts_with("whisper-cli 未找到"), "{text}");
        assert!(text.contains("ZBOT_WHISPER_BIN"), "{text}");
    }

    #[test]
    fn error_tails_are_cut_from_the_end() {
        let long = "头".repeat(400);
        let t = tail(&long, 300);
        assert_eq!(t.chars().count(), 300);
        assert_eq!(tail("short", 300), "short");
    }

    /// 真机冒烟：需要本机装了 PowerShell 语音（Windows）或 say（macOS）。
    /// 默认跳过，`cargo test --lib -- --ignored` 手动跑 —— 单元测试必须能离线跑，
    /// 但"合成出来的到底是不是声音"这种问题只有真机答得了。
    #[tokio::test]
    #[ignore]
    async fn real_engine_produces_audible_audio() {
        let (audio, format) = speak("你好，我是萌宠", None, 1.0).await.expect("本机引擎合成失败");
        let bytes = B64.decode(audio.as_bytes()).expect("返回的不是合法 base64");
        assert!(bytes.len() > MIN_TTS_BYTES as usize, "只有 {len} B，多半是静音", len = bytes.len());
        assert!(["mp3", "wav", "aiff"].contains(&format.as_str()), "未知格式 {format}");
    }

    /// 真机冒烟：whisper 未安装时必须给出可定位的原因，而不是空字符串成功
    #[tokio::test]
    #[ignore]
    async fn stt_reports_a_locatable_reason_when_unavailable() {
        let r = transcribe("aGVsbG8=", STT_BUDGET).await;
        match r {
            Ok(text) => println!("whisper 可用，识别结果: {text:?}"),
            Err(e) => assert!(!e.is_empty() && (e.contains("whisper") || e.contains("ffmpeg") || e.contains("音频")), "{e}"),
        }
    }
}

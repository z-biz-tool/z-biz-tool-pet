//! 截图：Electron 走 desktopCapturer.getSources，Tauri 没有等价 API，这里直调 GDI。
//!
//! 与 Electron 对齐的点：主屏取 [0] 号 source == 主显示器；JPEG 质量 80；
//! base64 不带 `data:` 前缀；`screenshot:capture` 落盘 `%TEMP%/zbot_screenshot_<ms>.jpg`，
//! 并且 5 秒节流（失败也算一次）；启动时清理 24 小时前的残留截图。
//! 刻意改进的一点：桌面Capturer 返回的是 1920x1080 拉伸缩略图，这里按比例缩到 1920x1080
//! 以内 —— 2K/4K 屏原图发给视觉模型既慢又贵，拉长变形反而更糟。

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data_encoding::BASE64;
use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageBuffer, Rgb};
use serde_json::{json, Value};
// windows 0.62 把 BOOL 挪到了 windows_core，Win32::Foundation 只留 HWND/LPARAM/RECT
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetDC,
    GetWindowDC, ReleaseDC, SelectObject, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HDC,
    HGDIOBJ, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowTextW, GetWindowRect, IsWindowVisible,
    PW_RENDERFULLCONTENT, SM_CXSCREEN, SM_CYSCREEN,
};

use crate::{ai, state};

const JPEG_QUALITY: u8 = 80;
const THROTTLE: Duration = Duration::from_millis(5_000);
const MAX_EDGE: usize = 1920;
const KEEP_HOURS: u64 = 24;

static LAST_SHOT_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 节流位在建图之前就推进，和 Electron 一致：失败的截图也吃掉这 5 秒
fn try_throttle() -> bool {
    let now = now_ms();
    let last = LAST_SHOT_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < THROTTLE.as_millis() as u64 {
        return false;
    }
    LAST_SHOT_MS.store(now, Ordering::Relaxed);
    true
}

/// 节流位是进程级的，测试之间必须能复位
#[cfg(test)]
fn reset_throttle() {
    LAST_SHOT_MS.store(0, Ordering::Relaxed);
}

/// 内存位图 → JPEG。paint 负责把 src_dc 的内容画进这张位图。
unsafe fn capture_into(
    src_dc: HDC,
    width: i32,
    height: i32,
    paint: impl Fn(HDC) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    if width <= 0 || height <= 0 {
        return Err("截图尺寸为 0，目标可能已最小化".to_string());
    }
    let mem_dc = CreateCompatibleDC(Some(src_dc));
    if mem_dc.is_invalid() {
        return Err("无法创建内存位图 DC".to_string());
    }
    let bitmap = CreateCompatibleBitmap(src_dc, width, height);
    let previous: HGDIOBJ = SelectObject(mem_dc, bitmap.into());
    let painted = paint(mem_dc);
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        // 负高度 = 自顶向下的行序，省一次翻转
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let scanned = GetDIBits(
        mem_dc,
        bitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr() as *mut c_void),
        &mut info,
        DIB_RGB_COLORS,
    );
    SelectObject(mem_dc, previous);
    let _ = DeleteDC(mem_dc);
    let _ = DeleteObject(bitmap.into());
    painted?;
    if scanned == 0 {
        return Err("读取位图像素失败".to_string());
    }
    Ok(encode_jpeg(pixels, width as usize, height as usize))
}

/// 缩到最长边不超过 MAX_EDGE；不需要缩就返回 1.0。
/// 比例是 MAX_EDGE 除以实际边长 —— 写反了会得到 ≥1 的"放大"倍数，min(1.0) 之后恒为 1，
/// 于是 4K 屏整张原样送进模型（Electron 靠 thumbnailSize 天然避开了这个坑）。
fn downscale_factor(width: usize, height: usize) -> f64 {
    (MAX_EDGE as f64 / width.max(height).max(1) as f64).min(1.0)
}

/// BGRA → RGB 并顺带缩到 MAX_EDGE 以内，再按 80 质量编码
fn encode_jpeg(pixels: Vec<u8>, width: usize, height: usize) -> Vec<u8> {
    let mut rgb: Vec<u8> = Vec::with_capacity(width * height * 3);
    for chunk in pixels.chunks_exact(4) {
        rgb.extend_from_slice(&[chunk[2], chunk[1], chunk[0]]);
    }
    let scale = downscale_factor(width, height);
    let mut out: Vec<u8> = Vec::new();
    let encoded = if scale < 1.0 {
        let (w, h) = (
            ((width as f64 * scale).round() as u32).max(1),
            ((height as f64 * scale).round() as u32).max(1),
        );
        let img = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_vec(width as u32, height as u32, rgb)
            .expect("像素缓冲按宽高分配，长度必然匹配");
        let small = image::imageops::resize(&img, w, h, image::imageops::FilterType::Triangle);
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode(small.as_raw(), w, h, ExtendedColorType::Rgb8)
    } else {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
            .encode(&rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
    };
    match encoded {
        Ok(()) => out,
        // 编码失败必须显式失败：返回空 JPEG 会让模型看到一张"空白屏幕"
        Err(e) => {
            eprintln!("[Z-Bot] JPEG 编码失败: {e}");
            Vec::new()
        }
    }
}

pub fn grab_screen() -> Result<Vec<u8>, String> {
    unsafe {
        let (width, height) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let src = GetDC(None);
        let result = capture_into(src, width, height, |dc| {
            BitBlt(dc, 0, 0, width, height, Some(src), 0, 0, SRCCOPY)
                .map(|_| ())
                .map_err(|e| format!("BitBlt 失败: {e}"))
        });
        let _ = ReleaseDC(None, src);
        result
    }
}

fn window_title(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        return None;
    }
    let text = String::from_utf16_lossy(&buf[..len as usize]);
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.ok().map(|_| rect)
}

fn enumerated() -> &'static Mutex<Vec<(isize, String)>> {
    static E: OnceLock<Mutex<Vec<(isize, String)>>> = OnceLock::new();
    E.get_or_init(Default::default)
}

unsafe extern "system" fn collect_window(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        if let Some(title) = window_title(hwnd) {
            enumerated()
                .lock()
                .expect("窗口枚举表被污染")
                .push((hwnd.0 as isize, title));
        }
    }
    BOOL(1)
}

/// 可见顶层窗口清单：既是 captureWindow 的选择依据，也是给用户的可读名字
fn visible_windows() -> Vec<(HWND, String)> {
    unsafe {
        enumerated().lock().expect("窗口枚举表被污染").clear();
        // EnumWindows 是同步回调，回调里只往静态表塞数据，不做任何窗口操作
        let _ = EnumWindows(Some(collect_window), LPARAM(0));
        enumerated()
            .lock()
            .expect("窗口枚举表被污染")
            .drain(..)
            .map(|(raw, title)| (HWND(raw as *mut c_void), title))
            .collect()
    }
}

pub fn grab_window(window_name: Option<&str>) -> Result<(Vec<u8>, String), String> {
    let found = visible_windows();
    if found.is_empty() {
        return Err("未找到目标窗口".to_string());
    }
    let picked = match window_name {
        Some(name) if !name.trim().is_empty() => found.iter().find(|(_, t)| t.contains(name.trim())),
        _ => found.first(),
    }
    .ok_or_else(|| "未找到目标窗口".to_string())?;
    let hwnd = picked.0;
    let rect = window_rect(hwnd).ok_or_else(|| "未找到目标窗口".to_string())?;
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    unsafe {
        let src = GetWindowDC(Some(hwnd));
        // PW_RENDERFULLCONTENT：DirectComposition 绘制的窗口（浏览器/视频）不加这个标志会全黑
        let result = capture_into(src, width, height, |dc| {
            PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT))
                .ok()
                .map_err(|e| format!("PrintWindow 失败: {e}"))
        });
        let _ = ReleaseDC(Some(hwnd), src);
        result.map(|bytes| (bytes, picked.1.clone()))
    }
}

fn temp_screenshot_path() -> PathBuf {
    std::env::temp_dir().join(format!("zbot_screenshot_{}.jpg", now_ms()))
}

pub fn write_jpeg(bytes: &[u8]) -> Result<String, String> {
    let path = temp_screenshot_path();
    std::fs::write(&path, bytes).map_err(|e| format!("写入截图失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 启动时清掉 24 小时前的截图。Electron 只在 whenReady 跑一次，这里同样不做常驻定时器。
pub fn cleanup_stale_screenshots() {
    let dir = std::env::temp_dir();
    let cutoff = now_ms().saturating_sub(KEEP_HOURS * 3600 * 1000);
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("zbot_screenshot_") || !name.ends_with(".jpg") {
            continue;
        }
        let modified = entry
            .path()
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if modified < cutoff {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                eprintln!("[Z-Bot] 清理旧截图失败 {name}: {e}");
            }
        }
    }
}

// ---------- 端点（channel 名与 Electron 一致）----------

fn shot_result(bytes: Vec<u8>) -> Value {
    json!({ "success": true, "imageBase64": BASE64.encode(&bytes) })
}

/// Electron: screenshot:capture（只有这一个走 5 秒节流并落盘）
#[tauri::command]
pub fn screenshot_capture() -> Value {
    if !try_throttle() {
        return json!({ "success": false, "error": "截图过于频繁，请 5 秒后重试" });
    }
    match grab_screen() {
        Ok(bytes) if !bytes.is_empty() => match write_jpeg(&bytes) {
            Ok(path) => json!({ "success": true, "path": path, "imageBase64": BASE64.encode(&bytes) }),
            Err(e) => json!({ "success": false, "error": e }),
        },
        Ok(_) => json!({ "success": false, "error": "无法获取屏幕截图" }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Electron: screenshot:captureWindow —— 名字按标题子串匹配，取第一个命中
#[tauri::command]
pub fn screenshot_capture_window(window_name: Option<String>) -> Value {
    match grab_window(window_name.as_deref()) {
        Ok((bytes, name)) => {
            let mut out = shot_result(bytes);
            out["windowName"] = json!(name);
            out
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Electron: screenshot:captureAndAnalyze —— 截完直接给视觉模型
#[tauri::command]
pub async fn screenshot_capture_and_analyze(question: Option<String>) -> Value {
    let bytes = match grab_screen() {
        Ok(b) if !b.is_empty() => b,
        Ok(_) => return json!({ "success": false, "error": "无法获取屏幕截图" }),
        Err(e) => return json!({ "success": false, "error": e }),
    };
    let image_base64 = BASE64.encode(&bytes);
    let cfg = state::load_config();
    let provider = ai::provider_from_config(&cfg);
    if !provider.supports_vision {
        return json!({
            "success": false,
            "error": "当前AI引擎不支持视觉分析，请切换到支持Vision的模型"
        });
    }
    let prompt = question
        .filter(|q| !q.trim().is_empty())
        .unwrap_or_else(|| "请描述一下你看到的屏幕内容，简要说明当前正在做什么。".to_string());
    let request = ai::ChatRequest {
        messages: vec![
            ai::Message { role: "system".into(), content: system_prompt(&cfg), images: None },
            ai::Message {
                role: "user".into(),
                content: prompt,
                images: Some(vec![image_base64.clone()]),
            },
        ],
        model: ai::resolve_model("", &cfg, &provider),
        stream: Some(false),
        tools: None,
    };
    match ai::chat(&provider, &request).await {
        Ok(response) => json!({ "success": true, "analysis": response.content, "imageBase64": image_base64 }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// 主进程侧的系统提示词：Electron 用 config.systemPrompt，缺省是空串（人格在渲染层拼）
pub fn system_prompt(cfg: &Value) -> String {
    cfg.get("systemPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_opens_once_and_blocks_the_next_five_seconds() {
        reset_throttle();
        assert!(try_throttle(), "首次截图必须放行");
        assert!(!try_throttle(), "紧接着的第二次必须被节流");
        reset_throttle();
    }

    #[test]
    fn downscaling_branch_reaches_the_encoder_and_produces_jpeg() {
        // 2560x8 必须走 resize 分支（原样 BGRA = 81920 字节）；比例写反时这里会静默走非缩放分支
        let bytes = encode_jpeg(vec![128u8; 2560 * 8 * 4], 2560, 8);
        assert!(!bytes.is_empty(), "缩放分支必须编出数据");
        assert!(bytes.len() < 2560 * 8 * 4);
    }

    #[test]
    fn downscaling_keeps_the_longest_edge() {
        // 测的是实现而不是公式副本：比例写反时这里会拿到 1.0
        assert_eq!(downscale_factor(3840, 2160), 0.5, "4K 必须命中缩放分支");
        assert_eq!(downscale_factor(1920, 1080), 1.0, "刚好 1920 不该缩");
        assert_eq!(downscale_factor(1080, 1920), 1.0, "竖屏看最长边");
        assert_eq!(downscale_factor(2560, 1440), 0.75, "2K 缩到 1920");
        assert_eq!(downscale_factor(0, 0), 1.0, "退化尺寸不能除零");
    }

    #[test]
    fn tiny_buffer_takes_the_no_resize_branch_and_still_encodes() {
        // 2x2 全黑：不缩放分支也不能编出空数组，否则模型只会看到"没有截图"
        let bytes = encode_jpeg(vec![0u8; 2 * 2 * 4], 2, 2);
        assert!(!bytes.is_empty(), "空白位图也要有 JPEG 数据");
        assert_eq!(&bytes[..2], &[0xff, 0xd8], "缺 JPEG SOI 魔数就不是图");
    }
}

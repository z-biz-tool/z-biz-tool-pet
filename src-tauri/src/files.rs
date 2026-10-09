//! 受白名单约束的文件读取：对照 ipc-handlers.ts 的 file:read / file:readAsBase64（T1.7，修复 D05）。
//!
//! 渲染进程给的是任意字符串，命令又是 AI 工具链的一部分，所以路径必须先绝对化、解符号链接，
//! 再判断是否落在白名单目录内；上限两道（10 MB 读盘、5 万字符正文）防止一次读取把窗口卡死。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{security, store};

fn allowed_roots() -> &'static Mutex<Vec<PathBuf>> {
    static ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Electron: refreshAllowedRoots() —— 启动时刷新一次即可，目录不会在运行中凭空出现
pub fn refresh_allowed_roots(app: &AppHandle) {
    let mut extra: Vec<PathBuf> = vec![store::data_dir().join("meetings")];
    if let Ok(userData) = app.path().app_data_dir() {
        extra.push(userData);
    }
    let roots = security::build_allowed_roots(&extra);
    if let Ok(mut guard) = allowed_roots().lock() {
        *guard = roots;
    }
}

fn read_guard(file: &str) -> Result<PathBuf, String> {
    let roots = allowed_roots()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let guard = security::guard_read_path(file, &roots);
    if guard.allowed {
        // guard.resolved 是 to_string_lossy 的绝对路径；Windows 上是宽字符路径的字符串形式
        return Ok(PathBuf::from(guard.resolved.unwrap_or_default()));
    }
    let reason = guard.reason.unwrap_or("未知原因".to_string());
    eprintln!("[Z-Bot Main] 拒绝越权文件访问: {file} {reason}");
    Err(format!("无权访问该路径: {reason}"))
}

fn size_check(path: &PathBuf) -> Result<u64, Value> {
    let meta = std::fs::metadata(path).map_err(|_| {
        json!({ "success": false, "error": "文件不存在" })
    })?;
    if !meta.is_file() {
        return Err(json!({ "success": false, "error": "目标不是文件" }));
    }
    if meta.len() > security::MAX_READ_FILE_BYTES {
        return Err(json!({
            "success": false,
            "error": format!("文件超过 {}MB 限制", security::MAX_READ_FILE_BYTES / 1024 / 1024)
        }));
    }
    Ok(meta.len())
}

fn mime_of(path: &PathBuf) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Electron: file:read —— UTF-8 正文，截到 5 万字符
#[tauri::command]
pub fn file_read(file_path: String) -> Value {
    let path = match read_guard(&file_path) {
        Ok(p) => p,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    if let Err(denied) = size_check(&path) {
        return denied;
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => json!({
            "success": true,
            "content": content.chars().take(security::MAX_TEXT_CHARS).collect::<String>(),
        }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// Electron: file:readAsBase64 —— 截图/图片走 data URL 给 AI 或多模态请求用
#[tauri::command]
pub fn file_read_as_base64(file_path: String) -> Value {
    let path = match read_guard(&file_path) {
        Ok(p) => p,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    if let Err(denied) = size_check(&path) {
        return denied;
    }
    match std::fs::read(&path) {
        Ok(bytes) => {
            let base64 = data_encoding::BASE64.encode(&bytes);
            let mime = mime_of(&path);
            json!({
                "success": true,
                "base64": base64,
                "mimeType": mime,
                "dataUrl": format!("data:{mime};base64,{base64}"),
            })
        }
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单只在建根时算一次，测试里直接改写它，避免依赖真实 app 句柄
    fn set_roots(roots: &[PathBuf]) {
        *allowed_roots().lock().unwrap() = roots.to_vec();
    }

    #[test]
    fn reads_only_inside_the_whitelist() {
        let _g = crate::lock_test_env();
        let base = std::env::temp_dir().join(format!("z-bot-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let inside = base.join("note.txt");
        std::fs::write(&inside, "你好，Z-Bot").unwrap();
        set_roots(&[base.clone()]);

        let ok = file_read(inside.to_string_lossy().to_string());
        assert_eq!(ok["success"], json!(true), "{ok}");
        assert_eq!(ok["content"], json!("你好，Z-Bot"));

        let outside = std::env::temp_dir().join("definitely-not-allowed.txt");
        let denied = file_read(outside.to_string_lossy().to_string());
        assert_eq!(denied["success"], json!(false), "白名单外必须拒绝");
        assert!(denied["error"].as_str().unwrap().contains("无权访问"));

        // 存在性与大小检查同样走 { success:false }，不是抛错
        let missing = file_read(base.join("gone.txt").to_string_lossy().to_string());
        assert_eq!(missing["error"], json!("文件不存在"));
        let _ = std::fs::remove_dir_all(&base);
        set_roots(&[]);
    }

    #[test]
    fn base64_carries_a_data_url_and_mime_type() {
        let _g = crate::lock_test_env();
        let base = std::env::temp_dir().join(format!("z-bot-b64-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let png = base.join("pixel.PNG");
        // 1x1 透明 PNG 的头几个字节足够验证 MIME 是按扩展名判的
        std::fs::write(&png, [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        set_roots(&[base.clone()]);

        let r = file_read_as_base64(png.to_string_lossy().to_string());
        assert_eq!(r["success"], json!(true), "{r}");
        assert_eq!(r["mimeType"], json!("image/png"), "扩展名大写也要认");
        assert!(r["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(r["base64"], json!("iVBORw0KGgo="));
        let _ = std::fs::remove_dir_all(&base);
        set_roots(&[]);
    }
}

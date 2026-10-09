//! 子进程日志收集与渲染进程日志转发，对应 config-store.ts 的 appendServerLog。
//!
//! 保留的两条行为：单文件 5 MB 后整体滚成 `<name>.log.1`（只留一份历史），
//! 以及"写日志失败绝不能影响主流程"—— 所以这里所有错误都被吞掉，只打印一行。

use std::io::Write;
use std::path::PathBuf;

use crate::store;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// 文件名由渲染进程传入（stt / tts / 以后可能的技能），必须先过白名单：
/// 否则 `../../x` 之类的名字能把日志写到数据目录外面去。
fn log_file(name: &str) -> Option<PathBuf> {
    let ok = !name.is_empty()
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if ok {
        Some(store::log_dir().join(format!("{name}.log")))
    } else {
        None
    }
}

pub fn append_server_log(name: &str, line: &str) {
    let Some(path) = log_file(name) else {
        eprintln!("[Z-Bot] 非法日志名，已忽略: {name}");
        return;
    };
    if let Err(e) = write_line(&path, line) {
        eprintln!("[Z-Bot] 写日志失败 {}: {}", path.display(), e);
    }
}

fn write_line(path: &PathBuf, line: &str) -> Result<(), String> {
    store::ensure_data_dir()?;
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            let rotated = format!("{}.1", path.display());
            let _ = std::fs::rename(path, &rotated);
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    // 与 Electron 版同样的行格式，管理端"日志"页和 grep 习惯都不用改
    writeln!(f, "[{}] {}", store::now_iso(), line).map_err(|e| e.to_string())
}

/// 渲染进程 console 的落点。Electron 版是 ipcRenderer.send('log') → 主进程 console.log；
/// Tauri 打包后的 exe 没有控制台，所以 stdout 之外再补一份 app.log，出问题才有东西可查。
#[tauri::command]
pub fn console_log(message: String) {
    println!("[Renderer] {message}");
    append_server_log("app", &message);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("z-bot-log-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        dir
    }

    #[test]
    fn rejects_path_traversal_in_log_name() {
        let _g = crate::lock_test_env();
        let dir = isolated("evil");
        append_server_log("../../escape", "x");
        append_server_log("STT", "x"); // 大写不在白名单
        append_server_log("", "x");
        let logs = store::log_dir();
        let outside = std::path::Path::new(&dir).parent().unwrap().join("escape.log");
        assert!(!outside.exists(), "日志名里的 .. 必须被拒绝");
        assert!(!logs.join("STT.log").exists());
        assert!(!logs.join(".log").exists());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn appends_timestamped_lines_under_logs_dir() {
        let _g = crate::lock_test_env();
        let dir = isolated("append");
        let _ = std::fs::remove_dir_all(&dir);
        append_server_log("stt", "loading model");
        append_server_log("stt", "ready");
        let text = std::fs::read_to_string(store::log_dir().join("stt.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with('[') && lines[0].contains("] loading model"), "{lines:?}");
        assert!(lines[1].contains("ready"));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn rotates_once_at_the_size_cap() {
        let _g = crate::lock_test_env();
        let dir = isolated("rotate");
        let _ = std::fs::remove_dir_all(&dir);
        store::ensure_data_dir().unwrap();
        let path = store::log_dir().join("tts.log");
        std::fs::write(&path, "x".repeat(MAX_LOG_BYTES as usize + 1)).unwrap();
        append_server_log("tts", "after rotate");
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
        assert!(store::log_dir().join("tts.log.1").exists(), "超限应滚出一份历史");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

//! 自动更新（P3）。
//!
//! Electron 用 electron-updater（generic provider + latest.yml + quitAndInstall）。
//! Tauri 侧的对等物是 tauri-plugin-updater，但它要求发布产物带 minisign 签名，
//! 而组织里目前唯一接了更新的公司兄弟仓库（z-biz-tool-file）走的是另一条更朴素的路线：
//! 直接查 GitHub Releases → 下载安装包到 ~/Downloads → 交给用户跑安装器。
//! 这里沿用兄弟仓库那条已经在组织里跑通的路子，同时保留 Z-Bot 自己的端点契约
//! （UpdateCheckResult 的 status 枚举与 reason 文案是设置面板直接读的）。
//!
//! 发布源解析优先级与 Electron 一致：ZBOT_UPDATE_FEED_URL → ~/.z-bot/update-feed.json。
//! 没配发布源时只回报原因，不发请求。

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::store;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_REPO: &str = "z-biz-tool/z-biz-tool-pet";
const FEED_FILE: &str = "update-feed.json";
/// 检查请求的预算：更新检查跑在后台，不该把 UI 卡住
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 上一次检查的结果，供 update:status 读取（Electron 的 lastResult）
static LAST: Mutex<Option<Value>> = Mutex::new(None);

fn set_last(app: &AppHandle, result: &Value) {
    if let Ok(mut g) = LAST.lock() {
        *g = Some(result.clone());
    }
    // Electron 用 sendToWindows 广播给两个窗口，channel 名不变
    for label in ["pet", "admin"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.emit("update:status", &result);
        }
    }
}

fn last_result() -> Value {
    LAST.lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| json!({ "ok": false, "status": "no-feed", "reason": "尚未检查更新" }))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Feed {
    pub url: String,
    pub channel: Option<String>,
}

fn is_http(url: &str) -> bool {
    let u = url.trim().to_lowercase();
    u.starts_with("http://") || u.starts_with("https://")
}

/// 纯函数版 readFeed：环境变量优先，其次配置文件。非法/缺失一律 None（不报错，
/// Electron 也是只 warn 后回 null）
pub fn feed_from_values(env_url: Option<&str>, file: Option<&Value>) -> Option<Feed> {
    if let Some(raw) = env_url.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if is_http(raw) {
            return Some(Feed { url: raw.to_string(), channel: None });
        }
    }
    let file = file?;
    let url = file.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if !is_http(&url) {
        return None;
    }
    Some(Feed { url, channel: file.get("channel").and_then(|v| v.as_str()).map(|s| s.to_string()) })
}

fn read_feed() -> Option<Feed> {
    let path: PathBuf = store::data_dir().join(FEED_FILE);
    let text = std::fs::read_to_string(&path).ok();
    let parsed = text.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok());
    feed_from_values(std::env::var("ZBOT_UPDATE_FEED_URL").ok().as_deref(), parsed.as_ref())
}

/// 版本号比较（a.b.c，缺位当 0）—— 与 z-biz-tool-file 的 is_newer_version 同规则
pub fn is_newer_version(new: &str, old: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.').filter_map(|s| s.trim().parse::<u64>().ok()).collect()
    };
    let n = parse(new.trim_start_matches('v'));
    let o = parse(old.trim_start_matches('v'));
    for i in 0..n.len().max(o.len()) {
        let a = *n.get(i).unwrap_or(&0);
        let b = *o.get(i).unwrap_or(&0);
        if a > b {
            return true;
        }
        if a < b {
            return false;
        }
    }
    false
}

/// electron-builder 的 latest.yml 只要两行就够：version 与 path
pub fn parse_latest_yml(text: &str) -> Option<(String, Option<String>)> {
    let mut version = None;
    let mut path = None;
    for line in text.lines() {
        let line = line.trim_end();
        if let Some(v) = line.strip_prefix("version:") {
            version.get_or_insert_with(|| v.trim().trim_matches('"').to_string());
        } else if let Some(v) = line.strip_prefix("path:") {
            path.get_or_insert_with(|| v.trim().trim_matches('"').to_string());
        }
    }
    version.map(|v| (v, path))
}

/// GitHub Releases API 的响应里取版本号。
/// 空白 tag 必须算"没有版本"，否则设置面板会显示一个空格当版本号。
pub fn version_from_release(json: &Value) -> Option<String> {
    json.get("tag_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_start_matches('v').trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 本平台安装包的关键字。NSIS 产物是 `*-setup.exe`，兄弟仓库那种 msi.zip 也认。
pub fn asset_hint() -> (&'static str, &'static str) {
    #[cfg(windows)]
    {
        ("x64", "-setup.exe")
    }
    #[cfg(target_os = "macos")]
    {
        ("universal", ".dmg")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ("x86_64", ".AppImage")
    }
}

/// 安装包大小没进清单，这里只保留下载真正需要的三样
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub version: String,
    pub name: String,
    pub url: String,
}

/// 从 release 的 assets 里挑出本平台的安装包
pub fn pick_asset(release: &Value) -> Option<(String, String)> {
    let (arch, ext) = asset_hint();
    let assets = release.get("assets")?.as_array()?;
    let hit = assets.iter().find(|a| {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        name.ends_with(ext) && name.contains(arch)
    })?;
    Some((
        hit.get("name").and_then(|v| v.as_str()).unwrap_or("update").to_string(),
        hit.get("browser_download_url").and_then(|v| v.as_str())?.to_string(),
    ))
}

/// generic 源里 path 是相对清单本身的，所以产物一定和 latest.yml 同目录
pub fn generic_asset(manifest_url: &str, path: &str) -> (String, String) {
    let dir = manifest_url.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    (name, format!("{dir}/{path}"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .user_agent(concat!("z-biz-tool-pet-updater/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// 下载不能用整体 timeout：几十 MB 的安装包 15 秒根本走不完，只约束"连不上"这一件事。
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CHECK_TIMEOUT)
        .user_agent(concat!("z-biz-tool-pet-updater/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// 是 GitHub 源（仓库名或 API 地址）吗
fn is_github_feed(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("api.github.com") || u.contains("github.com")
}

/// 把发布源 URL 归一成"清单地址"：GitHub 用 API，generic 目录补 /latest.yml
pub fn manifest_url(feed: &Feed) -> String {
    let base = feed.url.trim_end_matches('/');
    if is_github_feed(base) {
        if base.contains("api.github.com") {
            return format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
        }
        // github.com/<owner>/<repo> 这类写法也接受，直接换成 API
        let segs: Vec<&str> = base
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.")
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        if segs.len() >= 3 {
            return format!("https://api.github.com/repos/{}/{}/releases/latest", segs[1], segs[2]);
        }
        return format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    }
    let channel = feed.channel.clone().unwrap_or_else(|| "latest".to_string());
    if base.ends_with(".yml") || base.ends_with(".yaml") {
        return base.to_string();
    }
    format!("{base}/{channel}/latest.yml")
}

/// 下载目标目录：沿用兄弟仓库的 ~/Downloads，用户看得见
pub fn downloads_dir() -> PathBuf {
    dirs::home_dir().map(|h| h.join("Downloads")).unwrap_or_else(std::env::temp_dir)
}

/// 检查更新。返回的就是渲染层要显示的 UpdateCheckResult。
pub async fn check(app: &AppHandle) -> Value {
    // Tauri 侧的"开发模式"就是调试构建：Electron 用 app.isPackaged
    if cfg!(debug_assertions) {
        return set_and_return(app, json!({
            "ok": false,
            "status": "dev-mode",
            "reason": "开发模式下不检查更新（调试构建没有安装器可替换）",
        }));
    }
    let Some(feed) = read_feed() else {
        return set_and_return(app, json!({
            "ok": false,
            "status": "no-feed",
            "reason": "未配置发布源：设置 ZBOT_UPDATE_FEED_URL 或 ~/.z-bot/update-feed.json",
        }));
    };

    let url = manifest_url(&feed);
    let result = do_check(&url, is_github_feed(&url)).await;
    set_and_return(app, result)
}

async fn do_check(url: &str, github: bool) -> Value {
    let http = match client() {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };
    let mut req = http.get(url);
    if github {
        req = req.header("Accept", "application/vnd.github+json");
    }
    let body = match req.send().await {
        Ok(resp) => match resp.error_for_status() {
            Ok(resp) => resp.text().await.unwrap_or_default(),
            Err(e) => return err_result(format!("发布源返回错误: {e}")),
        },
        Err(e) => return err_result(format!("查询发布源失败: {e}（请检查网络）")),
    };

    let (latest, asset) = if github {
        let parsed: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => return err_result(format!("解析发布源失败: {e}")),
        };
        let version = match version_from_release(&parsed) {
            Some(v) => v,
            None => return err_result("发布源响应里没有 tag_name"),
        };
        (version, pick_asset(&parsed))
    } else {
        match parse_latest_yml(&body) {
            Some((version, path)) => {
                // 安装包地址 = 清单所在目录 + path 字段；再剥一层会指到上一级，下载必 404
                (version, path.map(|p| generic_asset(url, &p)))
            }
            None => return err_result("清单里找不到 version 字段"),
        }
    };

    if is_newer_version(&latest, CURRENT_VERSION) {
        set_pending(asset.map(|(name, url)| Pending { version: latest.clone(), name, url }));
        json!({ "ok": true, "status": "available", "version": latest })
    } else {
        set_pending(None);
        json!({ "ok": true, "status": "not-available", "version": latest })
    }
}

fn err_result(reason: impl Into<String>) -> Value {
    let reason: String = reason.into();
    json!({ "ok": false, "status": "error", "reason": reason.chars().take(200).collect::<String>() })
}

/// 命中新版本时记下安装包，install 要用它的下载地址
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn set_pending(p: Option<Pending>) {
    if let Ok(mut g) = PENDING.lock() {
        *g = p;
    }
}

fn pending_installer() -> Option<Pending> {
    PENDING.lock().ok().and_then(|g| g.clone())
}

/// 下载并交给系统安装器。Electron 这里是 quitAndInstall，Tauri 侧在没有签名的前提下
/// 做不到静默替换，所以按兄弟仓库的做法：下载到 ~/Downloads，然后唤起安装器。
pub async fn install(app: &AppHandle) -> Value {
    if cfg!(debug_assertions) {
        return json!({ "ok": false, "reason": "开发模式下不可用" });
    }
    let Some(pending) = pending_installer() else {
        return json!({ "ok": false, "reason": "没有可下载的安装包：请先检查更新，并确认发布源里有本平台的安装包" });
    };
    let dest = downloads_dir().join(&pending.name);
    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return json!({ "ok": false, "reason": format!("创建下载目录失败: {e}") });
        }
    }
    match download_to(&pending.url, &dest, app).await {
        Ok(bytes) => {
            set_and_return(
                app,
                json!({ "ok": true, "status": "downloaded", "version": pending.version }),
            );
            let shown = dest.to_string_lossy().to_string();
            if let Err(e) = open_installer(&shown) {
                return json!({ "ok": false, "reason": format!("安装已下载({bytes} B)但无法自动打开: {e}；文件在 {shown}") });
            }
            json!({ "ok": true, "reason": format!("安装已下载: {shown}") })
        }
        Err(e) => json!({ "ok": false, "reason": e }),
    }
}

async fn download_to(url: &str, dest: &PathBuf, app: &AppHandle) -> Result<u64, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let http = download_client()?;
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut got: u64 = 0;
    let mut last_percent: i64 = -1;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
        got += chunk.len() as u64;
        if total > 0 {
            let percent = ((got as f64 / total as f64) * 100.0).round() as i64;
            if percent != last_percent {
                last_percent = percent;
                // Electron 的 update:progress 渲染层没接，但形状保持一致
                for label in ["pet", "admin"] {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.emit("update:progress", json!({ "percent": percent }));
                    }
                }
            }
        }
    }
    file.flush().map_err(|e| format!("写入失败: {e}"))?;
    Ok(got)
}

/// 唤起下载好的安装包。NSIS 允许覆盖安装，正在运行的进程由安装器自己处理。
fn open_installer(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/d", "/s", "/c", "start", "", path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("本平台需要手动运行下载的安装包".to_string())
    }
}

fn set_and_return(app: &AppHandle, result: Value) -> Value {
    set_last(app, &result);
    result
}

// ---------- 端点（channel 名与 Electron 一致）----------

/// Electron: update:check
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Value {
    check(&app).await
}

/// Electron: update:status
#[tauri::command]
pub fn update_status() -> Value {
    last_result()
}

/// Electron: update:install
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Value {
    install(&app).await
}

/// 启动 5 秒后自动检查一次（Electron 在 index.ts:276 做同一件事）
pub fn schedule_startup_check(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        check(&handle).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_prefers_env_then_file() {
        let env = feed_from_values(Some(" https://nas.local/zbot "), None);
        assert_eq!(env.unwrap().url, "https://nas.local/zbot");

        // 非 http 的环境变量要落回文件，而不是当成有效源
        let from_file = feed_from_values(
            Some("ftp://nope"),
            Some(&json!({ "url": "https://nas.local/zbot", "channel": "beta" })),
        );
        assert_eq!(from_file.unwrap(), Feed { url: "https://nas.local/zbot".into(), channel: Some("beta".into()) });

        assert_eq!(feed_from_values(Some(""), Some(&json!({ "url": "not-a-url" }))), None);
        assert_eq!(feed_from_values(None, None), None);
        assert_eq!(feed_from_values(None, Some(&json!({ "url": "  " }))), None);
    }

    #[test]
    fn version_compare_is_the_sibling_rule() {
        assert!(is_newer_version("1.0.3", "1.0.2"));
        assert!(is_newer_version("v1.1.0", "1.0.9"));
        assert!(is_newer_version("2.0", "1.9.9"));
        assert!(!is_newer_version("1.0.2", "1.0.2"));
        assert!(!is_newer_version("1.0.1", "1.0.2"));
        assert!(!is_newer_version("1.0", "1.0.0"));
        // 脏版本号（非数字段）按缺位 0 处理，不能 panic
        assert!(!is_newer_version("1.0-beta", "1.0.0"));
    }

    #[test]
    fn latest_yml_gives_version_and_path() {
        let yml = "version: 9.9.9\nfiles:\n  - url: z-biz-tool-pet_9.9.9_x64-setup.exe\npath: z-biz-tool-pet_9.9.9_x64-setup.exe\nsha512: aaa\n";
        let (v, p) = parse_latest_yml(yml).unwrap();
        assert_eq!(v, "9.9.9");
        assert_eq!(p.unwrap(), "z-biz-tool-pet_9.9.9_x64-setup.exe");
        assert!(parse_latest_yml("foo: bar").is_none(), "没有 version 就不能算清单");
    }

    #[test]
    fn github_tag_needs_the_v_stripped() {
        assert_eq!(version_from_release(&json!({ "tag_name": "v1.2.3" })), Some("1.2.3".to_string()));
        assert_eq!(version_from_release(&json!({})), None);
        assert_eq!(version_from_release(&json!({ "tag_name": "  " })), None);
    }

    #[test]
    fn manifest_url_normalizes_both_feed_shapes() {
        let gh = Feed { url: "https://github.com/z-biz-tool/z-biz-tool-pet".into(), channel: None };
        assert_eq!(manifest_url(&gh), "https://api.github.com/repos/z-biz-tool/z-biz-tool-pet/releases/latest");
        let api = Feed { url: "https://api.github.com/repos/x/y/releases/latest".into(), channel: None };
        assert_eq!(manifest_url(&api), "https://api.github.com/repos/z-biz-tool/z-biz-tool-pet/releases/latest");
        let dir = Feed { url: "https://nas.local/zbot".into(), channel: Some("beta".into()) };
        assert_eq!(manifest_url(&dir), "https://nas.local/zbot/beta/latest.yml");
        let direct = Feed { url: "https://nas.local/zbot/latest.yml".into(), channel: None };
        assert_eq!(manifest_url(&direct), "https://nas.local/zbot/latest.yml");
    }

    #[test]
    fn asset_picker_wants_this_platforms_installer() {
        let (arch, ext) = asset_hint();
        let name = format!("z-biz-tool-pet_1.0.2_{arch}{ext}");
        let release = json!({ "assets": [
            { "name": "source.zip", "browser_download_url": "https://x/src", "size": 1 },
            { "name": name.clone(), "browser_download_url": "https://x/setup", "size": 42 },
        ]});
        assert_eq!(pick_asset(&release).expect("必须命中本平台安装包"), (name, "https://x/setup".to_string()));
        assert!(pick_asset(&json!({ "assets": [] })).is_none());
    }

    #[test]
    fn generic_installer_sits_next_to_the_manifest() {
        // path 是相对 latest.yml 的：往下剥一层目录就会 404
        let (name, url) = generic_asset(
            "https://nas.local/zbot/beta/latest.yml",
            "z-biz-tool-pet_1.0.3_x64-setup.exe",
        );
        assert_eq!(name, "z-biz-tool-pet_1.0.3_x64-setup.exe");
        assert_eq!(url, "https://nas.local/zbot/beta/z-biz-tool-pet_1.0.3_x64-setup.exe");

        // 直接给 .yml 当源时目录就是它自己那一层
        let (_, url) = generic_asset("https://nas.local/zbot/latest.yml", "sub/a-setup.exe");
        assert_eq!(url, "https://nas.local/zbot/sub/a-setup.exe");
    }

    #[test]
    fn status_starts_with_a_reason_instead_of_a_panic() {
        // 首次调用前 LAST 是空的，渲染层要拿到 no-feed 而不是 undefined
        assert_eq!(last_result().get("status").unwrap().as_str().unwrap(), "no-feed");
        assert!(last_result().get("reason").is_some());
    }
}

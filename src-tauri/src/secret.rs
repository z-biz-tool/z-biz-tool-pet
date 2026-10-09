//! API 密钥的本地加密存储：AES-256-GCM，密文形如 `enc:v1:<base64(nonce|ct|tag)>`。
//!
//! 方案与 z-biz-tool-mind 的 secret.rs 保持一致（主密钥 `master.key` 与密文同目录、
//! 0600），因为这就是本家族现在的标准做法，而不是 Electron 的 safeStorage。
//!
//! 明确一处能力差异，别当成 bug：Electron 版在 Windows 上把密钥交给 DPAPI，绑的是
//! "这台机器 + 这个登录用户"。DPAPI 的 entropy 是 Chromium 内部常量，Tauri 侧复现它
//! 等于依赖一个没有契约的实现细节，所以不搬。后果是老 Z-Bot 的 `api_key.enc` 在这里
//! 读不出来，换壳后需要重新填一次密钥；`{"plain": ...}` 这种降级格式（Linux 无钥匙环时
//! Electron 写的那份）仍能直接导入。

use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::Value;

use crate::store;

const PREFIX: &str = "enc:v1:";
/// Electron 降级格式里的键名，兼容读取用
const LEGACY_FILE: &str = "api_key.enc";
pub const API_KEY: &str = "aiApiKey";

fn secrets_path() -> PathBuf {
    store::data_dir().join("secrets.json")
}
fn master_key_path() -> PathBuf {
    store::data_dir().join("master.key")
}

fn write_master_key(path: &PathBuf, b64: &str) -> Result<(), String> {
    store::ensure_data_dir()?;
    std::fs::write(path, b64).map_err(|e| format!("写入失败 {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 取主密钥；不存在则随机生成并落盘。
fn master_key() -> Result<[u8; 32], String> {
    let path = master_key_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        let bytes = data_encoding::BASE64
            .decode(text.trim().as_bytes())
            .map_err(|e| format!("master.key 解析失败: {}", e))?;
        if bytes.len() != 32 {
            return Err("master.key 长度不是 32 字节".to_string());
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&bytes);
        return Ok(k);
    }
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).map_err(|e| format!("生成主密钥失败: {}", e))?;
    write_master_key(&path, &data_encoding::BASE64.encode(&k))?;
    Ok(k)
}

fn encrypt(plain: &str) -> Result<String, String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("密钥无效: {}", e))?;
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("生成随机数失败: {}", e))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|_| "加密失败".to_string())?;
    let mut blob = Vec::with_capacity(12 + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(format!("{}{}", PREFIX, data_encoding::BASE64.encode(&blob)))
}

fn decrypt(encoded: &str) -> Result<String, String> {
    let body = encoded
        .strip_prefix(PREFIX)
        .ok_or_else(|| "密文缺少 enc:v1: 前缀".to_string())?;
    let blob = data_encoding::BASE64
        .decode(body.as_bytes())
        .map_err(|e| format!("密文 base64 解析失败: {}", e))?;
    if blob.len() < 12 + 16 {
        return Err("密文长度不足".to_string());
    }
    let (nonce, ct) = blob.split_at(12);
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("密钥无效: {}", e))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "解密失败（master.key 可能已更换）".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("明文非 UTF-8: {}", e))
}

fn load_map() -> serde_json::Map<String, Value> {
    let v = store::read(&secrets_path(), Value::Object(serde_json::Map::new()));
    v.as_object().cloned().unwrap_or_default()
}

fn save_map(map: &serde_json::Map<String, Value>) -> Result<(), String> {
    store::write(&secrets_path(), Value::Object(map.clone()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            secrets_path(),
            std::fs::Permissions::from_mode(0o600),
        );
    }
    Ok(())
}

pub fn put(name: &str, value: &str) -> Result<(), String> {
    let mut map = load_map();
    map.insert(name.to_string(), Value::String(encrypt(value)?));
    save_map(&map)
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    let map = load_map();
    if let Some(s) = map.get(name).and_then(|v| v.as_str()) {
        return decrypt(s).map(Some);
    }
    // 老 Z-Bot 的降级明文格式只对应 API 密钥这一项，导入一次之后就只走密文
    if name == API_KEY {
        if let Some(legacy) = legacy_plain() {
            if !legacy.is_empty() {
                let mut map = map;
                map.insert(name.to_string(), Value::String(encrypt(&legacy)?));
                save_map(&map)?;
                return Ok(Some(legacy));
            }
        }
    }
    Ok(None)
}

fn legacy_plain() -> Option<String> {
    let path = store::data_dir().join(LEGACY_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("plain")?
        .as_str()
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("z-bot-secret-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("ZBOT_DATA_DIR", &dir);
        dir
    }

    #[test]
    fn roundtrip_is_nonce_unique() {
        let _g = crate::lock_test_env();
        let dir = isolated("roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let a = encrypt("sk-test-123").expect("加密应成功");
        let b = encrypt("sk-test-123").expect("第二次也应成功");
        assert!(a.starts_with(PREFIX));
        assert_ne!(a, b, "随机 nonce 应让同一明文产生不同密文");
        assert_eq!(decrypt(&a).unwrap(), "sk-test-123");
        assert!(decrypt("没有前缀").is_err());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn put_and_get() {
        let _g = crate::lock_test_env();
        let dir = isolated("put");
        let _ = std::fs::remove_dir_all(&dir);
        store::invalidate(&secrets_path());
        put(API_KEY, "sk-abcdef").expect("写入应成功");
        assert_eq!(get(API_KEY).unwrap().as_deref(), Some("sk-abcdef"));
        // 落盘文件里不能出现明文
        let raw = std::fs::read_to_string(secrets_path()).unwrap();
        assert!(!raw.contains("sk-abcdef"), "secrets.json 里出现了明文");
        assert!(master_key_path().exists(), "master.key 应自动生成");
        assert_eq!(get("unrelated").unwrap(), None, "别的名字不该读到 API 密钥");
        // 换名重写不清掉旧值：config:save 每次保存都会覆盖 API_KEY，但历史项要留着
        put("other", "x").unwrap();
        store::invalidate(&secrets_path());
        assert_eq!(get(API_KEY).unwrap().as_deref(), Some("sk-abcdef"));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }

    #[test]
    fn legacy_plaintext_file_is_imported() {
        let _g = crate::lock_test_env();
        let dir = isolated("legacy");
        let _ = std::fs::remove_dir_all(&dir);
        store::ensure_data_dir().unwrap();
        std::fs::write(store::data_dir().join(LEGACY_FILE), r#"{"plain":"sk-old"}"#).unwrap();
        store::invalidate(&secrets_path());
        assert_eq!(get(API_KEY).unwrap().as_deref(), Some("sk-old"));
        // 导入后即便老文件还在，也应走密文分支（换个目录里的 master.key 会解不开）
        assert!(secrets_path().exists());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("ZBOT_DATA_DIR");
    }
}

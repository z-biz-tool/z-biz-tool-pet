//! 工具频率限制与熔断：对照 src/main/tool-limiter.ts（T4.6）。
//!
//! 阈值原样保留：60s 窗口 12 次、连续 3 次失败熔断 30s、单轮最多 8 次。
//! 与 Electron 的差别只有一处：`release` 不再是 `calls.pop()`。
//! Electron 靠"确认串行执行"才让 LIFO 弹出成立，Rust 侧 run_tool_calls 虽然是
//! 串行 await，但同一工具可能在两个窗口的请求里并发跑，弹出别人的时间戳就是错的账，
//! 所以改成按时间戳精确移除本次 acquire 记下的那一条。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const WINDOW: Duration = Duration::from_millis(60_000);
pub const MAX_CALLS_PER_WINDOW: usize = 12;
pub const FAILURE_THRESHOLD: u32 = 3;
pub const BREAKER_COOLDOWN: Duration = Duration::from_millis(30_000);
pub const MAX_TOOL_CALLS_PER_TURN: usize = 8;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Default)]
struct State {
    calls: Vec<u64>,
    consecutive_failures: u32,
    opened_at: Option<u64>,
}

fn states() -> &'static Mutex<HashMap<String, State>> {
    static S: OnceLock<Mutex<HashMap<String, State>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

#[derive(Debug, Clone)]
pub enum Decision {
    /// 带时间戳票据，拒绝时用它精确归还配额
    Allowed(u64),
    Blocked(String),
}

pub fn acquire(name: &str) -> Decision {
    let now = now_ms();
    let mut map = states().lock().expect("限流表被污染");
    let s = map.entry(name.to_string()).or_default();
    if let Some(opened) = s.opened_at {
        let elapsed = now.saturating_sub(opened);
        if elapsed < BREAKER_COOLDOWN.as_millis() as u64 {
            let left = BREAKER_COOLDOWN.as_millis() as u64 - elapsed;
            return Decision::Blocked(format!(
                "工具 {name} 连续失败 {} 次，已熔断，{}s 后可重试",
                s.consecutive_failures,
                (left + 999) / 1000
            ));
        }
        // 半开：冷却到期就整体复位，让下一次调用去试探
        s.opened_at = None;
        s.consecutive_failures = 0;
        s.calls.clear();
    }
    let window_ms = WINDOW.as_millis() as u64;
    s.calls.retain(|t| now.saturating_sub(*t) < window_ms);
    if s.calls.len() >= MAX_CALLS_PER_WINDOW {
        return Decision::Blocked(format!(
            "工具 {} 在 {}s 内已调用 {} 次，超出频率限制",
            name,
            window_ms / 1000,
            s.calls.len()
        ));
    }
    s.calls.push(now);
    Decision::Allowed(now)
}

/// 用户拒绝时归还本次配额（不是最后一条）
pub fn release(name: &str, ticket: u64) {
    if let Some(s) = states().lock().expect("限流表被污染").get_mut(name) {
        if let Some(pos) = s.calls.iter().position(|t| *t == ticket) {
            s.calls.remove(pos);
        }
    }
}

pub fn record_outcome(name: &str, ok: bool) {
    let now = now_ms();
    let mut map = states().lock().expect("限流表被污染");
    let s = map.entry(name.to_string()).or_default();
    if ok {
        s.consecutive_failures = 0;
        return;
    }
    s.consecutive_failures += 1;
    if s.consecutive_failures >= FAILURE_THRESHOLD && s.opened_at.is_none() {
        s.opened_at = Some(now);
    }
}

/// 清窗（限流表只有测试与"重置会话"会用到）
#[cfg(test)]
pub fn reset(name: Option<&str>) {
    let mut map = states().lock().expect("限流表被污染");
    match name {
        Some(n) => {
            map.remove(n);
        }
        None => map.clear(),
    }
}

#[cfg(test)]
pub fn snapshot(name: &str) -> (usize, u32, bool) {
    let map = states().lock().expect("限流表被污染");
    match map.get(name) {
        Some(s) => (s.calls.len(), s.consecutive_failures, s.opened_at.is_some()),
        None => (0, 0, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_blocks_at_the_twelfth_call() {
        reset(Some("t-window"));
        for i in 0..MAX_CALLS_PER_WINDOW {
            assert!(matches!(acquire("t-window"), Decision::Allowed(_)), "第 {} 次应放行", i + 1);
        }
        match acquire("t-window") {
            Decision::Blocked(reason) => {
                assert!(reason.contains("超出频率限制"), "文案要能给模型看懂: {reason}");
                assert!(reason.contains("60s"));
            }
            Decision::Allowed(_) => panic!("第 13 次必须被限流"),
        }
        reset(Some("t-window"));
    }

    #[test]
    fn rejection_gives_back_only_its_own_slot() {
        reset(Some("t-release"));
        let first = match acquire("t-release") {
            Decision::Allowed(t) => t,
            _ => panic!("首次应放行"),
        };
        let _ = acquire("t-release");
        release("t-release", first);
        let (calls, _, _) = snapshot("t-release");
        assert_eq!(calls, 1, "归还只能拿走自己那一条");
        reset(Some("t-release"));
    }

    #[test]
    fn three_failures_open_the_breaker_and_the_reason_counts_down() {
        reset(Some("t-breaker"));
        for _ in 0..FAILURE_THRESHOLD {
            record_outcome("t-breaker", false);
        }
        match acquire("t-breaker") {
            Decision::Blocked(reason) => {
                assert!(reason.contains("已熔断"), "熔断文案缺失: {reason}");
                assert!(reason.contains("3 次"));
            }
            Decision::Allowed(_) => panic!("连续 3 次失败后必须熔断"),
        }
        record_outcome("t-breaker", true);
        reset(Some("t-breaker"));
    }
}

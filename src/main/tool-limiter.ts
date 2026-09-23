/**
 * 工具调用限流与熔断（doc/优化方案/02 §2.9）。
 * 只统计真正进入执行阶段的调用：被 guard 拒绝或被用户拒绝的不消耗配额。
 * 时间由调用方注入，便于测试确定性推进而不依赖 fake timers。
 */

const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 12;
/** 连续失败达到该值后开启熔断 */
const FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
/** 单轮对话最多执行的工具数，防 AI 自我循环 */
export const MAX_TOOL_CALLS_PER_TURN = 8;

export type LimiterDecision =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfterMs: number };

interface ToolState {
  calls: number[];
  consecutiveFailures: number;
  openedAt: number | null;
}

const states = new Map<string, ToolState>();

function ensure(name: string): ToolState {
  let s = states.get(name);
  if (!s) {
    s = { calls: [], consecutiveFailures: 0, openedAt: null };
    states.set(name, s);
  }
  return s;
}

/** 执行前申请配额；熔断到期时进入半开态（放行一次试探） */
export function acquire(name: string, now = Date.now()): LimiterDecision {
  const s = ensure(name);

  if (s.openedAt !== null) {
    const elapsed = now - s.openedAt;
    if (elapsed < BREAKER_COOLDOWN_MS) {
      return {
        allowed: false,
        reason: `工具 ${name} 连续失败 ${s.consecutiveFailures} 次，已熔断，${Math.ceil(
          (BREAKER_COOLDOWN_MS - elapsed) / 1000
        )}s 后可重试`,
        retryAfterMs: BREAKER_COOLDOWN_MS - elapsed,
      };
    }
    s.openedAt = null;
    s.consecutiveFailures = 0;
    s.calls = [];
  }

  s.calls = s.calls.filter((t) => now - t < WINDOW_MS);
  if (s.calls.length >= MAX_CALLS_PER_WINDOW) {
    const retryAfterMs = WINDOW_MS - (now - s.calls[0]);
    return {
      allowed: false,
      reason: `工具 ${name} 在 ${Math.round(WINDOW_MS / 1000)}s 内已调用 ${s.calls.length} 次，超出频率限制`,
      retryAfterMs,
    };
  }
  s.calls.push(now);
  return { allowed: true };
}

/**
 * 归还一次配额：用户拒绝确认时该调用并未真正执行，不应消耗频率额度。
 * 与 acquire 成对使用（runToolCalls 内串行调用，栈顶即本次 acquire 的入队）。
 */
export function release(name: string): void {
  const s = states.get(name);
  if (s && s.calls.length > 0) s.calls.pop();
}

/** 执行后回报结果：成功清零失败计数，失败累计并在阈值处开启熔断 */
export function recordOutcome(name: string, ok: boolean, now = Date.now()): void {
  const s = ensure(name);
  if (ok) {
    s.consecutiveFailures = 0;
    return;
  }
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD && s.openedAt === null) {
    s.openedAt = now;
  }
}

export function resetLimiter(name?: string): void {
  if (name) states.delete(name);
  else states.clear();
}

/** 供测试与诊断读取的内部状态快照 */
export function limiterSnapshot(name: string): { calls: number; failures: number; open: boolean } {
  const s = states.get(name);
  return {
    calls: s?.calls.length ?? 0,
    failures: s?.consecutiveFailures ?? 0,
    open: s?.openedAt != null,
  };
}

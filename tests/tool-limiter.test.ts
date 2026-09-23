import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquire,
  release,
  recordOutcome,
  resetLimiter,
  limiterSnapshot,
  MAX_TOOL_CALLS_PER_TURN,
} from '../src/main/tool-limiter';

/**
 * 工具限流/熔断单测（doc 02 §2.9）。
 * 时钟由参数注入，不用 fake timers，避免与别的用例互相污染。
 */

const T0 = 1_700_000_000_000;

beforeEach(() => resetLimiter());

describe('频率窗口', () => {
  it('窗口内放行前 12 次，第 13 次拒绝并给出原因', () => {
    for (let i = 0; i < 12; i++) {
      expect(acquire('web_search', T0 + i)).toEqual({ allowed: true });
    }
    const d = acquire('web_search', T0 + 12);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain('超出频率限制');
      expect(d.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('窗口滑过后自动恢复，无需显式重置', () => {
    for (let i = 0; i < 12; i++) acquire('web_search', T0 + i);
    expect(acquire('web_search', T0 + 1000).allowed).toBe(false);
    // 60s 后最早的一次调用移出窗口
    for (let i = 0; i < 12; i++) expect(acquire('web_search', T0 + 60_001 + i).allowed).toBe(true);
  });

  it('按工具名分桶，互不影响', () => {
    for (let i = 0; i < 12; i++) acquire('execute_command', T0 + i);
    expect(acquire('execute_command', T0 + 12).allowed).toBe(false);
    expect(acquire('get_datetime', T0 + 12)).toEqual({ allowed: true });
  });

  it('release 归还配额：用户拒绝确认不该吃掉一次额度', () => {
    for (let i = 0; i < 12; i++) acquire('open_app', T0 + i);
    expect(acquire('open_app', T0 + 12).allowed).toBe(false);
    release('open_app');
    expect(acquire('open_app', T0 + 13)).toEqual({ allowed: true });
  });

  it('release 对不存在的工具是空操作', () => {
    expect(() => release('never_used')).not.toThrow();
    expect(limiterSnapshot('never_used').calls).toBe(0);
  });
});

describe('失败熔断', () => {
  it('连续失败 3 次开启熔断，冷却期内一律拒绝', () => {
    recordOutcome('execute_command', false, T0);
    recordOutcome('execute_command', false, T0 + 1);
    expect(acquire('execute_command', T0 + 2)).toEqual({ allowed: true });
    recordOutcome('execute_command', false, T0 + 3);
    expect(limiterSnapshot('execute_command').open).toBe(true);

    const d = acquire('execute_command', T0 + 4);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('熔断');
  });

  it('成功会清零连续失败计数，不累计成熔断', () => {
    recordOutcome('get_weather', false, T0);
    recordOutcome('get_weather', false, T0 + 1);
    recordOutcome('get_weather', true, T0 + 2);
    recordOutcome('get_weather', false, T0 + 3);
    recordOutcome('get_weather', false, T0 + 4);
    expect(limiterSnapshot('get_weather').open).toBe(false);
    expect(acquire('get_weather', T0 + 5)).toEqual({ allowed: true });
  });

  it('冷却期结束后半开放行一次；再失败则重新熔断', () => {
    for (let i = 0; i < 3; i++) recordOutcome('clipboard_read', false, T0 + i);
    // openedAt 落在最后一次失败（T0+2），冷却 30s 到 T0+30_002 才到期
    expect(acquire('clipboard_read', T0 + 30_001).allowed).toBe(false);
    // 冷却到期：半开，放行一次试探
    expect(acquire('clipboard_read', T0 + 30_002)).toEqual({ allowed: true });
    recordOutcome('clipboard_read', false, T0 + 30_003);
    recordOutcome('clipboard_read', false, T0 + 30_004);
    recordOutcome('clipboard_read', false, T0 + 30_005);
    expect(acquire('clipboard_read', T0 + 30_006).allowed).toBe(false);
    // 恢复成功即彻底关闭熔断
    expect(acquire('clipboard_read', T0 + 61_000).allowed).toBe(true);
    recordOutcome('clipboard_read', true, T0 + 61_001);
    expect(acquire('clipboard_read', T0 + 61_002)).toEqual({ allowed: true });
  });

  it('熔断计数按工具独立，一个工具熔掉不影响其它', () => {
    for (let i = 0; i < 3; i++) recordOutcome('screenshot_analyze', false, T0 + i);
    expect(acquire('screenshot_analyze', T0 + 4).allowed).toBe(false);
    expect(acquire('get_datetime', T0 + 4)).toEqual({ allowed: true });
  });
});

describe('单轮上限', () => {
  it('上限常量存在且留有余量给正常多工具轮次', () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBeGreaterThanOrEqual(5);
    expect(MAX_TOOL_CALLS_PER_TURN).toBeLessThanOrEqual(16);
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

/**
 * TTS 语速映射（voiceSpeed 设置到引擎参数的落点）。
 * 曾经 voiceSpeed 只存在于配置和设置面板里，/speak 从不接收 speed，
 * 三档引擎也拿不到速率参数——即"语速调了没反应"。
 * require 不会占用端口：tts.js 只在作为脚本启动时才 listen。
 */
const require = createRequire(import.meta.url);
const { normalizeSpeed, macWpm, espeakWpm, sapiRate } = require('../server/tts.js');

describe('语速倍率归一', () => {
  it('缺省/非法值回退 1', () => {
    for (const bad of [undefined, null, '', 'abc', 0, -2, NaN, Infinity]) {
      expect(normalizeSpeed(bad)).toBe(1);
    }
  });

  it('裁剪到设置面板的 [0.5, 2.0] 区间', () => {
    expect(normalizeSpeed(1.4)).toBe(1.4);
    expect(normalizeSpeed('1.8')).toBe(1.8);
    expect(normalizeSpeed(9999)).toBe(2);
    expect(normalizeSpeed(0.01)).toBe(0.5);
  });
});

describe('倍率到引擎参数', () => {
  it('macOS say / espeak-ng 用 wpm，且随倍率单调上升', () => {
    expect(macWpm(1)).toBe(180);
    expect(espeakWpm(1)).toBe(175);
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const mac = speeds.map(macWpm);
    const es = speeds.map(espeakWpm);
    for (let i = 1; i < speeds.length; i++) {
      expect(mac[i]).toBeGreaterThan(mac[i - 1]);
      expect(es[i]).toBeGreaterThan(es[i - 1]);
    }
    expect(macWpm(2)).toBe(360);
  });

  it('SAPI 的 Rate 是 -10..10 整数档位，倍率 1 必须是 0（不改语速）', () => {
    expect(sapiRate(1)).toBe(0);
    expect(sapiRate(2)).toBe(10);
    expect(sapiRate(0.5)).toBe(-10);
    for (const s of [0.5, 0.8, 1, 1.3, 2]) {
      expect(Number.isInteger(sapiRate(s))).toBe(true);
      expect(sapiRate(s)).toBeGreaterThanOrEqual(-10);
      expect(sapiRate(s)).toBeLessThanOrEqual(10);
    }
  });
});

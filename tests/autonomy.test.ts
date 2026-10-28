// 自主行为的纯函数回归：间隔抖动、开演条件、beat 清洗。
//
// 这三件事一旦错了，症状都很"软"：间隔不抖她像闹钟；开演条件写漏了
// 会在她说话时插一句；beat 清洗太松会让动画 key 变成 undefined，
// 表现是"点了没反应"—— 现场根本看不出来是哪一层出的问题。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canPerform,
  nextDelayMs,
  sanitizeBeat,
  snapshotForMind,
} from '../src/renderer/pet/companion/autonomy.ts';

describe('间隔调度', () => {
  test('基准上下浮动，不会每次都是同一个数', () => {
    const a = nextDelayMs(120, 0, () => 0);
    const b = nextDelayMs(120, 0, () => 1);
    const mid = nextDelayMs(120, 0, () => 0.5);
    assert.ok(a < mid && mid < b, `抖动方向反了: ${a} ${mid} ${b}`);
    // 120s ±35% ⇒ 78s ~ 162s
    assert.ok(a >= 78_000 && a <= 162_000, `越界: ${a}`);
    assert.ok(b >= 78_000 && b <= 162_000, `越界: ${b}`);
  });

  test('失败退避翻倍，但最多 4 倍', () => {
    const base = nextDelayMs(120, 0, () => 0.5);
    assert.equal(nextDelayMs(120, 1, () => 0.5), base * 2);
    assert.equal(nextDelayMs(120, 2, () => 0.5), base * 4);
    // 再失败也不能无限拉长，否则一次网络抖动会让她沉默一小时
    assert.equal(nextDelayMs(120, 9, () => 0.5), base * 4);
  });

  test('间隔有下限，配置成 1 秒也不会把她变成抽筋', () => {
    assert.ok(nextDelayMs(1, 0, () => 0) >= 30_000 * 0.65);
  });
});

describe('开演条件', () => {
  test('只在 idle 且不在专注模式', () => {
    assert.equal(canPerform('idle', 'normal'), true);
    assert.equal(canPerform('thinking', 'normal'), false);
    assert.equal(canPerform('idle', 'focus'), false);
    assert.equal(canPerform('speaking', 'focus'), false);
  });
});

describe('beat 清洗', () => {
  test('未知动作被丢掉，不是替换成 idle', () => {
    const beat = sanitizeBeat({
      thought: '想',
      emotion: 'happy',
      script: [{ anim: 'teleport', dur: 1000, line: '' }],
    });
    assert.equal(beat, null, '全是非法动作就等于没有可播的东西');
  });

  test('时长被夹到 800~6000ms', () => {
    const beat = sanitizeBeat({
      script: [
        { anim: 'walk', dur: 10, line: '' },
        { anim: 'jump', dur: 99_999, line: '' },
      ],
    });
    assert.deepEqual(
      beat?.script.map((c) => c.dur),
      [800, 6000]
    );
  });

  test('最多 4 步，台词截到 40 字', () => {
    const beat = sanitizeBeat({
      script: Array.from({ length: 8 }, () => ({ anim: 'blink', dur: 1000, line: '啊'.repeat(90) })),
    });
    assert.equal(beat?.script.length, 4);
    assert.equal(beat?.script[0].line.length, 40);
  });

  test('未知情绪回落到 happy，缺失 thought 不炸', () => {
    const beat = sanitizeBeat({ emotion: 'furious', script: [{ anim: 'idle', dur: 1000, line: '' }] });
    assert.equal(beat?.emotion, 'happy');
    assert.equal(beat?.thought, '');
  });

  test('垃圾输入返回 null 而不是抛异常', () => {
    assert.equal(sanitizeBeat(null), null);
    assert.equal(sanitizeBeat('你好'), null);
    assert.equal(sanitizeBeat({ script: 'not-an-array' }), null);
  });
});

describe('处境快照', () => {
  test('毫秒换算成分钟，数值取整', () => {
    const s = snapshotForMind({
      idleMs: 3_600_000,
      mode: 'focus',
      focusMinutes: 42.6,
      affection: 61.4,
      energy: 33.9,
    });
    assert.equal(s.idleMinutes, 60);
    assert.equal(s.mode, 'focus');
    assert.equal(s.focusToday, 43);
    assert.equal(s.affection, 61);
    assert.equal(s.energy, 34);
    assert.equal(s.topic, '');
  });

  test('负数不会传出去（时钟回拨时）', () => {
    const s = snapshotForMind({
      idleMs: -5000,
      mode: 'normal',
      focusMinutes: 0,
      affection: 0,
      energy: 0,
    });
    assert.equal(s.idleMinutes, 0);
  });
});

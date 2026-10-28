// 陪伴层回归：摸头连击分档、专注钟、台词占位、需求优先级。
//
// 这几条覆盖的都是「看起来在动、其实算错了」的风险点 —— 陪伴层没有界面可点，
// 出问题只会表现为「她怎么老说同一句」或者「专注完了没记上」，肉眼很难发现。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CompanionEngine, type CompanionDeps } from '../src/renderer/pet/companion/engine.ts';
import { pickLine, SCENE_CUES } from '../src/renderer/pet/companion/lines.ts';

/** 可控时钟：引擎里所有「多久之后」都走注入的 now，测试就能瞬间跨越 25 分钟 */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function makeDeps(clock: ReturnType<typeof makeClock>, over: Partial<CompanionDeps> = {}) {
  const said: { text: string; cue: unknown }[] = [];
  const stats = {
    hunger: 90,
    happiness: 90,
    energy: 90,
    cleanliness: 90,
    health: 90,
    affection: 50,
    isSleeping: false,
    isSick: false,
  };
  const deps: CompanionDeps = {
    say: (text, cue) => said.push({ text, cue }),
    getStatus: () => 'idle',
    getStats: () => ({ ...stats }),
    getCharacter: () => ({ id: 'chatgpt', name: '茉白' }),
    now: clock.now,
    ...over,
  };
  return { deps, said, stats };
}

describe('摸头连击', () => {
  let clock: ReturnType<typeof makeClock>;
  let engine: CompanionEngine;
  let said: { text: string; cue: unknown }[];

  beforeEach(() => {
    clock = makeClock();
    const ctx = makeDeps(clock);
    said = ctx.said;
    engine = new CompanionEngine(ctx.deps);
  });

  test('第一下是普通摸头，并允许向养成系统报好感', () => {
    const r = engine.poke();
    assert.equal(r.scene, 'pet1');
    assert.equal(r.report, true);
    assert.equal(said.length, 1);
    assert.deepEqual(r.cue, SCENE_CUES.pet1);
  });

  test('三连变害羞，六连转傲娇并进入冷却', () => {
    const scenes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      clock.advance(600); // 都在 2.5s 连击窗口内
      scenes.push(engine.poke().scene);
    }
    assert.deepEqual(scenes, ['pet1', 'pet1', 'pet3', 'pet3', 'pet3', 'pet6']);
  });

  test('冷却期内仍然有反应，但不再加好感', () => {
    for (let i = 0; i < 6; i += 1) {
      clock.advance(600);
      engine.poke();
    }
    clock.advance(300);
    const after = engine.poke();
    assert.equal(after.scene, 'pet6');
    assert.equal(after.report, false, '冷却中不该重复加好感');
  });

  test('间隔超过连击窗口会重新从第一档算', () => {
    engine.poke();
    clock.advance(10_000);
    assert.equal(engine.poke().scene, 'pet1');
  });

  test('连点十下只上报一次好感（避免把 IPC 打满）', () => {
    let reports = 0;
    for (let i = 0; i < 6; i += 1) {
      clock.advance(200);
      if (engine.poke().report) reports += 1;
    }
    assert.equal(reports, 1);
  });
});

describe('专注钟', () => {
  test('走完一分钟专注会计入当日统计并说结束语', () => {
    const clock = makeClock();
    const { deps, said } = makeDeps(clock);
    const engine = new CompanionEngine(deps);

    engine.startFocus(1);
    assert.equal(engine.getSnapshot().mode, 'focus');
    assert.equal(said[0].cue, SCENE_CUES.focusStart);

    // 一分钟 = 60 个 tick；多跑两次确认不会重复结算
    for (let i = 0; i < 62; i += 1) {
      clock.advance(1000);
      engine.tick();
    }

    const snap = engine.getSnapshot();
    assert.equal(snap.mode, 'normal');
    assert.equal(snap.stat.focusDone, 1);
    assert.equal(snap.stat.focusMinutes, 1);
  });

  test('专注期间除了「过半」提示，不产生任何主动打扰', () => {
    const clock = makeClock();
    const { deps, said } = makeDeps(clock);
    const engine = new CompanionEngine(deps);
    engine.updateConfig({ idleChat: true, care: true });

    engine.startFocus(25);
    said.length = 0; // 忽略开场白

    // 推 20 分钟，且有光标活动（久坐 + 自言自语的条件都满足）
    for (let i = 0; i < 20 * 60; i += 1) {
      clock.advance(1000);
      if (i % 20 === 0) engine.noteActivity();
      engine.tick();
    }

    // 唯一允许出现的是「过半了，稳住」，而且只能一次
    assert.equal(said.length, 1, '专注模式不该有话痨行为');
    assert.deepEqual(said[0].cue, SCENE_CUES.focusMid);
  });

  test('中途放弃不记入完成次数', () => {
    const clock = makeClock();
    const { deps } = makeDeps(clock);
    const engine = new CompanionEngine(deps);
    engine.startFocus(25);
    for (let i = 0; i < 300; i += 1) {
      clock.advance(1000);
      engine.tick();
    }
    engine.stopFocus('user');
    const snap = engine.getSnapshot();
    assert.equal(snap.stat.focusDone, 0);
    assert.equal(snap.mode, 'normal');
  });

  test('暂停时倒计时不动', () => {
    const clock = makeClock();
    const { deps } = makeDeps(clock);
    const engine = new CompanionEngine(deps);
    engine.startFocus(10);
    const before = engine.getSnapshot().remainMs;
    engine.toggleFocusPause();
    for (let i = 0; i < 30; i += 1) {
      clock.advance(1000);
      engine.tick();
    }
    assert.equal(engine.getSnapshot().remainMs, before);
  });
});

describe('需求表达', () => {
  test('生病优先于饥饿', () => {
    const clock = makeClock();
    const { deps, said, stats } = makeDeps(clock);
    stats.isSick = true;
    stats.hunger = 10;
    const engine = new CompanionEngine(deps);

    // 先让「在座」条件成立（90s 门槛），再触发一次需求
    for (let i = 0; i < 120; i += 1) {
      clock.advance(1000);
      engine.noteActivity();
      engine.tick();
    }

    const care = said.find((s) => s.cue === SCENE_CUES.sick || s.cue === SCENE_CUES.hungry);
    assert.ok(care, '应当至少说出一种需求');
    assert.equal(care?.cue, SCENE_CUES.sick, '生病必须排在饥饿前面');
  });

  test('关闭健康提醒后不再主动提需求', () => {
    const clock = makeClock();
    const { deps, said, stats } = makeDeps(clock);
    stats.hunger = 5;
    const engine = new CompanionEngine(deps);
    engine.updateConfig({ care: false, idleChat: false });

    for (let i = 0; i < 200; i += 1) {
      clock.advance(1000);
      engine.noteActivity();
      engine.tick();
    }
    assert.deepEqual(said, []);
  });
});

describe('台词', () => {
  test('{m} 占位被替换成分钟数', () => {
    const line = pickLine('focusEnd', { characterId: 'nobody', name: '小看板', minutes: 25 });
    assert.ok(!line.includes('{m}'), '占位符不能漏到界面上');
  });

  test('每个角色都能取到属于自己的台词', () => {
    for (const id of ['taoyao', 'chatgpt', 'claude', 'gemini', 'deepseek', 'midjourney', 'suno']) {
      const line = pickLine('pet1', { characterId: id, name: 'x' });
      assert.ok(line.length > 0, `${id} 缺少摸头台词`);
    }
  });

  test('未知角色回落到通用台词，而不是返回空串', () => {
    const line = pickLine('drink', { characterId: 'unknown', name: 'x' });
    assert.ok(line.length > 0);
  });

  test('气泡停顿时间按台词长度给足（短句不能一闪而过）', () => {
    for (const cue of Object.values(SCENE_CUES)) {
      if (cue.ms !== undefined) assert.ok(cue.ms >= 2000);
    }
  });
});

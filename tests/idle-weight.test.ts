// 空闲动作加权抽样的回归。
//
// 这里验证的不是「某个 rng 会选到某个动作」，而是**趋势**：数值差的时候
// 她该表现出对应的状态（累→伸懒腰/打哈欠，开心→跳舞）。趋势一旦被改坏
// （比如有人把权重表填成全 1），肉眼上只会觉得「她好像没那么活了」，
// 极难发现，所以用大样本统计来钉住方向。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickIdleAnimation, getRandomIdleInterval } from '../src/renderer/pet/animations.ts';

/** 可复现的 rng：线性同余，避免 Math.random 让断言时好时坏 */
function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 抽 n 次，统计各动作出现次数 */
function sample(mood: Parameters<typeof pickIdleAnimation>[0], n = 4000) {
  const rng = makeRng();
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const { anim } = pickIdleAnimation(mood, rng);
    counts.set(anim, (counts.get(anim) ?? 0) + 1);
  }
  return counts;
}

function rate(counts: Map<string, number>, anim: string, total: number): number {
  return (counts.get(anim) ?? 0) / total;
}

describe('空闲动作按数值加权', () => {
  test('样本量守恒：每次抽样都返回一个合法动作', () => {
    const rng = makeRng();
    const valid = new Set([
      'walk', 'dance', 'roll', 'jump', 'wiggle',
      'stretch', 'spin', 'yawn', 'bounce', 'wobble',
    ]);
    for (let i = 0; i < 500; i++) {
      const { anim, weight } = pickIdleAnimation({ energy: 50, happiness: 50, hunger: 50 }, rng);
      assert.ok(valid.has(anim), `非法动作: ${anim}`);
      assert.ok(weight > 0, `权重必须为正（否则抽样会卡死）: ${weight}`);
      assert.ok(Number.isFinite(weight), `权重必须有限: ${weight}`);
    }
  });

  test('同样的 rng 种子 ⇒ 同样的结果（抽样是确定性的）', () => {
    const mood = { energy: 70, happiness: 70, hunger: 70 };
    const a = Array.from({ length: 20 }, (_, i) =>
      pickIdleAnimation(mood, makeRng(1000 + i)).anim
    );
    const b = Array.from({ length: 20 }, (_, i) =>
      pickIdleAnimation(mood, makeRng(1000 + i)).anim
    );
    assert.deepEqual(a, b, '相同种子必须产出相同样本序列');
  });

  test('精力见底 ⇒ 偏向伸懒腰/打哈欠，远离跳跃/旋转', () => {
    const n = 4000;
    const tired = sample({ energy: 5, happiness: 50, hunger: 50 }, n);
    const awake = sample({ energy: 95, happiness: 50, hunger: 50 }, n);

    assert.ok(
      rate(tired, 'yawn', n) > rate(awake, 'yawn', n) * 3,
      `低精力的打哈欠率应当远高于高精力（低=${rate(tired, 'yawn', n).toFixed(3)} 高=${rate(awake, 'yawn', n).toFixed(3)}）`
    );
    assert.ok(
      rate(tired, 'stretch', n) > rate(awake, 'stretch', n) * 2,
      '低精力应当更常伸懒腰'
    );
    assert.ok(
      rate(tired, 'jump', n) < rate(awake, 'jump', n) / 3,
      `低精力不应当活蹦乱跳（低=${rate(tired, 'jump', n).toFixed(3)} 高=${rate(awake, 'jump', n).toFixed(3)}）`
    );
    assert.ok(
      rate(tired, 'spin', n) < rate(awake, 'spin', n) / 3,
      '低精力不应当旋转'
    );
  });

  test('心情高 ⇒ 偏向跳舞，心情低 ⇒ 远离跳舞', () => {
    const n = 4000;
    const happy = sample({ energy: 70, happiness: 98, hunger: 70 }, n);
    const sad = sample({ energy: 70, happiness: 3, hunger: 70 }, n);

    assert.ok(
      rate(happy, 'dance', n) > rate(sad, 'dance', n) * 3,
      `心情好应当更爱跳舞（好=${rate(happy, 'dance', n).toFixed(3)} 差=${rate(sad, 'dance', n).toFixed(3)}）`
    );
  });

  test('饿肚子不该精神抖擞地跳舞（饱食度参与加权）', () => {
    const n = 4000;
    const hungry = sample({ energy: 70, happiness: 90, hunger: 2 }, n);
    const full = sample({ energy: 70, happiness: 90, hunger: 98 }, n);
    // 饿的时候跳舞权重被打折，样本会流向同样高心情的其他动作（如 bounce/walk）
    assert.ok(
      rate(hungry, 'dance', n) < rate(full, 'dance', n),
      `饿肚子应当减少跳舞（饿=${rate(hungry, 'dance', n).toFixed(3)} 饱=${rate(full, 'dance', n).toFixed(3)}）`
    );
  });

  test('缺省数值（未传 mood）不崩溃，且落在「状态良好」的分布上', () => {
    const rng = makeRng();
    const counts = new Map<string, number>();
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const { anim } = pickIdleAnimation({}, rng);
      counts.set(anim, (counts.get(anim) ?? 0) + 1);
    }
    // 缺省 energy/happiness=60，不该出现「全是打哈欠」这种塌缩
    assert.ok(rate(counts, 'yawn', n) < 0.4, '缺省状态不应过度偏向打哈欠');
    assert.ok(counts.size >= 6, `缺省状态应覆盖多种动作，实际只有 ${counts.size} 种`);
  });

  test('非法数值（NaN / 越界）被夹回，不会算出 NaN 权重', () => {
    const rng = makeRng();
    for (let i = 0; i < 200; i++) {
      const { anim, weight } = pickIdleAnimation(
        { energy: NaN, happiness: -50, hunger: 999 },
        rng
      );
      assert.ok(anim.length > 0);
      assert.ok(Number.isFinite(weight) && weight > 0, `NaN 数值产生了坏权重: ${weight}`);
    }
  });
});

describe('空闲间隔随精力变化', () => {
  /** 取多次采样的均值，避免单次随机造成误判 */
  function meanInterval(mood: Parameters<typeof getRandomIdleInterval>[0], n = 500) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += getRandomIdleInterval(mood);
    return sum / n;
  }

  test('精力越低，间隔越长（累的时候不想动）', () => {
    const tired = meanInterval({ energy: 5 });
    const awake = meanInterval({ energy: 95 });
    assert.ok(
      tired > awake,
      `低精力间隔应更长（低=${Math.round(tired)}ms 高=${Math.round(awake)}ms）`
    );
  });

  test('间隔始终落在合理范围，不会出现「一动不动」或「抖个不停」', () => {
    for (const energy of [0, 25, 50, 75, 100]) {
      for (let i = 0; i < 200; i++) {
        const ms = getRandomIdleInterval({ energy });
        assert.ok(ms >= 8000, `间隔过短（${ms}ms），energy=${energy}`);
        assert.ok(ms <= 60_000, `间隔过长（${ms}ms），energy=${energy}`);
      }
    }
  });
});

// 抛掷物理回归：重力下落、反弹封顶、贴地滑行、释放速度估算、抛掷阈值。
//
// 这几条覆盖的都是「手感」层面的风险点 —— 物理算错了不会报错，只会表现为
// 「她怎么飘着不落地」「一放就飞出屏幕」「弹个没完」，肉眼很难定位。
// 全部走纯函数 + 注入时间轴，不需要 WebView 也不需要真的移动窗口。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PHYSICS,
  RELEASE_WINDOW_MS,
  THROW_THRESHOLD,
  estimateReleaseVelocity,
  makeThrowBody,
  shouldThrow,
  stepPhysics,
  windowRange,
  type PhysicsConfig,
  type Rect,
  type ThrowBody,
} from '../src/renderer/pet/physics.ts';

/** 1920x1080 屏、无任务栏偏移，窗口 268x512（与 tauri.conf.json 一致） */
const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const WIN = { width: 268, height: 512 };
const GROUND_Y = AREA.y + AREA.height - WIN.height; // 568

/** 固定 dt 反复推进，直到停住或超过 maxSteps（防死循环） */
function run(
  body: ThrowBody,
  area: Rect = AREA,
  cfg: PhysicsConfig = DEFAULT_PHYSICS,
  maxSteps = 2000
): { body: ThrowBody; lands: number; walls: number } {
  let b = body;
  let lands = 0;
  let walls = 0;
  for (let i = 0; i < maxSteps && !b.settled; i++) {
    const r = stepPhysics(b, 1 / 60, area, WIN, cfg);
    b = r.body;
    for (const ev of r.events) {
      if (ev.kind === 'land') lands++;
      if (ev.kind === 'wall') walls++;
    }
  }
  return { body: b, lands, walls };
}

describe('窗口可活动范围', () => {
  test('正常屏：右下角扣掉窗口自身尺寸', () => {
    const r = windowRange(AREA, WIN);
    assert.equal(r.minX, 0);
    assert.equal(r.minY, 0);
    assert.equal(r.maxX, 1920 - 268);
    assert.equal(r.maxY, 1080 - 512);
  });

  test('工作区比窗口还小时退化成一个点，不会算出负范围', () => {
    const tiny: Rect = { x: 100, y: 200, width: 100, height: 80 };
    const r = windowRange(tiny, WIN);
    // 宽高都小于窗口 ⇒ maxX/maxY 退化到 minX/minY
    assert.equal(r.minX, 100);
    assert.equal(r.maxX, 100);
    assert.equal(r.minY, 200);
    assert.equal(r.maxY, 200);
    assert.ok(r.maxX >= r.minX, 'maxX 永远不能小于 minX');
    assert.ok(r.maxY >= r.minY, 'maxY 永远不能小于 minY');
  });

  test('副屏负偏移：原点跟着工作区走，不假设从 0 开始', () => {
    const left: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };
    const r = windowRange(left, WIN);
    assert.equal(r.minX, -1920);
    assert.equal(r.maxX, -1920 + (1920 - 268));
  });
});

describe('重力与落地', () => {
  test('悬空释放后一定落到地面并停住', () => {
    const { body } = run(makeThrowBody(800, 100, 0, 0));
    assert.equal(body.settled, true, '必须最终停住，不能无限积分');
    assert.equal(body.y, GROUND_Y, '落点贴着工作区底部');
  });

  test('落地后停在工作区内，绝不越界', () => {
    const { body } = run(makeThrowBody(100, 100, 3000, 2000));
    const r = windowRange(AREA, WIN);
    assert.ok(body.x >= r.minX - 1 && body.x <= r.maxX + 1, `x=${body.x} 越界`);
    assert.ok(body.y >= r.minY - 1 && body.y <= r.maxY + 1, `y=${body.y} 越界`);
  });

  test('横向速度落地后被摩擦吃掉，不会一路滑到墙边', () => {
    // 给一个纯横向的初速：如果没做贴地摩擦，它会滑到 maxX 才停
    const { body } = run(makeThrowBody(100, GROUND_Y - 1, 1500, 0));
    assert.equal(body.settled, true);
    assert.ok(
      body.x < 1000,
      `期望摩擦让位移收在 1000 内，实际 x=${Math.round(body.x)}`
    );
  });
});

describe('反弹封顶', () => {
  test('从高处抛下会弹，但弹的次数有上限', () => {
    const cfg = { ...DEFAULT_PHYSICS, maxBounces: 3 };
    const { body, lands } = run(makeThrowBody(600, 0, 0, 0), AREA, cfg);
    assert.equal(body.settled, true);
    // 每次触地都发一个 land 事件；首落 + 最多 maxBounces 次反弹
    assert.ok(
      lands >= 1 && lands <= cfg.maxBounces + 1,
      `触地次数应在 1..${cfg.maxBounces + 1}，实际 ${lands}`
    );
    assert.ok(body.bounces <= cfg.maxBounces, 'bounces 不能超过上限');
  });

  test('慢速放下不弹，一次落定', () => {
    // 竖直速度低于 settleSpeed 时应当直接 grounded，不再反弹
    const cfg = { ...DEFAULT_PHYSICS, settleSpeed: 500 };
    const { lands } = run(makeThrowBody(600, GROUND_Y - 2, 0, 100), AREA, cfg);
    assert.equal(lands, 1, '慢放应当只有一次触地');
  });

  test('撞墙后横向速度反向且衰减，不会卡在墙上抖', () => {
    const { body, walls } = run(makeThrowBody(50, GROUND_Y - 200, 2500, 0));
    assert.ok(walls >= 1, '应当至少撞一次墙');
    assert.equal(body.settled, true, '撞墙后仍要能停住');
    assert.ok(Math.abs(body.vx) < 20, `撞墙后横向速度应收敛，实际 ${body.vx}`);
  });
});

describe('dt 钳制', () => {
  test('切后台回来的巨量 dt 不会把窗口推出工作区', () => {
    // 5 秒的 dt：如果直接积分，重力会产生 12000px/s 的速度，一帧就飞出去
    let b = makeThrowBody(800, 200, 0, 0);
    for (let i = 0; i < 10 && !b.settled; i++) {
      b = stepPhysics(b, 5, AREA, WIN).body;
    }
    const r = windowRange(AREA, WIN);
    assert.ok(b.y <= r.maxY + 1, `y=${Math.round(b.y)} 不能超出工作区底部`);
    assert.ok(b.x >= r.minX - 1 && b.x <= r.maxX + 1, `x=${Math.round(b.x)} 越界`);
  });
});

describe('已停住的身体不再推进', () => {
  test('settled 之后重复 step 是幂等的', () => {
    const { body } = run(makeThrowBody(800, 100, 0, 0));
    assert.equal(body.settled, true);
    const again = stepPhysics(body, 1 / 60, AREA, WIN);
    assert.deepEqual(again.body, body, '停住后位置不能再变');
    assert.equal(again.events.length, 0, '停住后不应再产生碰撞事件');
  });
});

describe('释放速度估算', () => {
  /** 造一条匀速直线运动的采样，间隔 16ms */
  function uniformSamples(vx: number, vy: number, n = 8, startT = 0) {
    const dt = 0.016;
    const out: { x: number; y: number; t: number }[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ x: vx * dt * i, y: vy * dt * i, t: startT + i * dt * 1000 });
    }
    return out;
  }

  test('匀速采样能还原出原始速度', () => {
    const v = estimateReleaseVelocity(uniformSamples(800, 0));
    assert.ok(Math.abs(v.x - 800) < 120, `期望约 800，实际 ${Math.round(v.x)}`);
    assert.ok(Math.abs(v.y) < 60, `y 期望接近 0，实际 ${Math.round(v.y)}`);
  });

  test('样本不足两个时返回 0（= 不抛掷）', () => {
    assert.deepEqual(estimateReleaseVelocity([]), { x: 0, y: 0 });
    assert.deepEqual(estimateReleaseVelocity([{ x: 0, y: 0, t: 0 }]), { x: 0, y: 0 });
  });

  test('陈旧采样被剔除：上一段拖拽的慢速不该拉低本次甩动', () => {
    // 前面是一段很慢的移动（300ms 前），最后一段是猛甩
    const old = uniformSamples(100, 0, 10, 0);
    const newest = uniformSamples(2400, 0, 6, 1000); // 从 1s 开始，速度 2400
    const v = estimateReleaseVelocity([...old, ...newest]);
    assert.ok(
      v.x > 1500,
      `应当反映最近的甩动速度（>1500），实际 ${Math.round(v.x)} —— 陈旧采样没被剔除`
    );
  });

  test('窗口内的抖动被加权平均掉，不会因单帧尖峰就抛出', () => {
    // 匀速 400px/s，但倒数第二个点故意偏 60px（鼠标抖动）
    const s = uniformSamples(400, 0, 8);
    s[s.length - 2] = { ...s[s.length - 2], x: s[s.length - 2].x + 60 };
    const v = estimateReleaseVelocity(s);
    assert.ok(
      v.x < 900,
      `单帧抖动不应主导结果（期望 <900），实际 ${Math.round(v.x)}`
    );
  });

  test('速度被钳在 maxSpeed 内', () => {
    const v = estimateReleaseVelocity(uniformSamples(99999, -99999));
    const cap = DEFAULT_PHYSICS.maxSpeed;
    assert.ok(Math.abs(v.x) <= cap && Math.abs(v.y) <= cap, '速度必须被钳制');
  });

  test('采样时间跨度为 0 时返回 0，不会除以零', () => {
    const s = [
      { x: 0, y: 0, t: 100 },
      { x: 50, y: 50, t: 100 },
    ];
    assert.deepEqual(estimateReleaseVelocity(s), { x: 0, y: 0 });
  });

  test('释放窗口常量与实现一致（防止改了常量忘了改语义）', () => {
    assert.ok(RELEASE_WINDOW_MS > 0 && RELEASE_WINDOW_MS < 400, '窗口应在 400ms 内');
  });
});

describe('抛掷阈值', () => {
  test('静止 / 慢速移动不触发抛掷', () => {
    assert.equal(shouldThrow({ x: 0, y: 0 }), false);
    assert.equal(shouldThrow({ x: 100, y: 0 }), false);
  });

  test('快速甩动触发抛掷', () => {
    assert.equal(shouldThrow({ x: THROW_THRESHOLD, y: 0 }), true);
    assert.equal(shouldThrow({ x: 0, y: -600 }), true);
  });

  test('阈值本身合理：既能接住轻放，也接得住真甩', () => {
    assert.ok(THROW_THRESHOLD > 100, '阈值太低会导致每次放下都飞出去');
    assert.ok(THROW_THRESHOLD < 1200, '阈值太高会让甩掷变得几乎不可能触发');
  });
});

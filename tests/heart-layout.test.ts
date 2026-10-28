// 摸头爱心布局回归：扇形散开、边界收敛、错峰递增、颗数钳制。
//
// 这几条覆盖的是「看着不对但不报错」的风险点：
//   - 落点不换算舞台坐标 ⇒ 爱心出现在窗口外（多显示器/负偏移下尤其明显）；
//   - 不收敛边界 ⇒ 点在舞台边缘时 emoji 被裁一半，或飘到脚边直接飞出舞台；
//   - 颗数不钳制 ⇒ 连击档位传进来的数字被原样渲染，出现一排糊满屏的爱心。
// 全部走纯函数 + 注入 rng，不需要 DOM。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_HEIGHT,
  STAGE_OFFSET_X,
  STAGE_OFFSET_Y,
  STAGE_WIDTH,
  heartSpots,
} from '../src/renderer/pet/animations.ts';

/** rng 固定返回 0.5 ⇒ 抖动项为 0，方便断言确定性布局 */
const noJitter = () => 0.5;

describe('爱心落点', () => {
  test('舞台中心点击 ⇒ 三颗心以中心对称散开', () => {
    const spots = heartSpots(STAGE_WIDTH / 2, STAGE_HEIGHT * 0.3, 3, noJitter);
    assert.equal(spots.length, 3);
    const [a, b, c] = spots;
    // 中间那颗几乎正对点击点（±6px 抖动被 noJitter 归零）
    assert.ok(Math.abs(b.x - STAGE_WIDTH / 2) < 1, `中间心 x=${b.x}`);
    // 左右两颗各偏 18px，构成扇形
    assert.equal(b.x - a.x, 18, '左心比中心心偏左 18px');
    assert.equal(c.x - b.x, 18, '右心比中心心偏右 18px');
  });

  test('点击点靠近左边缘 ⇒ 落点收敛进舞台，不越界', () => {
    for (const clickX of [-40, 0, 5, 10]) {
      const spots = heartSpots(clickX, 100, 5, noJitter);
      for (const s of spots) {
        assert.ok(s.x >= 10, `clickX=${clickX} 时 x=${s.x} 低于左界`);
        assert.ok(s.x <= STAGE_WIDTH - 10, `clickX=${clickX} 时 x=${s.x} 超过右界`);
      }
    }
  });

  test('点击点靠近右边缘 ⇒ 落点收敛进舞台，不越界', () => {
    for (const clickX of [STAGE_WIDTH, STAGE_WIDTH + 30, 9999]) {
      const spots = heartSpots(clickX, 100, 5, noJitter);
      for (const s of spots) {
        assert.ok(s.x <= STAGE_WIDTH - 10, `clickX=${clickX} 时 x=${s.x} 超过右界`);
        assert.ok(s.x >= 10, `clickX=${clickX} 时 x=${s.x} 低于左界`);
      }
    }
  });

  test('点击点过低 ⇒ 落点抬回舞台内（爱心往上飘，脚边会直接飘出去）', () => {
    for (const clickY of [STAGE_HEIGHT, STAGE_HEIGHT + 100, 9999]) {
      const spots = heartSpots(100, clickY, 3, noJitter);
      for (const s of spots) {
        assert.ok(s.y <= STAGE_HEIGHT - 60, `clickY=${clickY} 时 y=${s.y} 低于下界`);
        assert.ok(s.y >= 20, `clickY=${clickY} 时 y=${s.y} 高于上界`);
      }
    }
  });

  test('舞台坐标换算常量与窗口/舞台几何一致', () => {
    // tauri.conf.json: pet 窗口 268×512；pet.css: .char-stage 238×399, left:15, bottom:0
    assert.equal(STAGE_OFFSET_X, 15, '舞台左边距');
    assert.equal(STAGE_OFFSET_Y, 512 - 399, '舞台顶部留白 = 窗口高 - 舞台高');
    assert.equal(STAGE_WIDTH, 238);
    assert.equal(STAGE_HEIGHT, 399);
  });
});

describe('错峰与颗数', () => {
  test('每颗比前一颗晚 60ms 出场，第一颗不延迟', () => {
    const spots = heartSpots(100, 100, 4, noJitter);
    assert.deepEqual(
      spots.map((s) => s.delayMs),
      [0, 60, 120, 180]
    );
  });

  test('颗数钳制在 1..8：0/负数出 1 颗，超大出 8 颗', () => {
    assert.equal(heartSpots(100, 100, 0, noJitter).length, 1);
    assert.equal(heartSpots(100, 100, -3, noJitter).length, 1);
    assert.equal(heartSpots(100, 100, 0.7, noJitter).length, 1, '小数向下取整后至少 1 颗');
    assert.equal(heartSpots(100, 100, 99, noJitter).length, 8);
  });

  test('注入 rng 走确定性：同 rng 同输入 ⇒ 同布局', () => {
    const a = heartSpots(120, 150, 5, () => 0.2);
    const b = heartSpots(120, 150, 5, () => 0.2);
    assert.deepEqual(a, b);
  });

  test('抖动项落在 ±6px（横向）/ ±8px（纵向）内', () => {
    const low = heartSpots(119, 120, 1, () => 0); // rng=0 ⇒ 抖动取负最大
    const high = heartSpots(119, 120, 1, () => 1); // rng=1 ⇒ 抖动取正最大
    assert.equal(low[0].x, 119 - 6, 'rng=0 横向抖 -6');
    assert.equal(high[0].x, 119 + 6, 'rng=1 横向抖 +6');
    assert.equal(low[0].y, 120 - 8, 'rng=0 纵向抖 -8');
    assert.equal(high[0].y, 120 + 8, 'rng=1 纵向抖 +8');
  });
});

describe('多显示器偏移', () => {
  test('舞台坐标是 client 坐标减偏移，负偏移屏也落在舞台内', () => {
    // 模拟第二显示器在主屏左侧（工作区 x 从 -1920 起）：client 坐标是窗口内的，
    // 与屏幕位置无关；这条锁住「换算只依赖窗口内坐标」这一约定。
    const clientX = 200;
    const clientY = 300;
    const stageX = clientX - STAGE_OFFSET_X;
    const stageY = clientY - STAGE_OFFSET_Y;
    const spots = heartSpots(stageX, stageY, 3, noJitter);
    for (const s of spots) {
      assert.ok(s.x >= 10 && s.x <= STAGE_WIDTH - 10, `x=${s.x} 出界`);
      assert.ok(s.y >= 20 && s.y <= STAGE_HEIGHT - 60, `y=${s.y} 出界`);
    }
    // 中间那颗应当正对换算后的点击点
    assert.equal(spots[1].x, stageX);
  });
});

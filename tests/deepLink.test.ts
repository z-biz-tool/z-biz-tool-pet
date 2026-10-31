// pet 深链语义层（src/renderer/pet/_shared/deepLink.ts）的纯函数回归。
// 跑法：node --experimental-strip-types --test tests/*.test.ts
//
// 这一层要防的是：
//   1. `say` 缺 text 被当成「说了空话」（宠物气泡一闪而过，用户懵）
//   2. 未知 action 被静默忽略（用户「点了没反应」）
//   3. 参数前后空格 / 空串被当成合法值
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePetDeepLink } from '../src/renderer/pet/_shared/deepLink.ts';
import type { Handoff } from 'z-biz-tool-shared/protocol';

/** 造一条深链，默认 product=pet */
function mk(params: Record<string, string>, action = 'say'): Handoff {
  return { product: 'pet', action, params };
}

test('正常：say + text 让宠物说这句话', () => {
  const out = resolvePetDeepLink(mk({ text: '你好呀' }));
  assert.equal(out.problem, null);
  assert.equal(out.text, '你好呀');
});

test('正常：open 不带参数 = 仅唤起，不报错', () => {
  const out = resolvePetDeepLink(mk({}, 'open'));
  assert.equal(out.problem, null);
  assert.equal(out.text, null);
});

test('缺参数：say 不带 text 给出 problem', () => {
  const out = resolvePetDeepLink(mk({}));
  assert.equal(out.problem, '没说要让我说什么');
  assert.equal(out.text, null);
});

test('空串参数：say + text 空串等同于没说', () => {
  const out = resolvePetDeepLink(mk({ text: '   ' }));
  assert.equal(out.problem, '没说要让我说什么');
  assert.equal(out.text, null);
});

test('前后空格：text 被 trim 后仍认得出', () => {
  const out = resolvePetDeepLink(mk({ text: '  摸摸头  ' }));
  assert.equal(out.problem, null);
  assert.equal(out.text, '摸摸头');
});

test('未知动作：非 say/open 一律报不认识的动作', () => {
  const out = resolvePetDeepLink(mk({ text: 'x' }, 'pet'));
  assert.equal(out.problem, '不认识的动作 pet');
  assert.equal(out.text, null);
});

test('action 缺省：空 action 视为 open，不报错', () => {
  const out = resolvePetDeepLink(mk({}, ''));
  assert.equal(out.problem, null);
  assert.equal(out.text, null);
});

test('from 透传：发送方只用于提示与日志', () => {
  const out = resolvePetDeepLink(mk({ text: 'hi', from: 'box' }));
  assert.equal(out.problem, null);
  assert.equal(out.text, 'hi');
  assert.equal(out.from, 'box');
});

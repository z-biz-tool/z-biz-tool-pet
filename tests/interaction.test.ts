// 交互层纯逻辑回归：菜单坐标夹取、错误文案归一、快捷指令 upsert。
// 跑法：npm test（node --experimental-strip-types --test tests/*.test.ts）
//
// 这三条都对应本轮修过的真实交互缺陷：
//   · 右键菜单在 200×320 的宠物窗里按点击点展开 → 溢出窗口；
//   · Tauri invoke 以字符串 reject，旧代码读 e.message 得到 undefined → 提示只剩 `undefined`；
//   · 快捷指令保存用闭包里的旧数组写 localStorage → 新增/编辑实际丢失。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampMenuPosition,
  errorMessage,
  upsertById,
} from '../src/renderer/shared/interaction.ts';

describe('clampMenuPosition', () => {
  const viewport = { width: 200, height: 320 };
  const menu = { width: 170, height: 280 };

  test('点击点在窗口内且菜单放得下时原样返回', () => {
    assert.deepEqual(clampMenuPosition(10, 20, viewport, menu), { x: 10, y: 20 });
  });

  test('靠右/靠下时把菜单拉回窗口内', () => {
    assert.deepEqual(clampMenuPosition(190, 310, viewport, menu), { x: 30, y: 40 });
  });

  test('负坐标夹到 0（多显示器/缩放下的越界点击）', () => {
    assert.deepEqual(clampMenuPosition(-20, -5, viewport, menu), { x: 0, y: 0 });
  });

  test('菜单比窗口还大时落在左上角，不出现负偏移', () => {
    assert.deepEqual(
      clampMenuPosition(50, 50, { width: 120, height: 100 }, { width: 170, height: 280 }),
      { x: 0, y: 0 }
    );
  });
});

describe('errorMessage', () => {
  test('Tauri 的字符串 reject 原样返回', () => {
    assert.equal(errorMessage('voice_transcribe: 模型缺失', '未知错误'), 'voice_transcribe: 模型缺失');
  });

  test('Error 取 message', () => {
    assert.equal(errorMessage(new Error('麦克风被占用'), '未知错误'), '麦克风被占用');
  });

  test('对象上的 message 也认（跨 window 抛过来的 DOMException）', () => {
    assert.equal(errorMessage({ message: 'NotAllowedError' }, '未知错误'), 'NotAllowedError');
  });

  test('空串 / null / 空对象回退到 fallback，不出现 undefined', () => {
    assert.equal(errorMessage(undefined, '主进程无响应'), '主进程无响应');
    assert.equal(errorMessage('', '主进程无响应'), '主进程无响应');
    assert.equal(errorMessage({}, '主进程无响应'), '主进程无响应');
  });
});

describe('upsertById', () => {
  const base = [
    { id: 'a', name: '查天气' },
    { id: 'b', name: '番茄钟' },
  ];

  test('新增追加到末尾且不改原数组', () => {
    const next = upsertById(base, { id: 'c', name: '讲笑话' });
    assert.equal(next.length, 3);
    assert.equal(next[2].id, 'c');
    assert.equal(base.length, 2, '原数组不能被原地修改');
  });

  test('同 id 覆盖，顺序不变', () => {
    const next = upsertById(base, { id: 'a', name: '查天气（新）' });
    assert.equal(next.length, 2);
    assert.equal(next[0].name, '查天气（新）');
    assert.equal(next[1].id, 'b');
  });
});

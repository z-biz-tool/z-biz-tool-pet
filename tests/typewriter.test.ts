// 打字机回归：分段语速、码点切分、出全封顶。
//
// 这几条覆盖的都是「看着不对但不报错」的风险点：
//   - 按 UTF-16 单元切会把 emoji 劈成两半，打到一半吐出 �；
//   - 语速忘了分段，300 字的回答要打 8 秒，用户以为卡死去点她，气泡一换更读不完；
//   - elapsed 不封顶/不钳制，会出现「打完还继续数」的空转。
// 全部走纯函数 + 注入时间轴，不需要 DOM 也不需要假计时器。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAST_MS_PER_CHAR,
  INSTANT_CHARS,
  LONG_TEXT_CHARS,
  TYPE_MS_PER_CHAR,
  codePointLength,
  msPerChar,
  revealCount,
  revealText,
  totalTypeMs,
} from '../src/renderer/pet/typewriter.ts';

/** 造一段指定「字数」的中文台词（码点长度 = n，不是 UTF-16 长度） */
function makeLine(n: number): string {
  return '好'.repeat(n);
}

describe('分段语速', () => {
  test('短句（≤6 字）瞬间出全，没有打字过程', () => {
    for (const text of ['', '嗯', '思考中', '喝口水', makeLine(INSTANT_CHARS)]) {
      assert.equal(msPerChar(text), 0, `"${text}" 应当瞬间出全`);
      assert.equal(totalTypeMs(text), 0);
      // 连 elapsed=0 也直接给全量 —— 状态词不该有「先空一下」的第一帧
      assert.equal(revealText(text, 0), text);
      assert.equal(revealCount(text, 0), codePointLength(text));
    }
  });

  test('常规台词 28ms/字', () => {
    assert.equal(msPerChar(makeLine(INSTANT_CHARS + 1)), TYPE_MS_PER_CHAR);
    assert.equal(msPerChar(makeLine(LONG_TEXT_CHARS)), TYPE_MS_PER_CHAR);
  });

  test('长回复（>120 字）切到 14ms/字加速档', () => {
    assert.equal(msPerChar(makeLine(LONG_TEXT_CHARS + 1)), FAST_MS_PER_CHAR);
    // 边界两侧必须不同档，否则分段等于没写
    assert.notEqual(
      msPerChar(makeLine(LONG_TEXT_CHARS)),
      msPerChar(makeLine(LONG_TEXT_CHARS + 1))
    );
  });

  test('总时长 = 字数 × 每字耗时', () => {
    const line = makeLine(50);
    assert.equal(totalTypeMs(line), 50 * TYPE_MS_PER_CHAR);
    const long = makeLine(300);
    assert.equal(totalTypeMs(long), 300 * FAST_MS_PER_CHAR);
    // 300 字必须在 5 秒内出完：打字是「像开口」，不是让用户干等
    assert.ok(totalTypeMs(long) <= 5000, `300 字耗时 ${totalTypeMs(long)}ms 过长`);
  });
});

describe('逐字推进', () => {
  const line = makeLine(10); // 280ms 出全

  test('从 0 开始，随时间单调露出', () => {
    assert.equal(revealCount(line, -100), 0, '负时间视为还没开始');
    assert.equal(revealCount(line, 0), 0);
    assert.equal(revealCount(line, 1), 0, '不足一个字的耗时不出半截');
    assert.equal(revealCount(line, TYPE_MS_PER_CHAR), 1);
    assert.equal(revealCount(line, TYPE_MS_PER_CHAR * 5), 5);
  });

  test('出全后封顶在字数，不再多算', () => {
    assert.equal(revealCount(line, totalTypeMs(line)), 10);
    assert.equal(revealCount(line, totalTypeMs(line) * 100), 10, '打完不再推进');
    assert.equal(revealText(line, 1e9), line);
  });

  test('revealText 与 revealCount 一致', () => {
    for (const elapsed of [0, 14, 28, 100, 279, 280, 5000]) {
      const shown = revealText(line, elapsed);
      assert.equal(codePointLength(shown), revealCount(line, elapsed));
      assert.equal(shown, line.slice(0, revealCount(line, elapsed)));
    }
  });
});

describe('码点切分（不劈开 emoji）', () => {
  // 👍 是 1 个码点、2 个 UTF-16 单元 —— 按单元 slice 会劈出孤立代理项
  const emojiLine = '👍'.repeat(10);
  assert.equal(emojiLine.length, 20, '前置事实：UTF-16 长度确实是码点的两倍');

  test('emoji 台词按字数计费，不按 UTF-16 长度', () => {
    assert.equal(codePointLength(emojiLine), 10);
    assert.equal(msPerChar(emojiLine), TYPE_MS_PER_CHAR, '10 个 emoji 算 10 字，走常规档');
    assert.equal(totalTypeMs(emojiLine), 10 * TYPE_MS_PER_CHAR);
  });

  test('任何时刻都不出现孤立代理项（打到一半不会吐 �）', () => {
    for (let elapsed = 0; elapsed <= 400; elapsed += 7) {
      const shown = revealText(emojiLine, elapsed);
      // 孤立代理项：高位代理后面没跟低位代理，或低位代理前面不是高位代理
      assert.ok(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(shown),
        `elapsed=${elapsed} 出现了孤立代理项：${shown}`
      );
    }
  });

  test('混合中英文 + emoji 也按码点推进', () => {
    const mixed = '我👍是哈哈😄';

    assert.equal(codePointLength(mixed), 6);
    assert.equal(msPerChar(mixed), 0, '6 个码点算短句，瞬间出全');
    const longer = `你好呀${'我👍是哈哈😄'}`; // 3 + 6 = 9 码点
    assert.equal(codePointLength(longer), 9);
    assert.equal(msPerChar(longer), TYPE_MS_PER_CHAR);
    // 👍 是第 5 个码点：前 4 个字只到「我」，第 5 个字才把整个 👍 连着出来
    assert.equal(revealText(longer, TYPE_MS_PER_CHAR * 4), '你好呀我');
    assert.equal(revealText(longer, TYPE_MS_PER_CHAR * 5), '你好呀我👍');
  });
});

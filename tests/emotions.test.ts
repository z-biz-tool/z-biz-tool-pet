// 情绪系统的纯逻辑回归（无 React、无 IPC、无 Tauri）。
// 跑法：npm test（node --experimental-strip-types --test tests/*.test.ts）
//
// 为什么补这层：`src/renderer/shared/emotions.ts` 是宠物「表情/语气」的**唯一**判定源
// （`src/renderer/pet/App.tsx` 与 admin 面板都读它），而本仓此前**一条前端测试都没有**
// —— 91 条 Rust 测试管的是后端，前端这块是裸的。
//
// 头一条用例锁的是一个**真缺陷**：纯文本路径按词表插入序做子串匹配，
// 短的 '爱'（loving）排在长的 '可爱'（cute）前面，于是「好可爱啊」被判成 loving，
// 而同样的话写成 `[可爱]` 标签却判成 cute —— 同一份词表、两条路径、两个答案。
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EMOTION_CONFIGS,
  buildEmotionPromptSuffix,
  extractEmotionFromText,
  inferEmotionFromStats,
  resolveEmotion,
  type Emotion,
  type PetStats,
} from "../src/renderer/shared/emotions.ts";

function stats(over: Partial<PetStats> = {}): PetStats {
  return {
    hunger: 50,
    happiness: 50,
    energy: 50,
    cleanliness: 50,
    health: 50,
    affection: 50,
    age: 1,
    stage: "child",
    bornAt: "2026-01-01T00:00:00Z",
    lastUpdate: "2026-01-01T00:00:00Z",
    isSleeping: false,
    isSick: false,
    ...over,
  };
}

describe("情绪词表解析", () => {
  test("标签路径与纯文本路径必须给同一个答案（这正是被修掉的那个缺陷）", () => {
    // 「可爱」既能被 [可爱] 命中，也能被纯文本命中
    assert.equal(extractEmotionFromText("[可爱]"), "cute");
    assert.equal(extractEmotionFromText("好可爱啊"), "cute");
    // 「爱」同理
    assert.equal(extractEmotionFromText("[爱]"), "loving");
    assert.equal(extractEmotionFromText("我爱你"), "loving");
  });

  test("长词优先：短词不得遮住包含它的长词", () => {
    // '爱' ⊂ '可爱'；'困' ⊂ '困倦'；'想睡' ⊂ '想睡觉'
    assert.equal(extractEmotionFromText("它好可爱"), "cute");
    assert.equal(extractEmotionFromText("好困呀"), "sleepy");
    assert.equal(extractEmotionFromText("我想睡了"), "sleepy");
  });

  test("每个词表关键词在纯文本里都能被认出（漏一个就改一次表）", () => {
    const samples: Array<[string, Emotion]> = [
      ["我很开心", "happy"],
      ["我很高兴", "happy"],
      ["我很快乐", "happy"],
      ["嘻嘻", "happy"],
      ["哈哈", "excited"],
      ["我生气了", "angry"],
      ["哼，不理你了", "tsundere"],
      ["你好讨厌", "tsundere"],
      ["有点害羞", "shy"],
      ["你脸红了", "shy"],
      ["我好害怕", "scared"],
      ["我很担心", "scared"],
      ["我难过", "sad"],
      ["我伤心", "sad"],
      ["好困", "sleepy"],
      ["好累", "sleepy"],
      ["我想睡", "sleepy"],
      ["我爱你", "loving"],
      ["我喜欢这样", "loving"],
      ["么么哒", "loving"],
      ["让我思考一下", "thinking"],
      ["我很惊讶", "surprised"],
      ["哇哦", "surprised"],
      ["我真骄傲", "proud"],
      ["我很得意", "proud"],
      ["你好调皮", "playful"],
      ["你在捣蛋", "playful"],
      ["别怕我安慰你", "comforting"],
      ["我很困惑", "confused"],
      ["我迷茫了", "confused"],
      ["你真霸道", "dominant"],
      ["这是命令", "dominant"],
      ["你好可爱", "cute"],
      ["你在撒娇", "cute"],
      ["悄悄话", "whispering"],
      ["小声点", "whispering"],
    ];
    for (const [text, want] of samples) {
      assert.equal(extractEmotionFromText(text), want, `「${text}」判成了 ${extractEmotionFromText(text)}`);
    }
  });

  test("显式标签优先于正文里更长的词", () => {
    // 标签是作者显式写的意图；正文里恰好也出现了别的关键词时，标签赢。
    // 这条锁住「标签路径优先」这一层（否则这条路径其实可以整个删掉）。
    assert.equal(extractEmotionFromText("[困]但其实好可爱"), "sleepy");
    assert.equal(extractEmotionFromText("[可爱]我好困"), "cute");
  });

  test("认不出的文本返回 null（不硬凑一个情绪）", () => {
    assert.equal(extractEmotionFromText(""), null);
    assert.equal(extractEmotionFromText("今天的天气不错"), null);
  });
});

describe("按状态推断情绪", () => {
  test("优先级：生病 > 睡觉 > 其它", () => {
    assert.equal(inferEmotionFromStats(stats({ isSick: true, isSleeping: true })), "sad");
    assert.equal(inferEmotionFromStats(stats({ isSleeping: true })), "sleepy");
  });

  test("饥饿与不干净各有各的表情", () => {
    assert.equal(inferEmotionFromStats(stats({ hunger: 10 })), "scared");
    assert.equal(inferEmotionFromStats(stats({ hunger: 40 })), "whispering");
    assert.equal(inferEmotionFromStats(stats({ cleanliness: 10 })), "confused");
  });

  test("好感度与心情各自生效", () => {
    assert.equal(inferEmotionFromStats(stats({ affection: 90 })), "loving");
    assert.equal(inferEmotionFromStats(stats({ happiness: 90 })), "happy");
    assert.equal(inferEmotionFromStats(stats({ happiness: 70, energy: 70 })), "playful");
    assert.equal(inferEmotionFromStats(stats({ happiness: 10 })), "sad");
  });

  test("一切正常时是 neutral", () => {
    assert.equal(inferEmotionFromStats(stats()), "neutral");
  });
});

describe("综合推断与 prompt 生成", () => {
  test("AI 文本里的情绪优先于状态推断", () => {
    // 状态是 sad，但 AI 说了「好可爱」
    assert.equal(resolveEmotion(stats({ happiness: 10 }), "好可爱啊"), "cute");
    // AI 文本没有情绪时回落到状态
    assert.equal(resolveEmotion(stats({ happiness: 90 }), "今天天气不错"), "happy");
    assert.equal(resolveEmotion(stats({ happiness: 90 })), "happy");
  });

  test("每种情绪都有配置与 prompt 片段（漏一个就会在界面上崩）", () => {
    for (const emotion of Object.keys(EMOTION_CONFIGS) as Emotion[]) {
      const config = EMOTION_CONFIGS[emotion];
      assert.ok(config.cssClass.startsWith("emotion-"), `${emotion} 的 cssClass 不对`);
      assert.ok(config.toneModifier.length > 0, `${emotion} 缺语气描述`);
      const suffix = buildEmotionPromptSuffix(emotion);
      assert.ok(suffix.includes(emotion), `${emotion} 的 prompt 里没有情绪名`);
      assert.ok(suffix.length > 10, `${emotion} 的 prompt 太短`);
    }
  });

  test("prompt 里不出现 undefined（配置缺项会漏进发给模型的内容里）", () => {
    for (const emotion of Object.keys(EMOTION_CONFIGS) as Emotion[]) {
      const suffix = buildEmotionPromptSuffix(emotion);
      assert.ok(!suffix.includes("undefined"), `${emotion} 的 prompt 里有 undefined`);
    }
  });
});

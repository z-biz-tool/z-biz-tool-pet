/**
 * zbiz:// 深链接的 **pet 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|----|--------|
 * | 协议 | `z-biz-tool-shared/protocol` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol` 的 `startDeepLinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 pet 该做什么** |
 *
 * ## pet 支持的动作
 *
 * pet 没有外部可定位实体（没有文件、没有任务、没有稳定 id），
 * 它唯一对外「做」的事就是**说话**——所以深链接语义收敛成一条：
 *
 * | action | 含义 |
 * |--------|------|
 * | `open` | 唤到前台（缺省 action）。无参数时纯唤起，不报错 |
 * | `say`  | 让宠物说一句 `text` 参数里的话 |
 *
 * ## 支持的参数
 *
 * | 参数 | 作用 |
 * |------|------|
 * | `text`| `say` 动作要说的句子；缺/空 ⇒ problem「没说要让我说什么」 |
 * | `from`| 发送方，仅用于日志与回执 |
 *
 * 接不住（未知动作、say 缺 text）必须给出 problem —— 机制层会把它透成可见提示，
 * 否则用户看到的就是「点了没反应」。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/**
 * pet 的深链结果。
 *
 * `text` 非 null 表示要让宠物说这句话；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface PetDeepLinkOutcome {
  /** 要说的句子；null 表示不带说话意图（仅唤起） */
  text: string | null;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因 */
  problem: string | null;
}

/**
 * 把一条深链翻译成 pet 内的动作。
 *
 * 纯函数 —— 不碰 React state、不碰 Tauri，所以可以直接单测。
 *
 * @param item 深链
 */
export function resolvePetDeepLink(item: Handoff): PetDeepLinkOutcome {
  const outcome: PetDeepLinkOutcome = {
    text: null,
    from: item.params.from ?? null,
    problem: null,
  };

  const action = item.action.trim() || "open";

  if (action === "open") {
    // 纯唤起：机制层会把窗口带到前台，这里无需额外动作
    return outcome;
  }

  if (action === "say") {
    const rawText = item.params.text?.trim() ?? "";
    if (!rawText) {
      outcome.problem = "没说要让我说什么";
      return outcome;
    }
    outcome.text = rawText;
    return outcome;
  }

  outcome.problem = `不认识的动作 ${action}`;
  return outcome;
}

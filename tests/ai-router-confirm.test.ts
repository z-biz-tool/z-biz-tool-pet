// 工具确认闸的判定测试（ai-router 的 needsConfirmation / alwaysAllowed 白名单）。
//
// 为什么这层必须补网：needsConfirmation 是**执行任何工具前的唯一闸门**，
// 而它的三级风险判定（SAFE / SENSITIVE / DANGEROUS）+ 「总是允许」白名单
// 是一个**跨调用累积的模块级 Set**。这类状态最容易出两种事故：
//   1. 白名单没被正确撤销 ⇒ 某个高危工具从此静默执行
//   2. 危险工具被错误地允许「总是允许」⇒ 用户点一次，这个工具永久免确认
// 两者的现场症状都是「AI 干了用户没同意的事」，且只在特定操作顺序下复现。
//
// 本文件只测判定与白名单生命周期，不触碰 runToolCalls（那要真发 HTTP）。
// ai-router 顶层 import 了 electron / child_process，这里全部 mock 掉：
// 它在本文件里用到的只有 ipcMain.handle 与 createAdminWindow。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- electron 桩：只提供 ai-router 顶层 import 到的东西 ----
const registeredHandlers = new Map<string, (...args: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: any[]) => any) => {
      registeredHandlers.set(ch, fn);
    },
  },
  app: { getPath: () => '/tmp/zbot-test', getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  shell: {},
}));
// child_process 只在 runShellWithTimeout 里用，本文件不触发，但顶层 import 需存在
vi.mock('child_process', () => ({ exec: vi.fn() }));

// window-manager 依赖 electron 的真窗口能力，整体 stub 成可控桩
const sentMessages: Array<{ ch: string; payload: any }> = [];
vi.mock('../src/main/window-manager', () => ({
  sendToWindows: (ch: string, payload: any) => {
    sentMessages.push({ ch, payload });
  },
  getAdminWindow: () => null,
  createAdminWindow: () => undefined,
  getPetWindow: () => null,
}));

const { needsConfirmation } = await import('../src/main/ai-router');
// allowAlwaysOnApproval 是「两套口径」的另一半：它只看 security.ts 的风险级，
// 与 mcp-tools 的 requiresConfirmation 相互独立 —— 缺陷正出在两者的组合上。
const { allowAlwaysOnApproval } = await import('../src/main/security');

// tools:alwaysAllowed / tools:revokeAlwaysAllowed 这两个 IPC 处理器是白名单的
// 唯一对外接口，直接调它们来操作，比反射模块内部 Set 更接近真实用法。
const alwaysAllowedHandler = registeredHandlers.get('tools:alwaysAllowed')!;
const revokeHandler = registeredHandlers.get('tools:revokeAlwaysAllowed')!;

const SAFE = 'get_datetime';
const SENSITIVE = 'web_search';
const DANGEROUS = 'execute_command';

beforeEach(async () => {
  // 白名单是模块级状态，逐个清干净，否则用例之间会互相污染
  for (const n of await alwaysAllowedHandler()) await revokeHandler(n);
  sentMessages.length = 0;
});

describe('needsConfirmation：风险分级', () => {
  it('SAFE 级不需确认', () => {
    expect(needsConfirmation(SAFE)).toBe(false);
  });

  it('SENSITIVE 级需要确认', () => {
    // 2026-10-04 起这条**曾经是红的**。真因见下面「两套口径一致性」那组。
    expect(needsConfirmation(SENSITIVE)).toBe(true);
  });

  it('SENSITIVE 级逐个都需要确认（曾经有 5 个被放行）', () => {
    // 这一组是本文件挖出缺陷的地方。needsConfirmation 的判定链是
    //   DANGEROUS → 直接 true
    //   else 查「总是允许」白名单
    //   else 落到 mcp-tools 里每个工具自己声明的 requiresConfirmation
    // 而那批 SENSITIVE 工具声明的是 false ⇒ 永远不问用户，
    // 同时 allowAlwaysOnApproval 又对 SENSITIVE 返回 true ⇒ 连补救通道都没有。
    for (const n of ['web_search', 'read_url', 'clipboard_read',
                     'screenshot_analyze', 'set_reminder']) {
      expect(needsConfirmation(n), `${n} 是 SENSITIVE，必须需要确认`).toBe(true);
    }
  });

  it('DANGEROUS 级需要确认', () => {
    expect(needsConfirmation(DANGEROUS)).toBe(true);
  });

  it('未知工具需要确认（按最危险处理，不静默放行）', () => {
    expect(needsConfirmation('totally_made_up_tool')).toBe(true);
  });
});

describe('两套口径一致性（本次缺陷的根因所在）', () => {
  // security.ts 的 ToolRiskLevel 与 mcp-tools.ts 的 requiresConfirmation
  // 是**两套彼此独立的数据**。这组用例把「它们必须一致」固化成契约，
  // 以后任何人只改一边，这里就会红。
  const SENSITIVE_TOOLS = ['web_search', 'read_url', 'clipboard_read',
                           'screenshot_analyze', 'set_reminder'];
  const SAFE_TOOLS = ['get_datetime', 'get_weather', 'control_pet'];

  it('每个 SENSITIVE 工具：需要确认，且允许「总是允许」', () => {
    for (const n of SENSITIVE_TOOLS) {
      expect(allowAlwaysOnApproval(n), `${n} 应可「总是允许」`).toBe(true);
      expect(needsConfirmation(n), `${n} 首次必须确认`).toBe(true);
    }
  });

  it('每个 SAFE 工具：不需要确认，且不允许「总是允许」（无意义）', () => {
    for (const n of SAFE_TOOLS) {
      expect(needsConfirmation(n), `${n} 是 SAFE，应自动执行`).toBe(false);
      expect(allowAlwaysOnApproval(n), `${n} 是 SAFE，不该有「总是允许」`).toBe(false);
    }
  });

  it('DANGEROUS：每次必确认，且永不允许「总是允许」', () => {
    for (const n of ['execute_command', 'open_app']) {
      expect(needsConfirmation(n), `${n} 是 DANGEROUS，必须确认`).toBe(true);
      expect(allowAlwaysOnApproval(n), `${n} 不得被永久免确认`).toBe(false);
    }
  });

  it('不存在「免确认且禁止总是允许」的 SENSITIVE 组合（那是本次缺陷的形态）', () => {
    // 这条是整组的判别式：若某个工具「不需确认」但「又算 SENSITIVE」，
    // 说明它掉进了既不会被问、又没有补救通道的黑洞。
    for (const n of SENSITIVE_TOOLS) {
      const confirms = needsConfirmation(n);
      const canRemember = allowAlwaysOnApproval(n);
      expect(
        confirms || !canRemember,
        `${n} 免确认(${!confirms}) 却是 SENSITIVE(可总是允许=${canRemember}) —— 无补救通道`,
      ).toBe(true);
    }
  });
});

describe('「总是允许」白名单的生命周期', () => {
  it('初始为空', async () => {
    expect(await alwaysAllowedHandler()).toEqual([]);
  });

  it('DANGEROUS 工具永不需要「总是允许」', () => {
    // allowAlwaysOnApproval 的纯函数版本已在 security.test.ts 覆盖
    // （「只有 SENSITIVE 可以被总是允许」），这里不重复断言。
    // 本文件关心的是**它在 ai-router 里的使用位置**——
    // 即双重校验的第二个条件，见下面两条。
    expect(needsConfirmation(DANGEROUS)).toBe(true);
  });

  it('DANGEROUS 判定排在白名单检查之前（实现顺序即安全边界）', () => {
    // 关键：needsConfirmation 里 DANGEROUS 的 return true 在 has() 之前。
    // 即使 Set 里真的有该条目，也到不了 has() 那一行。
    // 现状 DANGEROUS 进不了白名单（allowAlwaysOnApproval 只放行 SENSITIVE），
    // 所以这里只能验行为、**不能构造真场景**——这是本文件的已知覆盖缺口。
    // 现状刻画，不是认可。
    expect(needsConfirmation(DANGEROUS)).toBe(true);
  });

  it('SENSITIVE 工具初始状态需要确认（白名单为空时不能免确认）', async () => {
    // 白名单的写入只发生在 runToolCalls 内部（带 allowAlwaysOnApproval 二次校验），
    // 没有对外的「直接添加」接口 ⇒ 白名单的**生效侧目前无测试覆盖**。
    // 记下来而不是伪造一个不存在的接口。
    expect(await alwaysAllowedHandler()).toEqual([]);
    expect(needsConfirmation(SENSITIVE)).toBe(true);
  });

  it('白名单可撤销，且返回当前快照数组', async () => {
    const before = await alwaysAllowedHandler();
    expect(Array.isArray(before)).toBe(true);
    await revokeHandler('nonexistent_tool');
    expect(await alwaysAllowedHandler()).toEqual(before);
  });

  it('撤销不存在的条目不抛错', async () => {
    await expect(revokeHandler('never-existed')).resolves.toBeDefined();
  });
});

describe('确认请求的契约字段（D08/D09 声称已统一到 toolCallId）', () => {
  it('tools:confirm 对未知 toolCallId 不抛错（幂等）', async () => {
    const confirmHandler = registeredHandlers.get('tools:confirm')!;
    await expect(confirmHandler({}, 'no-such-id', true)).resolves.toBe(true);
  });

  it('tools:cancel 对未知 toolCallId 同样幂等', async () => {
    const cancelHandler = registeredHandlers.get('tools:cancel')!;
    await expect(cancelHandler({}, 'no-such-id')).resolves.toBe(true);
  });

  it('确认结果被强制转成布尔（传入真值非布尔也不影响契约）', async () => {
    const confirmHandler = registeredHandlers.get('tools:confirm')!;
    await expect(confirmHandler({}, 'x', 1, 1)).resolves.toBe(true);
  });
});

describe('本文件不触发网络与命令执行', () => {
  it('导入 ai-router 后没有向窗口发过任何消息', () => {
    // 兜底自检：若将来有人在模块顶层跑 runToolCalls，
    // 这条会红并指出「副作用漏到了导入期」。
    expect(sentMessages).toEqual([]);
  });
});

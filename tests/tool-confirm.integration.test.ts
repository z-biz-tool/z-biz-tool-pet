import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 工具确认流程集成测试（doc 06 §2.2 P0 / A08 / A12 / D08）
 * 用假 ipcMain 捕获 handler，走真实的 ai-router 策略代码，
 * 断言"必须确认 → 才执行""拒绝 → 不执行""高危命令连确认都不弹"。
 */

type Handler = (event: any, ...args: any[]) => any;
const handlers = new Map<string, Handler>();
const sent: { channel: string; payload: any }[] = [];
const executed: { name: string; params: any }[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
  },
  app: { getPath: (k: string) => `/tmp/zbot-fake-${k}`, isPackaged: false },
}));

vi.mock('../src/main/window-manager', () => ({
  sendToWindows: (channel: string, payload: any) => sent.push({ channel, payload }),
  getAdminWindow: () => null,
  getPetWindow: () => null,
  createAdminWindow: () => undefined,
  isStealthMode: () => true,
  setStealthMode: () => undefined,
}));

vi.mock('../src/main/mcp-tools', () => ({
  getToolDefinitions: () => [{ type: 'function', function: { name: 'execute_command' } }],
  getToolList: () => [{ name: 'execute_command', description: '', requiresConfirmation: true }],
  executeTool: vi.fn(async (name: string, params: any) => {
    executed.push({ name, params });
    return { toolCallId: '', result: '工具已执行', isError: false };
  }),
  // 与真实 mcp-tools 一致：除纯本地无副作用的工具外都要确认；风险等级另由 security.ts 分级
  toolRequiresConfirmation: (name: string) => !['get_datetime', 'control_pet', 'get_pet_stats'].includes(name),
}));

vi.mock('../src/main/ai-providers', () => ({
  chat: vi.fn(async () => ({ content: '最终回答' })),
  streamChat: vi.fn(async () => ({ content: '最终回答' })),
  testConnection: vi.fn(),
  getModels: vi.fn(),
  getProviderFromConfig: vi.fn(() => ({ type: 'openai', supportsTools: true, supportsStreaming: true })),
  BUILTIN_PROVIDERS: [],
}));

vi.mock('../src/main/quick-commands', () => ({
  checkQuickCommand: () => null,
  initQuickCommands: vi.fn(),
}));

vi.mock('../src/main/memory-system', () => ({
  extractMemoryFromConversation: vi.fn(),
  initMemory: vi.fn(),
}));

const router = await import('../src/main/ai-router');
const { runToolCalls, needsConfirmation, requestToolConfirmation, initAiRouter } = router;

const CONFIRM_TIMEOUT_MS = 60_000;

function respond(toolCallId: string, approved: boolean, alwaysAllow = false) {
  const h = handlers.get('tools:confirm');
  if (!h) throw new Error('tools:confirm 未注册');
  return h({} as any, toolCallId, approved, alwaysAllow);
}

beforeEach(() => {
  sent.length = 0;
  executed.length = 0;
  initAiRouter({
    getConfig: () =>
      ({ ollamaUrl: '', modelName: 'm', systemPrompt: '', aiModel: 'm', aiProvider: 'openai' }) as any,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('风险分级决定是否弹确认', () => {
  it('execute_command / open_app 每次都要确认；get_datetime 不用', () => {
    expect(needsConfirmation('execute_command')).toBe(true);
    expect(needsConfirmation('open_app')).toBe(true);
    expect(needsConfirmation('get_datetime')).toBe(false);
    expect(needsConfirmation('不存在的工具')).toBe(true); // 未知按最危险处理
  });
});

describe('确认 → 执行 主链路', () => {
  it('批准后携带 toolCallId/风险等级/可读描述，并真的执行', async () => {
    const response = {
      content: '',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'execute_command', arguments: '{"command":"ls -la"}' },
        },
      ],
    };

    const run = runToolCalls([{ role: 'user', content: 'x' }], 'm', response as any, async () =>
      ({ content: '已列出目录' } as any)
    );

    // 等确认请求发出
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const req = sent.find((s) => s.channel === 'tools:confirmRequest');
    expect(req).toBeTruthy();
    expect(req!.payload.toolCallId).toBe('call_1');
    expect(req!.payload.name).toBe('execute_command');
    expect(req!.payload.riskLevel).toBe(2);
    expect(req!.payload.allowAlways).toBe(false); // DANGEROUS 不给"总是允许"
    expect(req!.payload.description).toContain('ls -la');
    expect(req!.payload.timeout).toBe(CONFIRM_TIMEOUT_MS);

    await respond('call_1', true);
    const out = await run;

    expect(executed).toEqual([{ name: 'execute_command', params: { command: 'ls -la' } }]);
    expect(out.toolResults[0].isError).toBe(false);
    expect(out.final.content).toBe('已列出目录');
  });

  it('拒绝时不执行工具，并把拒绝原因回传给 AI', async () => {
    const response = {
      content: '',
      toolCalls: [
        { id: 'call_2', type: 'function', function: { name: 'open_app', arguments: '{"appName":"Safari"}' } },
      ],
    };
    const run = runToolCalls([{ role: 'user', content: 'x' }], 'm', response as any, async () =>
      ({ content: '好' } as any)
    );
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await respond('call_2', false);
    const out = await run;

    expect(executed).toHaveLength(0);
    expect(out.toolResults[0].isError).toBe(true);
    expect(out.toolResults[0].result).toContain('拒绝');
  });

  it('高危命令在弹确认之前就被拦掉（A12）', async () => {
    const response = {
      content: '',
      toolCalls: [
        {
          id: 'call_3',
          type: 'function',
          function: { name: 'execute_command', arguments: '{"command":"rm -rf /"}' },
        },
      ],
    };
    const out = await runToolCalls([{ role: 'user', content: 'x' }], 'm', response as any, async () =>
      ({ content: '好' } as any)
    );

    expect(sent.filter((s) => s.channel === 'tools:confirmRequest')).toHaveLength(0);
    expect(executed).toHaveLength(0);
    expect(out.toolResults[0].isError).toBe(true);
    expect(out.toolResults[0].result).toContain('安全策略拒绝');
  });
});

describe('确认超时与取消（D09）', () => {
  it('超时未答复按拒绝处理，不会永挂', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const response = {
      content: '',
      toolCalls: [
        { id: 'call_t', type: 'function', function: { name: 'open_app', arguments: '{"appName":"Finder"}' } },
      ],
    };
    const run = runToolCalls([{ role: 'user', content: 'x' }], 'm', response as any, async () =>
      ({ content: '好' } as any)
    );
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 1000);
    const out = await run;

    expect(executed).toHaveLength(0);
    expect(out.toolResults[0].result).toContain('拒绝');
    vi.useRealTimers();
  });

  it('tools:cancel 立即按拒绝收尾', async () => {
    const decision = requestToolConfirmation(
      { id: 'call_c', name: 'execute_command', arguments: { command: 'whoami' } },
      '测试取消'
    );
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const h = handlers.get('tools:cancel');
    expect(h).toBeTruthy();
    await h!({} as any, 'call_c');
    const r = await decision;
    expect(r).toEqual({ approved: false, alwaysAllow: false });
    expect(executed).toHaveLength(0);
  });

  it('对未知 toolCallId 回响应不抛异常（重复点击幂等）', async () => {
    await expect(respond('never-existed', true)).resolves.toBe(true);
  });
});

describe('SENSITIVE 的"总是允许"', () => {
  it('批准并勾选总是允许后，同名工具不再弹确认', async () => {
    const mk = () => ({
      content: '',
      toolCalls: [
        {
          id: `call_s${executed.length}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'function',
          function: { name: 'read_url', arguments: JSON.stringify({ url: 'https://example.com' }) },
        },
      ],
    });
    const first = mk();
    const run1 = runToolCalls([{ role: 'user', content: 'x' }], 'm', first as any, async () => ({ content: 'ok' } as any));
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const payload = sent.find((s) => s.channel === 'tools:confirmRequest')!.payload;
    expect(payload.allowAlways).toBe(true); // SENSITIVE 才允许
    await respond(payload.toolCallId, true, true);
    await run1;

    const before = sent.length;
    const second = mk();
    const run2 = runToolCalls([{ role: 'user', content: 'y' }], 'm', second as any, async () => ({ content: 'ok' } as any));
    const out2 = await run2;
    expect(sent.filter((s) => s.channel === 'tools:confirmRequest')).toHaveLength(before); // 没再弹
    expect(out2.toolResults[0].isError).toBe(false);
  });
});

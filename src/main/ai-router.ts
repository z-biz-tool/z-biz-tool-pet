import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { chat, streamChat, testConnection, getModels, getProviderFromConfig, BUILTIN_PROVIDERS } from './ai-providers';
import type { AIProvider, ChatRequest, ChatResponse } from './ai-providers';
import { getToolDefinitions, getToolList, executeTool, toolRequiresConfirmation } from './mcp-tools';
import type { ToolCall, ToolResult } from './mcp-tools';
import { checkQuickCommand } from './quick-commands';
import { extractMemoryFromConversation } from './memory-system';
import { guardCommand, allowAlwaysOnApproval, describeToolCall, toolRiskLevel, ToolRiskLevel } from './security';
import { acquire, release, recordOutcome, MAX_TOOL_CALLS_PER_TURN } from './tool-limiter';
import { createAdminWindow, getAdminWindow, getPetWindow, sendToWindows } from './window-manager';

/**
 * AI 路由与 MCP 工具编排（doc/优化方案 T3.1）。
 * 安全要点集中在此：高危命令在进入确认前就被拦掉（guardCommand）、
 * DANGEROUS 每次必确认（needsConfirmation）、确认走 toolCallId 契约（D08/D09），
 * 频率窗口/熔断/单轮封顶在执行前统一判定（tool-limiter），
 * 流式与非流式共用同一个 runToolCalls，避免两条路径的安全逻辑漂移。
 * 配置由装配方注入，避免与 index.ts 形成循环依赖。
 */

export interface AiRuntimeConfig {
  aiProvider?: string;
  aiApiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  providers?: any[];
  ollamaUrl: string;
  modelName: string;
  systemPrompt: string;
}

let getConfig: () => AiRuntimeConfig = () => {
  throw new Error('ai-router 未初始化：请先调用 initAiRouter()');
};

export function initAiRouter(deps: { getConfig: () => AiRuntimeConfig }): void {
  getConfig = deps.getConfig;
}

// ---------- 工具确认（04 §3.4，修复 D08/D09） ----------
const CONFIRM_TIMEOUT_MS = 60_000;
/** 会话内"总是允许"白名单，仅对 SENSITIVE 级别开放 */
const alwaysAllowedTools = new Set<string>();
/** toolCallId → 未决的确认请求 */
const pendingConfirmations = new Map<string, (d: { approved: boolean; alwaysAllow: boolean }) => void>();

export function needsConfirmation(name: string): boolean {
  const level = toolRiskLevel(name);
  // DANGEROUS 每次必确认，不接受总是允许
  if (level === ToolRiskLevel.DANGEROUS) return true;
  if (alwaysAllowedTools.has(name)) return false;
  return toolRequiresConfirmation(name);
}

export function requestToolConfirmation(
  toolCall: ToolCall,
  descriptionOverride?: string
): Promise<{ approved: boolean; alwaysAllow: boolean }> {
  return new Promise((resolve) => {
    const settle = (decision: { approved: boolean; alwaysAllow: boolean }) => {
      if (!pendingConfirmations.has(toolCall.id)) return;
      pendingConfirmations.delete(toolCall.id);
      clearTimeout(timer);
      resolve(decision);
    };
    pendingConfirmations.set(toolCall.id, settle);
    const timer = setTimeout(() => {
      console.warn('[Z-Bot Main] 工具确认超时，按拒绝处理:', toolCall.name);
      settle({ approved: false, alwaysAllow: false });
    }, CONFIRM_TIMEOUT_MS);

    const payload = {
      toolCallId: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      riskLevel: toolRiskLevel(toolCall.name),
      description: descriptionOverride
        ? `${descriptionOverride}\n${describeToolCall(toolCall.name, toolCall.arguments)}`
        : describeToolCall(toolCall.name, toolCall.arguments),
      timeout: CONFIRM_TIMEOUT_MS,
      allowAlways: allowAlwaysOnApproval(toolCall.name),
    };
    // 字段统一为 toolCallId（D08 的两端不一致由此消除）
    sendToWindows('tools:confirmRequest', payload);
    // 确认对话框在管理端；未创建时才拉起，避免每次风险工具都强制切换窗口
    if (!getAdminWindow()) createAdminWindow();
  });
}

ipcMain.handle('tools:confirm', async (_, toolCallId: string, approved: boolean, alwaysAllow?: boolean) => {
  pendingConfirmations.get(toolCallId)?.({ approved: !!approved, alwaysAllow: !!alwaysAllow });
  return true;
});

// 渲染端主动取消（修复 D09：此前 preload 未暴露 toolsCancel）
ipcMain.handle('tools:cancel', async (_, toolCallId: string) => {
  pendingConfirmations.get(toolCallId)?.({ approved: false, alwaysAllow: false });
  return true;
});

function runShellWithTimeout(
  command: string,
  timeoutMs: number
): Promise<{ ok: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message).slice(0, 500) });
      else resolve({ ok: true, output: (stdout || '').slice(0, 5000) });
    });
  });
}

/**
 * 定时任务里的 shell 动作必须经用户确认后才执行（T1.3，修复 D03）
 */
export async function requestTaskCommand(
  taskName: string,
  command: string
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const guard = guardCommand(command);
  if (!guard.allowed) {
    console.warn('[Z-Bot Main] 任务命令被安全策略拒绝:', guard.reason);
    return { ok: false, error: `命令被安全策略拒绝: ${guard.reason}` };
  }
  const toolCall: ToolCall = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'execute_command',
    arguments: { command },
  };
  console.log(`[Z-Bot Main] 任务「${taskName}」请求执行命令，等待用户确认`);
  const decision = await requestToolConfirmation(toolCall, `定时任务「${taskName}」想要执行命令`);
  if (!decision.approved) return { ok: false, error: '用户拒绝执行任务命令' };
  return runShellWithTimeout(command, 10_000);
}

function maybeExtractMemory(messages: ChatRequest['messages']) {
  const now = new Date().toISOString();
  const normRole = (role: string): 'user' | 'assistant' | 'system' =>
    role === 'assistant' || role === 'system' ? (role as 'assistant' | 'system') : 'user';
  extractMemoryFromConversation(
    messages.map((m, i) => ({
      id: `m_${i}_${Date.now()}`,
      role: normRole(m.role),
      content: typeof m.content === 'string' ? m.content : '',
      timestamp: now,
    }))
  );
}

/**
 * 执行 AI 返回的工具调用：高危拦截 → 用户确认 → 执行 → 追问。
 * 非流式 ai:chat 与流式 ai:streamChat 共用，避免两条路径的安全逻辑漂移。
 */
export async function runToolCalls(
  originalMessages: ChatRequest['messages'],
  model: string,
  response: ChatResponse,
  followUp: (req: ChatRequest) => Promise<ChatResponse>
): Promise<{ toolResults: ToolResult[]; final: ChatResponse }> {
  const toolResults: ToolResult[] = [];
  let executed = 0;

  for (const tc of response.toolCalls || []) {
    const toolCall: ToolCall = {
      id: tc.id || `call_${Date.now()}`,
      name: tc.function?.name || tc.name || '',
      arguments: typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function?.arguments || {},
    };

    // 高危命令在进入确认前直接拒绝（04 §3.3 FORBIDDEN）
    if (toolCall.name === 'execute_command') {
      const guard = guardCommand(String(toolCall.arguments.command ?? ''));
      if (!guard.allowed) {
        toolResults.push({
          toolCallId: toolCall.id,
          result: `操作被安全策略拒绝: ${guard.reason}`,
          isError: true,
        });
        continue;
      }
    }

    // 限流/熔断在确认弹窗之前判定，避免无谓打扰用户（02 §2.9）
    if (executed >= MAX_TOOL_CALLS_PER_TURN) {
      toolResults.push({
        toolCallId: toolCall.id,
        result: `本轮工具调用已达上限 ${MAX_TOOL_CALLS_PER_TURN} 次，请基于已有结果直接回答`,
        isError: true,
      });
      continue;
    }
    const slot = acquire(toolCall.name);
    if (!slot.allowed) {
      toolResults.push({ toolCallId: toolCall.id, result: slot.reason, isError: true });
      continue;
    }

    if (needsConfirmation(toolCall.name)) {
      const decision = await requestToolConfirmation(toolCall);
      if (!decision.approved) {
        // 未真正执行，归还频率配额
        release(toolCall.name);
        toolResults.push({ toolCallId: toolCall.id, result: '用户拒绝了此操作', isError: true });
        continue;
      }
      if (decision.alwaysAllow && allowAlwaysOnApproval(toolCall.name)) {
        alwaysAllowedTools.add(toolCall.name);
      }
    }

    const result = await executeTool(toolCall.name, toolCall.arguments);
    result.toolCallId = toolCall.id;
    recordOutcome(toolCall.name, !result.isError);
    executed += 1;
    toolResults.push(result);

    // 特殊处理: control_pet 触发动画
    if (toolCall.name === 'control_pet') {
      getPetWindow()?.webContents.send('pet:triggerAnimation', toolCall.arguments.action);
      getAdminWindow()?.webContents.send('pet:triggerAnimation', toolCall.arguments.action);
      if (toolCall.arguments.color) {
        getPetWindow()?.webContents.send('pet:applySkinData', {
          id: 'ai-theme',
          name: 'AI主题',
          colors: {
            body: toolCall.arguments.color,
            bodyLight: toolCall.arguments.color,
            bodyDark: toolCall.arguments.color,
            eye: '#fff',
            blush: 'rgba(255,105,180,0.5)',
            accent: toolCall.arguments.color,
          },
          isCustom: true,
        });
      }
    }
  }

  const followUpRequest: ChatRequest = {
    messages: [
      ...originalMessages,
      { role: 'assistant' as const, content: response.content || '', toolCalls: response.toolCalls },
      ...toolResults.map((tr) => ({ role: 'tool' as const, content: tr.result })),
    ],
    model,
    stream: false,
  };
  return { toolResults, final: await followUp(followUpRequest) };
}

// ---------- IPC: AI引擎 ----------
ipcMain.handle('ai:chat', async (_, request: ChatRequest) => {
  try {
    const config = getConfig();
    const provider = getProviderFromConfig(config as any);
    const req: ChatRequest = {
      ...request,
      model: request.model || config.aiModel || config.modelName,
    };
    // 注入工具定义
    if (provider.supportsTools) {
      req.tools = getToolDefinitions();
    }
    const response = await chat(provider, req);

    // 检查是否匹配快捷指令
    const matchedCommand = checkQuickCommand(request.messages[request.messages.length - 1]?.content || '');
    if (matchedCommand) {
      console.log('[Z-Bot Main] 匹配到快捷指令:', matchedCommand.name);
      return { content: matchedCommand.response, toolCalls: undefined };
    }

    // 处理工具调用（与非流式路径共用 runToolCalls，安全逻辑不分叉）
    if (response.toolCalls && response.toolCalls.length > 0) {
      const { toolResults, final } = await runToolCalls(
        request.messages,
        req.model,
        response,
        (followUpRequest) => chat(provider, followUpRequest)
      );
      maybeExtractMemory(request.messages);
      return { ...final, toolCalls: response.toolCalls, toolResults };
    }

    // 返回最终响应（此处 response 必定没有 toolCalls；D02 的 followUpResponse 引用已移除）
    maybeExtractMemory(request.messages);
    return response;
  } catch (error: any) {
    console.error('[Z-Bot Main] AI聊天错误:', error.message);
    return { content: `抱歉，AI请求失败: ${error.message}`, toolCalls: undefined };
  }
});

ipcMain.handle('ai:testConnection', async (_, providerConfig?: AIProvider) => {
  try {
    if (providerConfig) {
      return await testConnection(providerConfig);
    }
    const config = getConfig();
    const provider = getProviderFromConfig(config as any);
    return await testConnection(provider);
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai:getModels', async (_, providerConfig?: AIProvider) => {
  try {
    if (providerConfig) {
      return await getModels(providerConfig);
    }
    const config = getConfig();
    const provider = getProviderFromConfig(config as any);
    return await getModels(provider);
  } catch {
    return [];
  }
});

ipcMain.handle('ai:streamChat', async (event, request: ChatRequest) => {
  const config = getConfig();
  const provider = getProviderFromConfig(config as any);
  const req: ChatRequest = {
    ...request,
    model: request.model || config.aiModel || config.modelName,
  };
  if (provider.supportsTools) {
    req.tools = getToolDefinitions();
  }
  // 只发给发起方，避免 admin 的流式内容串进 pet 窗口
  const sender = (eventName: string, data: any) => {
    if (!event.sender.isDestroyed()) event.sender.send(eventName, data);
  };
  try {
    // 不支持工具型流式的提供商（claude/gemini 的 SSE 解析未收集 tool_use）退回整段下发
    const canStreamTools = ['ollama', 'openai', 'deepseek', 'qwen', 'custom'].includes(provider.type);
    let response: ChatResponse;
    if (!provider.supportsStreaming || (provider.supportsTools && !canStreamTools)) {
      response = await chat(provider, { ...req, stream: false });
      sender('ai:streamChunk', { content: response.content || '', done: false });
      sender('ai:streamChunk', { content: '', done: true });
    } else {
      response = await streamChat(provider, req, sender);
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const { toolResults, final } = await runToolCalls(
        request.messages,
        req.model,
        response,
        (followUpRequest) => streamChat(provider, { ...followUpRequest, stream: true }, sender)
      );
      maybeExtractMemory(request.messages);
      return { ...final, toolCalls: response.toolCalls, toolResults };
    }

    maybeExtractMemory(request.messages);
    return response;
  } catch (error: any) {
    console.error('[Z-Bot Main] 流式聊天错误:', error.message);
    return { content: `流式请求失败: ${error.message}` };
  }
});

ipcMain.handle('ai:getBuiltinProviders', async () => {
  return BUILTIN_PROVIDERS;
});

// ---------- IPC: MCP工具 ----------
ipcMain.handle('tools:list', async () => {
  return getToolList().map((t) => ({ ...t, riskLevel: toolRiskLevel(t.name) }));
});

// tools:execute 已从 preload 移除（04 §2.1）：工具只能经 ai:chat 的确认流程触发，
// 渲染进程不再具备"绕过确认直接执行"的通道。
ipcMain.handle('tools:alwaysAllowed', async () => Array.from(alwaysAllowedTools));

ipcMain.handle('tools:revokeAlwaysAllowed', async (_, name: string) => {
  alwaysAllowedTools.delete(name);
  return Array.from(alwaysAllowedTools);
});

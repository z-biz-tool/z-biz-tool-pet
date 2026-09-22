import * as https from 'https';
import * as http from 'http';
import { exec, execFile } from 'child_process';
import { clipboard, Notification } from 'electron';
import { guardAppName, guardCommand } from './security';

// ---------- 类型定义 ----------
export interface MCPTool {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
  execute: (params: any) => Promise<string>;
  requiresConfirmation: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  isError: boolean;
}

// ---------- 工具实现 ----------

/** HTTP GET 请求封装 */
function httpGet(url: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * URL 参数校验（doc/优化方案 04 §2.2）：
 * 缺参数要快速失败而不是带着 undefined 去发请求；同时挡掉内网/元数据地址，
 * 避免 AI 用 read_url 探测 127.0.0.1 服务或 169.254.169.254。
 */
export function validateFetchUrl(raw: unknown): { ok: boolean; url?: string; reason?: string } {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, reason: '缺少 url 参数' };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: 'url 格式非法' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: '只允许 http/https' };
  }
  // URL 会把 IPv6 的方括号去掉：http://[::1]:8084 → hostname "::1"
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^f[cd][0-9a-f]{2}:/i.test(host) || // 站点本地 IPv6
    /^fe80:/i.test(host) ||             // 链路本地 IPv6
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^0\.0\.0\.0$/.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (blocked) return { ok: false, reason: '禁止访问内网/环回地址' };
  return { ok: true, url: u.toString() };
}

/** 去除 HTML 标签，提取纯文本 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000); // 限制长度
}

/** 带超时的 exec 封装 */
function execWithTimeout(command: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** 不经过 shell 的执行路径，参数中的元字符不会被二次解析 */
function execFileWithTimeout(
  bin: string,
  args: string[],
  timeout = 10000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

// ---------- 工具列表 ----------

const webSearchTool: MCPTool = {
  name: 'web_search',
  description: '搜索网页，获取搜索结果摘要。输入搜索关键词，返回相关结果。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词',
      },
    },
    required: ['query'],
  },
  requiresConfirmation: false,
  execute: async (params) => {
    const q = typeof params?.query === 'string' ? params.query.trim() : '';
    if (!q) return '缺少 query 参数，无法搜索。';
    const query = encodeURIComponent(q);
    const url = `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`;
    try {
      const data = await httpGet(url, 10000);
      const parsed = JSON.parse(data);
      const results: string[] = [];
      if (parsed.AbstractText) {
        results.push(`摘要: ${parsed.AbstractText}`);
      }
      if (parsed.RelatedTopics) {
        for (const topic of parsed.RelatedTopics.slice(0, 5)) {
          if (topic.Text) {
            results.push(`- ${topic.Text}`);
          }
        }
      }
      if (results.length === 0) {
        return '未找到相关搜索结果。';
      }
      return results.join('\n');
    } catch (e: any) {
      return `搜索失败: ${e.message}`;
    }
  },
};

const readUrlTool: MCPTool = {
  name: 'read_url',
  description: '读取URL网页内容，提取纯文本。输入URL地址，返回页面文本内容。',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要读取的URL地址',
      },
    },
    required: ['url'],
  },
  requiresConfirmation: false,
  execute: async (params) => {
    const check = validateFetchUrl(params?.url);
    if (!check.ok) return `读取URL失败: ${check.reason}`;
    try {
      const html = await httpGet(check.url!, 15000);
      const text = stripHtml(html);
      return text || '无法提取页面文本内容。';
    } catch (e: any) {
      return `读取URL失败: ${e.message}`;
    }
  },
};

const getWeatherTool: MCPTool = {
  name: 'get_weather',
  description: '获取指定城市的天气信息。输入城市名称（中文或英文），返回当前天气状况。',
  parameters: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: '城市名称，如"北京"或"Beijing"',
      },
    },
    required: ['city'],
  },
  requiresConfirmation: false,
  execute: async (params) => {
    const city = encodeURIComponent(params.city);
    try {
      const data = await httpGet(`https://wttr.in/${city}?format=j1&lang=zh`, 10000);
      const parsed = JSON.parse(data);
      const current = parsed.current_condition?.[0];
      if (!current) return '无法获取天气信息。';
      const temp = current.temp_C;
      const feelsLike = current.FeelsLikeC;
      const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || '';
      const humidity = current.humidity;
      const windSpeed = current.windspeedKmph;
      const windDir = current.winddir16Point;
      return `天气: ${desc}\n温度: ${temp}°C (体感 ${feelsLike}°C)\n湿度: ${humidity}%\n风速: ${windSpeed} km/h ${windDir}`;
    } catch (e: any) {
      return `获取天气失败: ${e.message}`;
    }
  },
};

const getDatetimeTool: MCPTool = {
  name: 'get_datetime',
  description: '获取当前日期和时间信息。',
  parameters: {
    type: 'object',
    properties: {},
  },
  requiresConfirmation: false,
  execute: async () => {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const weekday = weekdays[now.getDay()];
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `当前时间: ${year}年${month}月${day}日 星期${weekday} ${hours}:${minutes}:${seconds}`;
  },
};

const setReminderTool: MCPTool = {
  name: 'set_reminder',
  description: '设置提醒，在指定分钟后发送系统通知。参数: message(提醒内容), delayMinutes(延迟分钟数)',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: '提醒内容',
      },
      delayMinutes: {
        type: 'number',
        description: '延迟分钟数',
      },
    },
    required: ['message', 'delayMinutes'],
  },
  requiresConfirmation: false,
  execute: async (params) => {
    const { message, delayMinutes } = params;
    const delayMs = Math.max(1, delayMinutes) * 60 * 1000;
    setTimeout(() => {
      const notification = new Notification({
        title: '⏰ Z-Bot 提醒',
        body: message,
      });
      notification.show();
    }, delayMs);
    return `已设置提醒: ${delayMinutes}分钟后提醒你"${message}"`;
  },
};

const openAppTool: MCPTool = {
  name: 'open_app',
  description: '打开应用程序。macOS使用应用名称打开。此操作需要用户确认。',
  parameters: {
    type: 'object',
    properties: {
      appName: {
        type: 'string',
        description: '应用名称，如"Safari"、"微信"、"Finder"',
      },
    },
    required: ['appName'],
  },
  requiresConfirmation: true,
  execute: async (params) => {
    const { appName } = params;
    // 不再拼接 shell 字符串，改走 execFile（修复 D04 命令注入）
    const guard = guardAppName(String(appName ?? ''));
    if (!guard.allowed) return `打开应用失败: ${guard.reason}`;
    const name = guard.resolved!;
    try {
      if (process.platform === 'darwin') {
        await execFileWithTimeout('open', ['-a', name], 10000);
      } else if (process.platform === 'win32') {
        await execFileWithTimeout('cmd', ['/d', '/s', '/c', 'start', '""', name], 10000);
      } else {
        await execFileWithTimeout('xdg-open', [name], 10000);
      }
      return `已打开应用: ${name}`;
    } catch (e: any) {
      return `打开应用失败: ${e.message}`;
    }
  },
};

const executeCommandTool: MCPTool = {
  name: 'execute_command',
  description: '执行终端命令。此操作需要用户确认，请谨慎使用。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的命令',
      },
    },
    required: ['command'],
  },
  requiresConfirmation: true,
  execute: async (params) => {
    const { command } = params;
    // 二次防线：即便调用方漏了检查，高危命令也不会落到 shell
    const guard = guardCommand(String(command ?? ''));
    if (!guard.allowed) return `操作被安全策略拒绝: ${guard.reason}`;
    try {
      const result = await execWithTimeout(command, 10000);
      return result || '(命令执行成功，无输出)';
    } catch (e: any) {
      return `命令执行失败: ${e.message}`;
    }
  },
};

const controlPetTool: MCPTool = {
  name: 'control_pet',
  description: '控制桌面宠物的动画和行为。可触发动画(dance/roll/jump/wave/sleep)或改变皮肤颜色。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '动作类型: dance(跳舞), roll(翻滚), jump(跳跃), wave(挥手), sleep(睡觉)',
        enum: ['dance', 'roll', 'jump', 'wave', 'sleep'],
      },
      color: {
        type: 'string',
        description: '改变宠物皮肤颜色(可选)，如"#ff6600"',
      },
    },
    required: ['action'],
  },
  requiresConfirmation: false,
  execute: async (params) => {
    // 实际的宠物控制通过IPC发送到渲染进程
    // 这里只返回描述，实际触发在主进程的IPC handler中
    const { action, color } = params;
    let desc = `宠物执行动作: ${action}`;
    if (color) desc += `，颜色变为: ${color}`;
    return desc;
  },
};

const screenshotAnalyzeTool: MCPTool = {
  name: 'screenshot_analyze',
  description: '截取屏幕截图并分析内容。截图后发送给视觉语言模型进行分析。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '对截图的问题或分析要求',
      },
    },
    required: ['question'],
  },
  requiresConfirmation: false,
  execute: async (params) => {
    // 截图实际在主进程IPC handler中执行
    return `截图分析请求: ${params.question}`;
  },
};

const clipboardReadTool: MCPTool = {
  name: 'clipboard_read',
  description: '读取系统剪贴板内容。',
  parameters: {
    type: 'object',
    properties: {},
  },
  requiresConfirmation: false,
  execute: async () => {
    try {
      const text = clipboard.readText();
      if (text) {
        return `剪贴板内容: ${text.slice(0, 2000)}`;
      }
      // 尝试读取图片
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        return '剪贴板包含图片内容（已获取）';
      }
      return '剪贴板为空';
    } catch (e: any) {
      return `读取剪贴板失败: ${e.message}`;
    }
  },
};

const clipboardWriteTool: MCPTool = {
  name: 'clipboard_write',
  description: '写入内容到系统剪贴板。此操作需要用户确认。',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要写入剪贴板的文本内容',
      },
    },
    required: ['text'],
  },
  requiresConfirmation: true,
  execute: async (params) => {
    try {
      clipboard.writeText(params.text);
      return `已写入剪贴板: ${params.text.slice(0, 100)}`;
    } catch (e: any) {
      return `写入剪贴板失败: ${e.message}`;
    }
  },
};

// ---------- 工具注册表 ----------
const ALL_TOOLS: MCPTool[] = [
  webSearchTool,
  readUrlTool,
  getWeatherTool,
  getDatetimeTool,
  setReminderTool,
  openAppTool,
  executeCommandTool,
  controlPetTool,
  screenshotAnalyzeTool,
  clipboardReadTool,
  clipboardWriteTool,
];

const toolMap = new Map<string, MCPTool>();
for (const tool of ALL_TOOLS) {
  toolMap.set(tool.name, tool);
}

/** 获取所有工具定义（用于注入AI请求） */
export function getToolDefinitions(): any[] {
  return ALL_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** 获取工具列表信息 */
export function getToolList(): { name: string; description: string; requiresConfirmation: boolean }[] {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    requiresConfirmation: t.requiresConfirmation,
  }));
}

/** 检查工具是否需要确认 */
export function toolRequiresConfirmation(name: string): boolean {
  const tool = toolMap.get(name);
  return tool?.requiresConfirmation ?? true; // 未知工具默认需要确认
}

/** 执行工具 */
export async function executeTool(name: string, params: any): Promise<ToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return {
      toolCallId: '',
      result: `未知工具: ${name}`,
      isError: true,
    };
  }
  try {
    const result = await tool.execute(params);
    return {
      toolCallId: '',
      result,
      isError: false,
    };
  } catch (e: any) {
    return {
      toolCallId: '',
      result: `工具执行错误: ${e.message}`,
      isError: true,
    };
  }
}

/** 解析AI响应中的tool_calls（支持Ollama格式） */
export function parseToolCalls(data: any): ToolCall[] {
  const calls: ToolCall[] = [];

  // Ollama 格式: message.tool_calls
  if (data.message?.tool_calls) {
    for (const tc of data.message.tool_calls) {
      calls.push({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.function?.name || tc.name || '',
        arguments: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || tc.arguments || {},
      });
    }
  }

  // OpenAI 格式: tool_calls at top level
  if (data.tool_calls) {
    for (const tc of data.tool_calls) {
      calls.push({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.function?.name || '',
        arguments: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || {},
      });
    }
  }

  return calls;
}

/** 将工具定义转为Ollama格式 */
export function getOllamaToolsFormat(): any[] {
  return ALL_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

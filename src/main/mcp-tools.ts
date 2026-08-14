import * as https from 'https';
import * as http from 'http';
import { exec, execSync } from 'child_process';
import { clipboard, Notification, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

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
    const query = encodeURIComponent(params.query);
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
    try {
      const html = await httpGet(params.url, 15000);
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
    try {
      if (process.platform === 'darwin') {
        await execWithTimeout(`open -a "${appName}"`, 10000);
      } else if (process.platform === 'win32') {
        await execWithTimeout(`start "" "${appName}"`, 10000);
      } else {
        await execWithTimeout(`xdg-open "${appName}"`, 10000);
      }
      return `已打开应用: ${appName}`;
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

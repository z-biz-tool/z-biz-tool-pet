import { BrowserWindow } from 'electron';

// ==================== 类型定义 ====================

export interface AIProvider {
  id: string;
  name: string;
  type: 'ollama' | 'openai' | 'claude' | 'gemini' | 'deepseek' | 'qwen' | 'custom';
  baseUrl: string;
  apiKey?: string;
  models: string[];
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

export interface ChatRequest {
  messages: Array<{ role: string; content: string; images?: string[] }>;
  model: string;
  stream?: boolean;
  tools?: any[];
}

export interface ChatResponse {
  content: string;
  toolCalls?: any[];
}

// ==================== 内置提供商模板 ====================

export const BUILTIN_PROVIDERS: AIProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    models: ['qwen2.5:7b-instruct-q4_K_M', 'llama3.2-vision', 'gemma2:9b'],
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'qwen',
    name: '通义千问',
    type: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    apiKey: '',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-vl-plus'],
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'claude',
    name: 'Claude',
    type: 'claude',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
  },
];

// ==================== 各提供商 chat 实现 ====================

/** Ollama: POST /api/chat */
async function chatOllama(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
  const url = `${provider.baseUrl}/api/chat`;
  const body: any = {
    model: request.model,
    messages: request.messages.map((m) => {
      if (m.images && m.images.length > 0) {
        return { role: m.role, content: m.content, images: m.images };
      }
      return { role: m.role, content: m.content };
    }),
    stream: false,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Ollama 请求失败 (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  return {
    content: data.message?.content || '',
    toolCalls: data.message?.tool_calls,
  };
}

/** OpenAI兼容 (OpenAI/DeepSeek/通义千问/自定义): POST /v1/chat/completions */
async function chatOpenAICompatible(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
  const url = `${provider.baseUrl}/v1/chat/completions`;
  const messages = request.messages.map((m) => {
    if (m.images && m.images.length > 0) {
      // OpenAI vision 格式
      const content: any[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        content.push({
          type: 'image_url',
          image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` },
        });
      }
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });

  const body: any = {
    model: request.model,
    messages,
    stream: false,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const headers: any = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI兼容 请求失败 (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || '',
    toolCalls: choice?.message?.tool_calls,
  };
}

/** Claude: POST /v1/messages */
async function chatClaude(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
  const url = `${provider.baseUrl}/v1/messages`;
  const systemMsg = request.messages.find((m) => m.role === 'system');
  const otherMsgs = request.messages.filter((m) => m.role !== 'system');

  const messages = otherMsgs.map((m) => {
    if (m.images && m.images.length > 0) {
      // Claude vision 格式
      const content: any[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        const base64Data = img.startsWith('data:') ? img.split(',')[1] : img;
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
        });
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
  });

  const body: any = {
    model: request.model,
    max_tokens: 4096,
    messages,
  };
  if (systemMsg) {
    body.system = systemMsg.content;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t: any) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.parameters,
    }));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude 请求失败 (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  let content = '';
  const toolCalls: any[] = [];
  for (const block of data.content || []) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
}

/** Gemini: POST /v1beta/models/{model}:generateContent */
async function chatGemini(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
  const model = request.model;
  const url = `${provider.baseUrl}/v1beta/models/${model}:generateContent?key=${provider.apiKey || ''}`;

  const systemMsg = request.messages.find((m) => m.role === 'system');
  const otherMsgs = request.messages.filter((m) => m.role !== 'system');

  const contents = otherMsgs.map((m) => {
    const parts: any[] = [{ text: m.content }];
    if (m.images && m.images.length > 0) {
      for (const img of m.images) {
        const base64Data = img.startsWith('data:') ? img.split(',')[1] : img;
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: base64Data } });
      }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const body: any = { contents };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = [{ functionDeclarations: request.tools.map((t: any) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      parameters: t.function?.parameters || t.parameters,
    }))}];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini 请求失败 (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  const candidate = data.candidates?.[0];
  let content = '';
  const toolCalls: any[] = [];
  for (const part of candidate?.content?.parts || []) {
    if (part.text) {
      content += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      });
    }
  }
  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
}

// ==================== 统一 chat 入口 ====================

export async function chat(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
  switch (provider.type) {
    case 'ollama':
      return chatOllama(provider, request);
    case 'openai':
    case 'deepseek':
    case 'qwen':
    case 'custom':
      return chatOpenAICompatible(provider, request);
    case 'claude':
      return chatClaude(provider, request);
    case 'gemini':
      return chatGemini(provider, request);
    default:
      throw new Error(`不支持的提供商类型: ${provider.type}`);
  }
}

// ==================== 流式 chat (SSE) ====================

export async function streamChat(
  provider: AIProvider,
  request: ChatRequest,
  sender: (event: string, data: any) => void
): Promise<ChatResponse> {
  request.stream = true;

  switch (provider.type) {
    case 'ollama':
      return streamOllama(provider, request, sender);
    case 'openai':
    case 'deepseek':
    case 'qwen':
    case 'custom':
      return streamOpenAICompatible(provider, request, sender);
    case 'claude':
      return streamClaude(provider, request, sender);
    case 'gemini':
      return streamGemini(provider, request, sender);
    default:
      throw new Error(`不支持的流式提供商类型: ${provider.type}`);
  }
}

async function streamOllama(
  provider: AIProvider,
  request: ChatRequest,
  sender: (event: string, data: any) => void
): Promise<ChatResponse> {
  const url = `${provider.baseUrl}/api/chat`;
  const body: any = {
    model: request.model,
    messages: request.messages.map((m) => {
      if (m.images && m.images.length > 0) {
        return { role: m.role, content: m.content, images: m.images };
      }
      return { role: m.role, content: m.content };
    }),
    stream: true,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Ollama 流式请求失败 (${response.status}): ${errText}`);
  }

  let fullContent = '';
  const reader = response.body;
  if (!reader) throw new Error('Ollama 流式响应无 body');

  const decoder = new TextDecoder();
  const buffer: string[] = [];

  // @ts-ignore - Node.js ReadableStream 兼容
  for await (const chunk of reader as AsyncIterable<Buffer>) {
    buffer.push(decoder.decode(chunk, { stream: true }));
    const text = buffer.join('');
    const lines = text.split('\n').filter((l) => l.trim());
    buffer.length = 0;
    // 保留不完整的行
    if (!text.endsWith('\n')) {
      buffer.push(lines.pop() || '');
    }
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message?.content) {
          fullContent += data.message.content;
          sender('ai:streamChunk', { content: data.message.content, done: false });
        }
        if (data.done) {
          sender('ai:streamChunk', { content: '', done: true });
        }
      } catch { /* skip */ }
    }
  }

  return { content: fullContent };
}

async function streamOpenAICompatible(
  provider: AIProvider,
  request: ChatRequest,
  sender: (event: string, data: any) => void
): Promise<ChatResponse> {
  const url = `${provider.baseUrl}/v1/chat/completions`;
  const messages = request.messages.map((m) => {
    if (m.images && m.images.length > 0) {
      const content: any[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        content.push({
          type: 'image_url',
          image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` },
        });
      }
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });

  const body: any = { model: request.model, messages, stream: true };
  const headers: any = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI兼容 流式请求失败 (${response.status}): ${errText}`);
  }

  let fullContent = '';
  const reader = response.body;
  if (!reader) throw new Error('流式响应无 body');

  const decoder = new TextDecoder();
  const buffer: string[] = [];

  // @ts-ignore
  for await (const chunk of reader as AsyncIterable<Buffer>) {
    buffer.push(decoder.decode(chunk, { stream: true }));
    const text = buffer.join('');
    const lines = text.split('\n').filter((l) => l.trim());
    buffer.length = 0;
    if (!text.endsWith('\n')) {
      buffer.push(lines.pop() || '');
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') {
        sender('ai:streamChunk', { content: '', done: true });
        continue;
      }
      try {
        const data = JSON.parse(dataStr);
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          sender('ai:streamChunk', { content: delta, done: false });
        }
      } catch { /* skip */ }
    }
  }

  return { content: fullContent };
}

async function streamClaude(
  provider: AIProvider,
  request: ChatRequest,
  sender: (event: string, data: any) => void
): Promise<ChatResponse> {
  const url = `${provider.baseUrl}/v1/messages`;
  const systemMsg = request.messages.find((m) => m.role === 'system');
  const otherMsgs = request.messages.filter((m) => m.role !== 'system');

  const messages = otherMsgs.map((m) => {
    if (m.images && m.images.length > 0) {
      const content: any[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        const base64Data = img.startsWith('data:') ? img.split(',')[1] : img;
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
        });
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
  });

  const body: any = {
    model: request.model,
    max_tokens: 4096,
    messages,
    stream: true,
  };
  if (systemMsg) {
    body.system = systemMsg.content;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude 流式请求失败 (${response.status}): ${errText}`);
  }

  let fullContent = '';
  const reader = response.body;
  if (!reader) throw new Error('Claude 流式响应无 body');

  const decoder = new TextDecoder();
  const buffer: string[] = [];

  // @ts-ignore
  for await (const chunk of reader as AsyncIterable<Buffer>) {
    buffer.push(decoder.decode(chunk, { stream: true }));
    const text = buffer.join('');
    const lines = text.split('\n').filter((l) => l.trim());
    buffer.length = 0;
    if (!text.endsWith('\n')) {
      buffer.push(lines.pop() || '');
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') {
        sender('ai:streamChunk', { content: '', done: true });
        continue;
      }
      try {
        const data = JSON.parse(dataStr);
        if (data.type === 'content_block_delta' && data.delta?.text) {
          fullContent += data.delta.text;
          sender('ai:streamChunk', { content: data.delta.text, done: false });
        } else if (data.type === 'message_stop') {
          sender('ai:streamChunk', { content: '', done: true });
        }
      } catch { /* skip */ }
    }
  }

  return { content: fullContent };
}

async function streamGemini(
  provider: AIProvider,
  request: ChatRequest,
  sender: (event: string, data: any) => void
): Promise<ChatResponse> {
  const model = request.model;
  const url = `${provider.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${provider.apiKey || ''}`;

  const systemMsg = request.messages.find((m) => m.role === 'system');
  const otherMsgs = request.messages.filter((m) => m.role !== 'system');

  const contents = otherMsgs.map((m) => {
    const parts: any[] = [{ text: m.content }];
    if (m.images && m.images.length > 0) {
      for (const img of m.images) {
        const base64Data = img.startsWith('data:') ? img.split(',')[1] : img;
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: base64Data } });
      }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const body: any = { contents };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini 流式请求失败 (${response.status}): ${errText}`);
  }

  let fullContent = '';
  const reader = response.body;
  if (!reader) throw new Error('Gemini 流式响应无 body');

  const decoder = new TextDecoder();
  const buffer: string[] = [];

  // @ts-ignore
  for await (const chunk of reader as AsyncIterable<Buffer>) {
    buffer.push(decoder.decode(chunk, { stream: true }));
    const text = buffer.join('');
    const lines = text.split('\n').filter((l) => l.trim());
    buffer.length = 0;
    if (!text.endsWith('\n')) {
      buffer.push(lines.pop() || '');
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      try {
        const data = JSON.parse(dataStr);
        const parts = data.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            fullContent += part.text;
            sender('ai:streamChunk', { content: part.text, done: false });
          }
        }
      } catch { /* skip */ }
    }
  }

  sender('ai:streamChunk', { content: '', done: true });
  return { content: fullContent };
}

// ==================== 测试连接 ====================

export async function testConnection(provider: AIProvider): Promise<{ success: boolean; error?: string }> {
  try {
    switch (provider.type) {
      case 'ollama': {
        const res = await fetch(`${provider.baseUrl}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
      }
      case 'openai':
      case 'deepseek':
      case 'qwen':
      case 'custom': {
        const headers: any = { 'Content-Type': 'application/json' };
        if (provider.apiKey) {
          headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }
        const res = await fetch(`${provider.baseUrl}/v1/models`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(5000),
        });
        return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
      }
      case 'claude': {
        // Claude 没有专门的 models 列表端点，发一个极小请求测试
        const res = await fetch(`${provider.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey || '',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: provider.models[0] || 'claude-3-5-haiku-20241022',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        // 200 或 400(模型错误) 都说明连接成功
        return { success: res.status < 500, error: res.status >= 500 ? `HTTP ${res.status}` : undefined };
      }
      case 'gemini': {
        const res = await fetch(
          `${provider.baseUrl}/v1beta/models?key=${provider.apiKey || ''}`,
          { method: 'GET', signal: AbortSignal.timeout(5000) }
        );
        return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
      }
      default:
        return { success: false, error: `不支持的提供商类型: ${provider.type}` };
    }
  } catch (e: any) {
    return { success: false, error: e.message || '连接超时' };
  }
}

// ==================== 获取模型列表 ====================

export async function getModels(provider: AIProvider): Promise<string[]> {
  try {
    switch (provider.type) {
      case 'ollama': {
        const res = await fetch(`${provider.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return provider.models;
        const data = await res.json();
        return (data.models || []).map((m: any) => m.name || m.model);
      }
      case 'openai':
      case 'deepseek':
      case 'qwen':
      case 'custom': {
        const headers: any = { 'Content-Type': 'application/json' };
        if (provider.apiKey) {
          headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }
        const res = await fetch(`${provider.baseUrl}/v1/models`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return provider.models;
        const data = await res.json();
        return (data.data || []).map((m: any) => m.id);
      }
      case 'claude': {
        // Claude 没有公开的模型列表 API，返回预设
        return provider.models;
      }
      case 'gemini': {
        const res = await fetch(
          `${provider.baseUrl}/v1beta/models?key=${provider.apiKey || ''}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return provider.models;
        const data = await res.json();
        return (data.models || [])
          .map((m: any) => m.name?.replace('models/', '') || m.name)
          .filter((n: string) => n.includes('gemini'));
      }
      default:
        return provider.models;
    }
  } catch {
    return provider.models;
  }
}

// ==================== 辅助：根据配置获取当前 provider ====================

export function getProviderFromConfig(config: {
  aiProvider: string;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  providers: AIProvider[];
  ollamaUrl: string;
  modelName: string;
}): AIProvider {
  // 优先从 providers 列表查找
  const found = config.providers?.find((p) => p.id === config.aiProvider);
  if (found) return found;

  // 兼容旧配置：根据 aiProvider 字段构建
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === config.aiProvider);
  if (builtin) {
    return {
      ...builtin,
      baseUrl: config.aiBaseUrl || builtin.baseUrl,
      apiKey: config.aiApiKey || builtin.apiKey,
      models: config.aiModel ? [config.aiModel, ...builtin.models] : builtin.models,
    };
  }

  // 默认回退到 ollama
  return {
    ...BUILTIN_PROVIDERS[0],
    baseUrl: config.ollamaUrl || BUILTIN_PROVIDERS[0].baseUrl,
    models: [config.modelName || BUILTIN_PROVIDERS[0].models[0]],
  };
}

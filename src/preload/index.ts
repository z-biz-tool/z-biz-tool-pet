import { contextBridge, ipcRenderer } from 'electron';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface PetConfig {
  ollamaUrl: string;
  modelName: string;
  systemPrompt: string;
  sttUrl: string;
  ttsUrl: string;
  voiceSpeed: number;
  petName: string;
  themeColor: string;
  currentSkinId?: string;
  stealthMode?: boolean;
  aiProvider?: string;
  aiApiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  providers?: any[];
}

export interface PetSkin {
  id: string;
  name: string;
  colors: {
    body: string;
    bodyLight: string;
    bodyDark: string;
    eye: string;
    blush: string;
    accent: string;
  };
  isCustom: boolean;
}

export interface PetStats {
  hunger: number;
  happiness: number;
  energy: number;
  cleanliness: number;
  health: number;
  affection: number;
  age: number;
  stage: 'egg' | 'baby' | 'child' | 'adult';
  bornAt: string;
  lastUpdate: string;
  isSleeping: boolean;
  isSick: boolean;
}

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
  toolResults?: any[];
}

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  toggleWindow: (mode: 'admin' | 'pet') => ipcRenderer.invoke('window:toggle', mode),
  getMode: () => ipcRenderer.invoke('app:getMode'),
  movePetWindow: (deltaX: number, deltaY: number) =>
    ipcRenderer.invoke('window:movePet', deltaX, deltaY),
  setPetPosition: (x: number, y: number) =>
    ipcRenderer.invoke('window:setPetPosition', x, y),
  showWindow: (mode: 'admin' | 'pet') => ipcRenderer.invoke('window:show', mode),
  hideWindow: (mode: 'admin' | 'pet') => ipcRenderer.invoke('window:hide', mode),

  // 贴墙滑下
  stickToEdge: () => ipcRenderer.invoke('window:stickToEdge'),

  // 语音事件
  onVoiceStart: (callback: () => void) => {
    ipcRenderer.on('voice:start', callback);
    return () => ipcRenderer.removeListener('voice:start', callback);
  },
  onVoiceStop: (callback: () => void) => {
    ipcRenderer.on('voice:stop', callback);
    return () => ipcRenderer.removeListener('voice:stop', callback);
  },

  // 截图
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
  captureWindow: (windowName?: string) => ipcRenderer.invoke('screenshot:captureWindow', windowName),
  captureAndAnalyze: (question?: string) => ipcRenderer.invoke('screenshot:captureAndAnalyze', question),

  // 对话历史持久化
  saveHistory: (messages: ChatMessage[]) => ipcRenderer.invoke('history:save', messages),
  loadHistory: () => ipcRenderer.invoke('history:load'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // 配置持久化
  saveConfig: (config: PetConfig) => ipcRenderer.invoke('config:save', config),
  loadConfig: () => ipcRenderer.invoke('config:load'),

  // 兼容旧版 API
  getConversationHistory: () => ipcRenderer.invoke('history:load'),
  addMessageToHistory: (message: ChatMessage) =>
    ipcRenderer.invoke('conversation:addMessage', message),
  clearConversation: () => ipcRenderer.invoke('history:clear'),

  // ---------- 动画系统 IPC ----------
  getCursorPosition: () => ipcRenderer.invoke('pet:getCursorPosition'),
  triggerAnimation: (animType: string) => ipcRenderer.invoke('pet:triggerAnimation', animType),
  setPetPositionWithBounds: (x: number, y: number) => ipcRenderer.invoke('pet:setPosition', x, y),
  onTriggerAnimation: (callback: (animType: string) => void) => {
    ipcRenderer.on('pet:triggerAnimation', (_, animType) => callback(animType));
    return () => ipcRenderer.removeListener('pet:triggerAnimation', callback as any);
  },

  // ---------- 皮肤系统 IPC ----------
  getSkins: () => ipcRenderer.invoke('pet:getSkins'),
  applySkin: (skinId: string) => ipcRenderer.invoke('pet:applySkin', skinId),
  applySkinTheme: (skinData: { name: string; colors: { body: string; bodyLight: string; bodyDark: string; accent?: string } }) =>
    ipcRenderer.invoke('pet:applySkinTheme', skinData),
  onApplySkin: (callback: (skin: PetSkin) => void) => {
    ipcRenderer.on('pet:applySkin', (_, skinId: string) => {
      ipcRenderer.invoke('pet:getSkins').then((skins: PetSkin[]) => {
        const skin = skins.find((s: PetSkin) => s.id === skinId);
        if (skin) callback(skin);
      });
    });
    ipcRenderer.on('pet:applySkinData', (_, skin: PetSkin) => callback(skin));
    return () => {
      ipcRenderer.removeListener('pet:applySkin', callback as any);
      ipcRenderer.removeListener('pet:applySkinData', callback as any);
    };
  },

  // ---------- 截图隐身 IPC ----------
  toggleStealth: (enabled?: boolean) => ipcRenderer.invoke('pet:toggleStealth', enabled),
  getStealthMode: () => ipcRenderer.invoke('pet:getStealthMode'),

  // ---------- 宠物养成系统 IPC ----------
  petGetStats: () => ipcRenderer.invoke('pet:getStats'),
  petFeed: () => ipcRenderer.invoke('pet:feed'),
  petPlay: () => ipcRenderer.invoke('pet:play'),
  petWash: () => ipcRenderer.invoke('pet:wash'),
  petSleep: () => ipcRenderer.invoke('pet:sleep'),
  petMedicine: () => ipcRenderer.invoke('pet:medicine'),
  petPet: () => ipcRenderer.invoke('pet:pet'),

  // ---------- AI引擎 IPC ----------
  aiChat: (request: ChatRequest) => ipcRenderer.invoke('ai:chat', request),
  aiTestConnection: (providerConfig?: AIProvider) => ipcRenderer.invoke('ai:testConnection', providerConfig),
  aiGetModels: (providerConfig?: AIProvider) => ipcRenderer.invoke('ai:getModels', providerConfig),
  aiStreamChat: (request: ChatRequest) => ipcRenderer.invoke('ai:streamChat', request),
  aiGetBuiltinProviders: () => ipcRenderer.invoke('ai:getBuiltinProviders'),
  onAiStreamChunk: (callback: (chunk: { content: string; done: boolean }) => void) => {
    ipcRenderer.on('ai:streamChunk', (_, chunk) => callback(chunk));
    return () => ipcRenderer.removeListener('ai:streamChunk', callback as any);
  },

  // ---------- MCP工具 IPC ----------
  toolsList: () => ipcRenderer.invoke('tools:list'),
  toolsExecute: (name: string, params: any) => ipcRenderer.invoke('tools:execute', name, params),
  toolsConfirm: (toolCallId: string, confirmed: boolean) => ipcRenderer.invoke('tools:confirm', toolCallId, confirmed),
  onToolsConfirmRequest: (callback: (data: { toolCallId: string; name: string; arguments: any }) => void) => {
    ipcRenderer.on('tools:confirmRequest', (_, data) => callback(data));
    return () => ipcRenderer.removeListener('tools:confirmRequest', callback as any);
  },

  // ---------- 语音打断 IPC ----------
  voiceInterrupt: () => ipcRenderer.invoke('voice:interrupt'),
  onVoiceInterrupt: (callback: () => void) => {
    ipcRenderer.on('voice:interrupt', callback);
    return () => ipcRenderer.removeListener('voice:interrupt', callback);
  },

  // ---------- 按住说话 IPC ----------
  onPushToTalkStart: (callback: () => void) => {
    ipcRenderer.on('voice:pushToTalkStart', callback);
    return () => ipcRenderer.removeListener('voice:pushToTalkStart', callback);
  },
  onPushToTalkStop: (callback: () => void) => {
    ipcRenderer.on('voice:pushToTalkStop', callback);
    return () => ipcRenderer.removeListener('voice:pushToTalkStop', callback);
  },

  // ---------- 文件读取 IPC ----------
  fileRead: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  fileReadAsBase64: (filePath: string) => ipcRenderer.invoke('file:readAsBase64', filePath),

  // ---------- Pin卡片 IPC ----------
  pinCreate: (content: string) => ipcRenderer.invoke('pin:create', content),
  pinRemove: (id: string) => ipcRenderer.invoke('pin:remove', id),
  pinList: () => ipcRenderer.invoke('pin:list'),

  // ---------- 会议转录 IPC ----------
  meetingStart: (title: string) => ipcRenderer.invoke('meeting:start', title),
  meetingEnd: () => ipcRenderer.invoke('meeting:end'),
  meetingCancel: () => ipcRenderer.invoke('meeting:cancel'),
  meetingGetState: () => ipcRenderer.invoke('meeting:getState'),
  onMeetingState: (callback: (state: any) => void) => {
    ipcRenderer.on('meeting:state', (_, state) => callback(state));
    return () => ipcRenderer.removeListener('meeting:state', callback as any);
  },
  onMeetingSegment: (callback: (segment: any) => void) => {
    ipcRenderer.on('meeting:segment', (_, segment) => callback(segment));
    return () => ipcRenderer.removeListener('meeting:segment', callback as any);
  },
  onMeetingRollingSummary: (callback: (summary: string) => void) => {
    ipcRenderer.on('meeting:rollingSummary', (_, summary) => callback(summary));
    return () => ipcRenderer.removeListener('meeting:rollingSummary', callback as any);
  },

  // 日志
  log: (msg: string) => ipcRenderer.send('log', msg),
});

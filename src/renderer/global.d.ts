// 全局类型声明 —— 暴露 preload 注入的 electronAPI
// 此文件不包含 export/import，作为 ambient 声明自动全局生效

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface PetConfig {
  ollamaUrl: string;
  modelName: string;
  systemPrompt: string;
  sttUrl: string;
  ttsUrl: string;
  voiceSpeed: number;
  petName: string;
  themeColor: string;
}

interface ScreenshotResult {
  success: boolean;
  path?: string;
  error?: string;
}

interface ElectronAPI {
  // 窗口控制
  toggleWindow: (mode: 'admin' | 'pet') => Promise<void>;
  getMode: () => Promise<'admin' | 'pet'>;
  movePetWindow: (deltaX: number, deltaY: number) => Promise<void>;
  setPetPosition: (x: number, y: number) => Promise<void>;
  showWindow: (mode: 'admin' | 'pet') => Promise<void>;
  hideWindow: (mode: 'admin' | 'pet') => Promise<void>;

  // 语音事件
  onVoiceStart: (callback: () => void) => () => void;
  onVoiceStop: (callback: () => void) => () => void;

  // 截图
  captureScreenshot: () => Promise<ScreenshotResult>;

  // 对话历史持久化
  saveHistory: (messages: ChatMessage[]) => Promise<boolean>;
  loadHistory: () => Promise<ChatMessage[]>;
  clearHistory: () => Promise<boolean>;

  // 配置持久化
  saveConfig: (config: PetConfig) => Promise<boolean>;
  loadConfig: () => Promise<PetConfig>;

  // 兼容旧版 API
  getConversationHistory: () => Promise<ChatMessage[]>;
  addMessageToHistory: (message: ChatMessage) => Promise<number>;
  clearConversation: () => Promise<boolean>;

  // 日志
  log: (msg: string) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}

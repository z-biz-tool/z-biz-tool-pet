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
  currentSkinId?: string;
  stealthMode?: boolean;
}

interface PetSkin {
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

interface PetStats {
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

interface ScreenshotResult {
  success: boolean;
  path?: string;
  error?: string;
}

interface CursorPosition {
  x: number;
  y: number;
}

interface ElectronAPI {
  // 窗口控制
  toggleWindow: (mode: 'admin' | 'pet') => Promise<void>;
  getMode: () => Promise<'admin' | 'pet'>;
  movePetWindow: (deltaX: number, deltaY: number) => Promise<void>;
  setPetPosition: (x: number, y: number) => Promise<void>;
  showWindow: (mode: 'admin' | 'pet') => Promise<void>;
  hideWindow: (mode: 'admin' | 'pet') => Promise<void>;

  // 贴墙滑下
  stickToEdge: () => Promise<void>;

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

  // 动画系统
  getCursorPosition: () => Promise<CursorPosition>;
  triggerAnimation: (animType: string) => Promise<boolean>;
  setPetPositionWithBounds: (x: number, y: number) => Promise<{ x: number; y: number }>;
  onTriggerAnimation: (callback: (animType: string) => void) => () => void;

  // 皮肤系统
  getSkins: () => Promise<PetSkin[]>;
  applySkin: (skinId: string) => Promise<boolean>;
  applySkinTheme: (skinData: { name: string; colors: { body: string; bodyLight: string; bodyDark: string; accent?: string } }) => Promise<PetSkin>;
  onApplySkin: (callback: (skin: PetSkin) => void) => () => void;

  // 截图隐身
  toggleStealth: (enabled?: boolean) => Promise<boolean>;
  getStealthMode: () => Promise<boolean>;

  // 宠物养成系统
  petGetStats: () => Promise<PetStats>;
  petFeed: () => Promise<PetStats>;
  petPlay: () => Promise<PetStats>;
  petWash: () => Promise<PetStats>;
  petSleep: () => Promise<PetStats>;
  petMedicine: () => Promise<PetStats>;
  petPet: () => Promise<PetStats>;

  // 日志
  log: (msg: string) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}

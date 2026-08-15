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
  aiProvider?: string;
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  providers?: AIProvider[];
}

interface AIProvider {
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

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface ToolResult {
  toolCallId: string;
  result: string;
  isError: boolean;
}

interface ToolInfo {
  name: string;
  description: string;
  requiresConfirmation: boolean;
}

interface ToolConfirmRequest {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface PinItem {
  id: string;
  content: string;
  messageId: string;
  createdAt: string;
}

interface FileReadResult {
  success: boolean;
  content?: string;
  error?: string;
}

interface FileBase64Result {
  success: boolean;
  base64?: string;
  mimeType?: string;
  error?: string;
}

interface AIConnectionTestResult {
  success: boolean;
  error?: string;
}

interface AIModelsResult {
  success: boolean;
  models?: string[];
  error?: string;
}

interface ChatRequest {
  messages: Array<{ role: string; content: string; images?: string[]; toolCalls?: any[]; toolCallId?: string }>;
  model: string;
  stream?: boolean;
  tools?: any[];
}

interface ChatResponse {
  content: string;
  toolCalls?: any[];
  toolResults?: any[];
}

interface ScreenshotWindowResult {
  success: boolean;
  path?: string;
  imageBase64?: string;
  error?: string;
}

interface CaptureAnalyzeResult {
  success: boolean;
  analysis?: string;
  imageBase64?: string;
  error?: string;
}

interface MeetingSegment {
  id: string;
  text: string;
  timestamp: string;
  startMs: number;
}

interface MeetingState {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  segments: MeetingSegment[];
  rollingSummary: string;
  finalSummary?: string;
  transcriptPath?: string;
  status: 'idle' | 'recording' | 'processing' | 'done' | 'error';
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

  // 贴墙滑下
  stickToEdge: () => Promise<void>;

  // 语音事件
  onVoiceStart: (callback: () => void) => () => void;
  onVoiceStop: (callback: () => void) => () => void;

  // 语音打断
  onVoiceInterrupt: (callback: () => void) => () => void;
  sendVoiceInterrupt: () => void;

  // 按住快捷键说话
  onPushToTalkStart: (callback: () => void) => () => void;

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

  // MCP 工具调用
  toolsList: () => Promise<ToolInfo[]>;
  toolsGetDefinitions: () => Promise<any[]>;
  toolsRequiresConfirmation: (toolName: string) => Promise<boolean>;
  toolsExecute: (toolCall: ToolCall) => Promise<ToolResult>;
  toolsConfirm: (toolCallId: string, alwaysAllow: boolean) => void;
  toolsCancel: (toolCallId: string) => void;
  onToolsConfirmRequest: (callback: (data: ToolConfirmRequest) => void) => () => void;

  // 文件读取
  fileRead: (filePath: string) => Promise<FileReadResult>;
  fileReadAsBase64: (filePath: string) => Promise<FileBase64Result>;

  // Pin 卡片
  pinCreate: (content: string, messageId: string) => Promise<PinItem>;
  pinRemove: (pinId: string) => Promise<boolean>;
  pinList: () => Promise<PinItem[]>;

  // 会议转录
  meetingStart: (title: string) => Promise<{ success: boolean; state?: MeetingState; error?: string }>;
  meetingEnd: () => Promise<{ success: boolean; state?: MeetingState; error?: string }>;
  meetingCancel: () => Promise<{ success: boolean }>;
  meetingGetState: () => Promise<MeetingState>;
  onMeetingState: (callback: (state: MeetingState) => void) => () => void;
  onMeetingSegment: (callback: (segment: MeetingSegment) => void) => () => void;
  onMeetingRollingSummary: (callback: (summary: string) => void) => () => void;

  // 系统通知
  sendNotification: (title: string, body: string) => Promise<boolean>;

  // AI 提供商
  aiGetBuiltinProviders: () => Promise<AIProvider[]>;
  aiTestConnection: (provider: AIProvider) => Promise<AIConnectionTestResult>;
  aiGetModels: (provider: AIProvider) => Promise<AIModelsResult>;

  // 按住快捷键停止
  onPushToTalkStop: (callback: () => void) => () => void;

  // 日志
  log: (msg: string) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}

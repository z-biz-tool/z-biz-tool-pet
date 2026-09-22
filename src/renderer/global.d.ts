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
  interruptThreshold?: number;
  sttModel?: string;
  shortcuts?: Record<string, string>;
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

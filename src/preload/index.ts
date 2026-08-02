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

  // 对话历史持久化（新版：文件存储）
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

  // 日志
  log: (msg: string) => ipcRenderer.send('log', msg),
});

import { contextBridge, ipcRenderer } from 'electron';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

contextBridge.exposeInMainWorld('electronAPI', {
  toggleWindow: (mode: 'admin' | 'pet') => ipcRenderer.invoke('window:toggle', mode),
  getMode: () => ipcRenderer.invoke('app:getMode'),
  onVoiceStart: (callback: () => void) => {
    ipcRenderer.on('voice:start', callback);
    return () => ipcRenderer.removeListener('voice:start', callback);
  },
  onVoiceStop: (callback: () => void) => {
    ipcRenderer.on('voice:stop', callback);
    return () => ipcRenderer.removeListener('voice:stop', callback);
  },
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
  getConversationHistory: () => ipcRenderer.invoke('conversation:getHistory'),
  addMessageToHistory: (message: ChatMessage) => ipcRenderer.invoke('conversation:addMessage', message),
  clearConversation: () => ipcRenderer.invoke('conversation:clear'),
  log: (msg: string) => ipcRenderer.send('log', msg),
});
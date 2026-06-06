import { contextBridge, ipcRenderer } from 'electron';

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
  log: (msg: string) => ipcRenderer.send('log', msg),
});
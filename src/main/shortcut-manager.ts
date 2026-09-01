import { globalShortcut, ipcMain } from 'electron';

// 快捷键状态管理
interface ShortcutState {
  screenshot: boolean;
  note: boolean;
  translateWord: boolean;
  petShowHide: boolean;
  whisperStart: boolean;
}

const shortcuts: ShortcutState = {
  screenshot: false,
  note: false,
  translateWord: false,
  petShowHide: false,
  whisperStart: false,
};

// 注册所有快捷键
export function registerShortcuts(): void {
  // Cmd/Ctrl + Alt + S - 截图分析
  const ret1 = globalShortcut.register('CommandOrControl+Alt+S', () => {
    shortcuts.screenshot = true;
    ipcMain.emit('shortcut:screenshot');
    console.log('[Shortcut] 截图分析触发');
  });
  if (!ret1) console.warn('[Shortcut] 截图快捷键注册失败');
  else console.log('[Shortcut] 截图快捷键已注册: Cmd+Alt+S');

  // Cmd/Ctrl + Alt + N - 快速笔记
  const ret2 = globalShortcut.register('CommandOrControl+Alt+N', () => {
    shortcuts.note = true;
    ipcMain.emit('shortcut:note');
    console.log('[Shortcut] 快速笔记触发');
  });
  if (!ret2) console.warn('[Shortcut] 快速笔记快捷键注册失败');
  else console.log('[Shortcut] 快速笔记快捷键已注册: Cmd+Alt+N');

  // Cmd/Ctrl + Alt + T - 翻译取词
  const ret3 = globalShortcut.register('CommandOrControl+Alt+T', () => {
    shortcuts.translateWord = true;
    ipcMain.emit('shortcut:translateWord');
    console.log('[Shortcut] 翻译取词触发');
  });
  if (!ret3) console.warn('[Shortcut] 翻译取词快捷键注册失败');
  else console.log('[Shortcut] 翻译取词快捷键已注册: Cmd+Alt+T');

  // Cmd/Ctrl + Alt + P - 唤醒宠物
  const ret4 = globalShortcut.register('CommandOrControl+Alt+P', () => {
    shortcuts.whisperStart = true;
    ipcMain.emit('shortcut:whisperStart');
    console.log('[Shortcut] 唤醒宠物触发');
  });
  if (!ret4) console.warn('[Shortcut] 唤醒宠物快捷键注册失败');
  else console.log('[Shortcut] 唤醒宠物快捷键已注册: Cmd+Alt+P');
}

// 卸载所有快捷键
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
  Object.keys(shortcuts).forEach((key) => {
    shortcuts[key as keyof ShortcutState] = false;
  });
}

// 检查快捷键是否已注册
export function isShortcutRegistered(type: keyof ShortcutState): boolean {
  return shortcuts[type];
}

// 设置快捷键状态
export function setShortcutState(type: keyof ShortcutState, enabled: boolean): void {
  shortcuts[type] = enabled;
}

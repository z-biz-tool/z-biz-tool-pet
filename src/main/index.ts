import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  desktopCapturer,
  screen,
  globalShortcut,
  shell,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

app.commandLine.appendSwitch('--disable-gpu');
app.commandLine.appendSwitch('--disable-gpu-compositing');
app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--no-sandbox');
app.commandLine.appendSwitch('--disable-software-rasterizer');

console.log('[Z-Bot Main] 应用启动...');
console.log('[Z-Bot Main] 是否开发模式:', isDev);

let adminWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let sttServer: ChildProcessWithoutNullStreams | null = null;
let ttsServer: ChildProcessWithoutNullStreams | null = null;
let petVisible = false;

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

const DEFAULT_CONFIG: PetConfig = {
  ollamaUrl: 'http://localhost:11434',
  modelName: 'qwen2.5:7b-instruct-q4_K_M',
  systemPrompt: '',
  sttUrl: 'http://localhost:8084',
  ttsUrl: 'http://localhost:8086',
  voiceSpeed: 1.0,
  petName: 'Z-Bot 小猫咪',
  themeColor: '#722ed1',
};

// ---------- 持久化目录 ----------
const dataDir = path.join(app.getPath('home'), '.z-bot');
const historyFile = path.join(dataDir, 'history.json');
const configFile = path.join(dataDir, 'config.json');
const MAX_HISTORY_LENGTH = 200;

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('[Z-Bot Main] 创建数据目录:', dataDir);
  }
}

// ---------- 历史持久化 ----------
function saveHistoryToFile(messages: ChatMessage[]) {
  ensureDataDir();
  try {
    fs.writeFileSync(historyFile, JSON.stringify(messages, null, 2), 'utf-8');
  } catch (e: any) {
    console.error('[Z-Bot Main] 保存历史失败:', e.message);
  }
}

function loadHistoryFromFile(): ChatMessage[] {
  ensureDataDir();
  try {
    if (!fs.existsSync(historyFile)) return [];
    const raw = fs.readFileSync(historyFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: any) {
    console.error('[Z-Bot Main] 读取历史失败:', e.message);
    return [];
  }
}

// ---------- 配置持久化 ----------
function saveConfigToFile(config: PetConfig) {
  ensureDataDir();
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[Z-Bot Main] 配置已保存');
  } catch (e: any) {
    console.error('[Z-Bot Main] 保存配置失败:', e.message);
  }
}

function loadConfigFromFile(): PetConfig {
  ensureDataDir();
  try {
    if (!fs.existsSync(configFile)) return DEFAULT_CONFIG;
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e: any) {
    console.error('[Z-Bot Main] 读取配置失败:', e.message);
    return DEFAULT_CONFIG;
  }
}

// ---------- 窗口创建 ----------
function createAdminWindow() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.show();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'Z-Bot 管理端',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    console.log('[Z-Bot Main] 加载管理端 URL...');
    adminWindow.loadURL('http://localhost:5173/admin/index.html');
    adminWindow.webContents.once('did-finish-load', () => {
      console.log('[Z-Bot Main] 管理端页面加载完成');
      adminWindow?.webContents.openDevTools();
    });
  } else {
    adminWindow.loadFile(path.join(__dirname, '../renderer/admin/index.html'));
  }

  adminWindow.once('ready-to-show', () => {
    adminWindow?.show();
  });

  adminWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      adminWindow?.hide();
    }
  });
}

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    return;
  }
  petWindow = new BrowserWindow({
    width: 200,
    height: 320,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    console.log('[Z-Bot Main] 加载萌宠 URL...');
    petWindow.loadURL('http://localhost:5173/pet/index.html');
    petWindow.webContents.once('did-finish-load', () => {
      console.log('[Z-Bot Main] 萌宠页面加载完成');
    });
  } else {
    petWindow.loadFile(path.join(__dirname, '../renderer/pet/index.html'));
  }

  petWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      petWindow?.hide();
      petVisible = false;
    }
  });
}

// ---------- STT/TTS 服务器 ----------
function startSTTServer() {
  console.log('[Z-Bot Main] 启动 STT 服务器...');
  const sttScript = path.join(__dirname, '../../server/stt.js');
  if (!fs.existsSync(sttScript)) {
    console.warn('[Z-Bot Main] STT 脚本不存在，跳过:', sttScript);
    return;
  }
  sttServer = spawn('node', [sttScript]);
  sttServer.stdout.on('data', (data) => console.log('[STT Server]', data.toString().trim()));
  sttServer.stderr.on('data', (data) => console.error('[STT Server Error]', data.toString().trim()));
  sttServer.on('close', (code) => console.log('[Z-Bot Main] STT 服务器关闭，退出码:', code));
}

function startTTSServer() {
  console.log('[Z-Bot Main] 启动 TTS 服务器...');
  const ttsScript = path.join(__dirname, '../../server/tts.js');
  if (!fs.existsSync(ttsScript)) {
    console.warn('[Z-Bot Main] TTS 脚本不存在，跳过:', ttsScript);
    return;
  }
  ttsServer = spawn('node', [ttsScript]);
  ttsServer.stdout.on('data', (data) => console.log('[TTS Server]', data.toString().trim()));
  ttsServer.stderr.on('data', (data) => console.error('[TTS Server Error]', data.toString().trim()));
  ttsServer.on('close', (code) => console.log('[Z-Bot Main] TTS 服务器关闭，退出码:', code));
}

function stopServers() {
  if (sttServer) {
    console.log('[Z-Bot Main] 关闭 STT 服务器...');
    sttServer.kill();
    sttServer = null;
  }
  if (ttsServer) {
    console.log('[Z-Bot Main] 关闭 TTS 服务器...');
    ttsServer.kill();
    ttsServer = null;
  }
}

// ---------- 托盘 ----------
function createTray() {
  // 生成 16x16 的紫色圆点图标（base64 PNG）
  const iconData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfklEQVR42mNgwA9YwBgY/v//z4Cqg4mBQTQ' +
      'g1oDyDyAHvP+fjIGhATY2BrgBaQ2wAxgG2AGqRjAAGSFhYUgwA6gGgOmgxgKUQ0ANcSAAQ3UgBsYTgOk' +
      'gRkMoJpgYWAQYzAUgxlMZhA1g1kMapgYGBgYGEgAAKzaBw4sR2S2AAAAAElFTkSuQmCC',
    'base64'
  );
  const icon = nativeImage.createFromBuffer(iconData, { scaleFactor: 1.0 });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🐱 显示萌宠',
      click: () => {
        if (!petWindow) createPetWindow();
        petWindow?.show();
        petVisible = true;
      },
    },
    {
      label: '💻 打开管理端',
      click: () => {
        if (!adminWindow) createAdminWindow();
        adminWindow?.show();
        adminWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: '🎙️ 开始语音对话',
      click: () => {
        adminWindow?.webContents.send('voice:start');
        petWindow?.webContents.send('voice:start');
      },
    },
    {
      label: '⏹️ 停止语音对话',
      click: () => {
        adminWindow?.webContents.send('voice:stop');
        petWindow?.webContents.send('voice:stop');
      },
    },
    { type: 'separator' },
    {
      label: '⚙️ 设置',
      click: () => {
        if (!adminWindow) createAdminWindow();
        adminWindow?.show();
        adminWindow?.focus();
        adminWindow?.webContents.send('open:settings');
      },
    },
    {
      label: '🚀 开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: 'separator' },
    {
      label: '❌ 退出',
      click: () => {
        (app as any).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Z-Bot 桌面助手');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (!adminWindow) createAdminWindow();
    adminWindow?.show();
    adminWindow?.focus();
  });
}

// ---------- 全局快捷键 ----------
function registerShortcuts() {
  // Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Win/Linux) 唤起/隐藏萌宠
  const ret = globalShortcut.register('CommandOrControl+Shift+Z', () => {
    console.log('[Z-Bot Main] 快捷键触发: 切换萌宠');
    const win = petWindow;
    if (!win) {
      createPetWindow();
      petWindow?.show();
      petVisible = true;
      return;
    }
    if (petVisible) {
      win.hide();
      petVisible = false;
    } else {
      win.show();
      petVisible = true;
    }
  });
  if (!ret) {
    console.warn('[Z-Bot Main] 全局快捷键注册失败');
  } else {
    console.log('[Z-Bot Main] 全局快捷键已注册: Cmd+Shift+Z');
  }
}

// ---------- IPC: 日志 ----------
ipcMain.on('log', (_, msg: string) => {
  console.log('[Renderer]', msg);
});

// ---------- IPC: 窗口控制 ----------
ipcMain.handle('window:toggle', async (_, mode: 'admin' | 'pet') => {
  if (mode === 'admin') {
    if (!adminWindow) createAdminWindow();
    adminWindow?.show();
    adminWindow?.focus();
    petWindow?.hide();
    petVisible = false;
  } else {
    if (!petWindow) createPetWindow();
    petWindow?.show();
    petVisible = true;
    adminWindow?.hide();
  }
});

ipcMain.handle('window:show', async (_, mode: 'admin' | 'pet') => {
  if (mode === 'admin') {
    if (!adminWindow) createAdminWindow();
    adminWindow?.show();
    adminWindow?.focus();
  } else {
    if (!petWindow) createPetWindow();
    petWindow?.show();
    petVisible = true;
  }
});

ipcMain.handle('window:hide', async (_, mode: 'admin' | 'pet') => {
  if (mode === 'admin') {
    adminWindow?.hide();
  } else {
    petWindow?.hide();
    petVisible = false;
  }
});

ipcMain.handle('app:getMode', async () => {
  return adminWindow?.isVisible() ? 'admin' : 'pet';
});

// ---------- IPC: 萌宠窗口拖拽移动 ----------
ipcMain.handle('window:movePet', async (_, deltaX: number, deltaY: number) => {
  if (!petWindow) return;
  const [x, y] = petWindow.getPosition();
  const [w, h] = petWindow.getSize();
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const { width, height } = display.workAreaSize;
  const newX = Math.max(0, Math.min(width - w, x + deltaX));
  const newY = Math.max(0, Math.min(height - h, y + deltaY));
  petWindow.setPosition(newX, newY);
});

ipcMain.handle('window:setPetPosition', async (_, x: number, y: number) => {
  if (!petWindow) return;
  petWindow.setPosition(Math.round(x), Math.round(y));
});

// ---------- IPC: 截图 ----------
ipcMain.handle('screenshot:capture', async () => {
  console.log('[Z-Bot Main] 开始截图...');
  try {
    const allSources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    const mainSource = allSources[0];
    if (!mainSource || !mainSource.thumbnail) {
      console.error('[Z-Bot Main] 无法获取屏幕截图');
      return { success: false, error: '无法获取屏幕截图' };
    }

    const imageBuffer = mainSource.thumbnail.toPNG();
    const tempDir = app.getPath('temp');
    const screenshotPath = path.join(tempDir, `zbot_screenshot_${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, imageBuffer);
    console.log('[Z-Bot Main] 截图保存成功:', screenshotPath);

    return { success: true, path: screenshotPath };
  } catch (error: any) {
    console.error('[Z-Bot Main] 截图失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ---------- IPC: 历史持久化 ----------
ipcMain.handle('history:save', async (_, messages: ChatMessage[]) => {
  saveHistoryToFile(messages);
  return true;
});

ipcMain.handle('history:load', async () => {
  const history = loadHistoryFromFile();
  console.log('[Z-Bot Main] 加载历史，共', history.length, '条');
  return history;
});

ipcMain.handle('history:clear', async () => {
  saveHistoryToFile([]);
  console.log('[Z-Bot Main] 清空对话历史');
  return true;
});

// 兼容旧版
ipcMain.handle('conversation:getHistory', async () => {
  return loadHistoryFromFile();
});

let inMemoryHistory: ChatMessage[] = [];
ipcMain.handle('conversation:addMessage', async (_, message: ChatMessage) => {
  inMemoryHistory.push(message);
  if (inMemoryHistory.length > MAX_HISTORY_LENGTH) {
    inMemoryHistory = inMemoryHistory.slice(-MAX_HISTORY_LENGTH);
  }
  saveHistoryToFile(inMemoryHistory);
  return inMemoryHistory.length;
});

ipcMain.handle('conversation:clear', async () => {
  inMemoryHistory = [];
  saveHistoryToFile([]);
  return true;
});

// ---------- IPC: 配置持久化 ----------
ipcMain.handle('config:save', async (_, config: PetConfig) => {
  saveConfigToFile(config);
  return true;
});

ipcMain.handle('config:load', async () => {
  const config = loadConfigFromFile();
  console.log('[Z-Bot Main] 加载配置:', config.petName);
  return config;
});

// ---------- 应用生命周期 ----------
app.whenReady().then(() => {
  ensureDataDir();
  // 启动时加载持久化历史到内存
  inMemoryHistory = loadHistoryFromFile();

  startSTTServer();
  startTTSServer();
  createAdminWindow();
  createPetWindow();
  createTray();
  registerShortcuts();

  // 随机处理外链
  app.on('browser-window-created', (_, window) => {
    window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAdminWindow();
      createPetWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopServers();
    app.quit();
  }
});

app.on('before-quit', () => {
  (app as any).isQuitting = true;
  stopServers();
  globalShortcut.unregisterAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}

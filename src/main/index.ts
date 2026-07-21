import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;
console.log('[Z-Bot Main] 应用启动...');
console.log('[Z-Bot Main] 是否开发模式:', isDev);

let adminWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let sttServer: ChildProcessWithoutNullStreams | null = null;
let ttsServer: ChildProcessWithoutNullStreams | null = null;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

let conversationHistory: ChatMessage[] = [];
const MAX_HISTORY_LENGTH = 20;

function createAdminWindow() {
  adminWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
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
    if (!app.isQuitting) {
      e.preventDefault();
      adminWindow?.hide();
    }
  });
}

function createPetWindow() {
  petWindow = new BrowserWindow({
    width: 200,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
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
      // 不自动打开 DevTools
    });
  } else {
    petWindow.loadFile(path.join(__dirname, '../renderer/pet/index.html'));
  }

  petWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      petWindow?.hide();
    }
  });
}

function startSTTServer() {
  console.log('[Z-Bot Main] 启动 STT 服务器...');
  const sttScript = path.join(__dirname, '../../server/stt.js');
  sttServer = spawn('node', [sttScript]);
  
  sttServer.stdout.on('data', (data) => {
    console.log('[STT Server]', data.toString().trim());
  });
  
  sttServer.stderr.on('data', (data) => {
    console.error('[STT Server Error]', data.toString().trim());
  });
  
  sttServer.on('close', (code) => {
    console.log('[Z-Bot Main] STT 服务器关闭，退出码:', code);
  });
}

function startTTSServer() {
  console.log('[Z-Bot Main] 启动 TTS 服务器...');
  const ttsScript = path.join(__dirname, '../../server/tts.js');
  ttsServer = spawn('node', [ttsScript]);
  
  ttsServer.stdout.on('data', (data) => {
    console.log('[TTS Server]', data.toString().trim());
  });
  
  ttsServer.stderr.on('data', (data) => {
    console.error('[TTS Server Error]', data.toString().trim());
  });
  
  ttsServer.on('close', (code) => {
    console.log('[Z-Bot Main] TTS 服务器关闭，退出码:', code);
  });
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

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示萌宠',
      click: () => {
        if (!petWindow) createPetWindow();
        petWindow?.show();
        adminWindow?.hide();
      },
    },
    {
      label: '打开管理端',
      click: () => {
        if (!adminWindow) createAdminWindow();
        adminWindow?.show();
        petWindow?.hide();
      },
    },
    { type: 'separator' },
    {
      label: '开始语音对话',
      click: () => {
        adminWindow?.webContents.send('voice:start');
        petWindow?.webContents.send('voice:start');
      },
    },
    {
      label: '停止语音对话',
      click: () => {
        adminWindow?.webContents.send('voice:stop');
        petWindow?.webContents.send('voice:stop');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Z-Bot 桌面助手');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (!adminWindow) createAdminWindow();
    adminWindow?.show();
    petWindow?.hide();
  });
}

// IPC handlers
ipcMain.on('log', (_, msg: string) => {
  console.log('[Renderer]', msg);
});

ipcMain.handle('window:toggle', async (_, mode: 'admin' | 'pet') => {
  if (mode === 'admin') {
    if (!adminWindow) createAdminWindow();
    adminWindow?.show();
    petWindow?.hide();
  } else {
    if (!petWindow) createPetWindow();
    petWindow?.show();
    adminWindow?.hide();
  }
});

ipcMain.handle('app:getMode', async () => {
  return adminWindow?.isVisible() ? 'admin' : 'pet';
});

ipcMain.handle('screenshot:capture', async () => {
  console.log('[Z-Bot Main] 开始截图...');
  try {
    const displays = screen.getAllDisplays();
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

ipcMain.handle('conversation:getHistory', async () => {
  console.log('[Z-Bot Main] 获取对话历史，共', conversationHistory.length, '条');
  return conversationHistory;
});

ipcMain.handle('conversation:addMessage', async (_, message: ChatMessage) => {
  console.log('[Z-Bot Main] 添加消息:', message.role, message.content.slice(0, 30));
  conversationHistory.push(message);
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
  }
  return conversationHistory.length;
});

ipcMain.handle('conversation:clear', async () => {
  console.log('[Z-Bot Main] 清空对话历史');
  conversationHistory = [];
  return true;
});

app.whenReady().then(() => {
  startSTTServer();
  startTTSServer();
  createAdminWindow();
  createPetWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAdminWindow();
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
  app.isQuitting = true;
  stopServers();
});

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import * as path from 'path';

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;
console.log('[Z-Bot Main] 应用启动...');
console.log('[Z-Bot Main] 是否开发模式:', isDev);

let adminWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

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

app.whenReady().then(() => {
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
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}
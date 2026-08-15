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
import { chat, streamChat, testConnection, getModels, getProviderFromConfig, BUILTIN_PROVIDERS } from './ai-providers';
import type { AIProvider, ChatRequest, ChatResponse } from './ai-providers';
import { getToolDefinitions, getToolList, executeTool, toolRequiresConfirmation, parseToolCalls } from './mcp-tools';
import type { ToolCall, ToolResult } from './mcp-tools';

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
let stealthMode = true; // 截图隐身模式，默认开启

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
  aiApiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  providers?: any[];
}

// ---------- 宠物养成系统 ----------
interface PetStats {
  hunger: number;      // 0-100, 每30分钟-1
  happiness: number;   // 0-100, 每20分钟-1
  energy: number;      // 0-100, 每45分钟-1, 睡觉时+2/分钟
  cleanliness: number; // 0-100, 每60分钟-1
  health: number;      // 0-100, 由其他属性低时自动下降
  affection: number;   // 0-100 好感度, 对话+1, 忽略-1/天
  age: number;         // 天数
  stage: 'egg' | 'baby' | 'child' | 'adult'; // 生命周期
  bornAt: string;      // ISO时间戳
  lastUpdate: string;  // 上次更新时间
  isSleeping: boolean;
  isSick: boolean;
}

const DEFAULT_PET_STATS: PetStats = {
  hunger: 80,
  happiness: 80,
  energy: 80,
  cleanliness: 80,
  health: 100,
  affection: 50,
  age: 0,
  stage: 'egg',
  bornAt: new Date().toISOString(),
  lastUpdate: new Date().toISOString(),
  isSleeping: false,
  isSick: false,
};

const DEFAULT_CONFIG: PetConfig = {
  ollamaUrl: 'http://localhost:11434',
  modelName: 'qwen2.5:7b-instruct-q4_K_M',
  systemPrompt: '',
  sttUrl: 'http://localhost:8084',
  ttsUrl: 'http://localhost:8086',
  voiceSpeed: 1.0,
  petName: 'Z-Bot 小猫咪',
  themeColor: '#722ed1',
  stealthMode: true,
};

// ---------- 持久化目录 ----------
const dataDir = path.join(app.getPath('home'), '.z-bot');
const historyFile = path.join(dataDir, 'history.json');
const configFile = path.join(dataDir, 'config.json');
const petStatsFile = path.join(dataDir, 'pet_stats.json');
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

// ---------- 宠物状态持久化 ----------
function savePetStatsToFile(stats: PetStats) {
  ensureDataDir();
  try {
    fs.writeFileSync(petStatsFile, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (e: any) {
    console.error('[Z-Bot Main] 保存宠物状态失败:', e.message);
  }
}

function loadPetStatsFromFile(): PetStats {
  ensureDataDir();
  try {
    if (!fs.existsSync(petStatsFile)) return DEFAULT_PET_STATS;
    const raw = fs.readFileSync(petStatsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PET_STATS, ...parsed };
  } catch (e: any) {
    console.error('[Z-Bot Main] 读取宠物状态失败:', e.message);
    return DEFAULT_PET_STATS;
  }
}

/** 将值限制在 0-100 范围内 */
function clampStat(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** 根据时间差计算衰减并更新宠物状态 */
function decayPetStats(stats: PetStats): PetStats {
  const now = new Date();
  const lastUpdate = new Date(stats.lastUpdate);
  const diffMs = now.getTime() - lastUpdate.getTime();
  const diffMinutes = Math.max(0, diffMs / 60000);

  if (diffMinutes < 1) return stats; // 不足1分钟不衰减

  let { hunger, happiness, energy, cleanliness, health, affection, isSleeping, isSick, stage, bornAt } = stats;

  // 基础衰减
  hunger = clampStat(hunger - Math.floor(diffMinutes / 30));
  happiness = clampStat(happiness - Math.floor(diffMinutes / 20));
  cleanliness = clampStat(cleanliness - Math.floor(diffMinutes / 60));

  if (isSleeping) {
    // 睡觉时能量恢复 +2/分钟
    energy = clampStat(energy + Math.floor(diffMinutes * 2));
  } else {
    energy = clampStat(energy - Math.floor(diffMinutes / 45));
  }

  // 如果hunger<20或cleanliness<20, health开始下降
  if (hunger < 20 || cleanliness < 20) {
    const decayRate = (hunger < 20 ? 1 : 0) + (cleanliness < 20 ? 1 : 0);
    health = clampStat(health - Math.floor(diffMinutes / 60) * decayRate);
  }

  // 如果health<10, isSick=true
  isSick = health < 10;

  // 计算年龄（天数）
  const bornDate = new Date(bornAt);
  const ageDays = Math.floor((now.getTime() - bornDate.getTime()) / (1000 * 60 * 60 * 24));
  const age = ageDays;

  // 生命周期进化: 如果所有属性>60且age满足条件
  const allAbove60 = hunger > 60 && happiness > 60 && energy > 60 && cleanliness > 60 && health > 60;
  if (allAbove60) {
    if (stage === 'egg' && age >= 1) stage = 'baby';
    else if (stage === 'baby' && age >= 3) stage = 'child';
    else if (stage === 'child' && age >= 7) stage = 'adult';
  }

  return {
    ...stats,
    hunger,
    happiness,
    energy,
    cleanliness,
    health,
    affection,
    age,
    stage,
    isSleeping,
    isSick,
    lastUpdate: now.toISOString(),
  };
}

// ---------- 截图隐身模式 ----------
function applyStealthMode(win: BrowserWindow | null, enabled: boolean) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'darwin') {
    // macOS: 隐藏窗口在Mission Control、截图、录屏、屏幕共享中
    try {
      win.setHiddenInMissionControl(enabled);
      win.setContentProtection(enabled);
      console.log('[Z-Bot Main] 截图隐身模式:', enabled ? '开启' : '关闭');
    } catch (e: any) {
      console.warn('[Z-Bot Main] 设置隐身模式失败:', e.message);
    }
  }
}

function applyStealthToAllWindows(enabled: boolean) {
  applyStealthMode(petWindow, enabled);
  applyStealthMode(adminWindow, enabled);
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
    // 应用隐身模式
    if (stealthMode) applyStealthMode(adminWindow, true);
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

  petWindow.once('ready-to-show', () => {
    petWindow?.show();
    // 应用隐身模式
    if (stealthMode) applyStealthMode(petWindow, true);
  });

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

  const buildContextMenu = () => Menu.buildFromTemplate([
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
      label: '🕵️ 截图隐身',
      type: 'checkbox',
      checked: stealthMode,
      click: (menuItem) => {
        stealthMode = menuItem.checked;
        applyStealthToAllWindows(stealthMode);
        // 保存到配置
        const config = loadConfigFromFile();
        config.stealthMode = stealthMode;
        saveConfigToFile(config);
        console.log('[Z-Bot Main] 截图隐身模式:', stealthMode ? '开启' : '关闭');
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
  tray.setContextMenu(buildContextMenu());

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
  const [w, h] = petWindow.getSize();
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  // 边界检测
  const clampedX = Math.max(0, Math.min(width - w, Math.round(x)));
  const clampedY = Math.max(0, Math.min(height - h, Math.round(y)));
  petWindow.setPosition(clampedX, clampedY);
});

// ---------- IPC: 贴墙滑下效果 ----------
ipcMain.handle('window:stickToEdge', async () => {
  if (!petWindow) return;
  const [x, y] = petWindow.getPosition();
  const [w, h] = petWindow.getSize();
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const { width, height } = display.workAreaSize;

  // 检测是否在边缘
  const atLeft = x <= 5;
  const atRight = x >= width - w - 5;
  const atTop = y <= 5;
  const atBottom = y >= height - h - 5;

  if (atLeft || atRight || atTop || atBottom) {
    // 贴墙滑到底部
    const targetX = atLeft ? 0 : atRight ? width - w : x;
    const targetY = height - h; // 滑到底部
    // 动画式移动（分步）
    const steps = 10;
    const stepX = (targetX - x) / steps;
    const stepY = (targetY - y) / steps;
    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep++;
      if (currentStep >= steps) {
        petWindow?.setPosition(Math.round(targetX), Math.round(targetY));
        clearInterval(interval);
      } else {
        petWindow?.setPosition(
          Math.round(x + stepX * currentStep),
          Math.round(y + stepY * currentStep)
        );
      }
    }, 30);
  }
});

// ---------- IPC: 获取鼠标位置 ----------
ipcMain.handle('pet:getCursorPosition', async () => {
  const point = screen.getCursorScreenPoint();
  return { x: point.x, y: point.y };
});

// ---------- IPC: 触发动画 ----------
ipcMain.handle('pet:triggerAnimation', async (_, animType: string) => {
  petWindow?.webContents.send('pet:triggerAnimation', animType);
  return true;
});

// ---------- IPC: 设置宠物位置（带边界检测） ----------
ipcMain.handle('pet:setPosition', async (_, x: number, y: number) => {
  if (!petWindow) return;
  const [w, h] = petWindow.getSize();
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const clampedX = Math.max(0, Math.min(width - w, Math.round(x)));
  const clampedY = Math.max(0, Math.min(height - h, Math.round(y)));
  petWindow.setPosition(clampedX, clampedY);
  return { x: clampedX, y: clampedY };
});

// ---------- IPC: 皮肤系统 ----------
ipcMain.handle('pet:getSkins', async () => {
  // 返回预设皮肤列表
  const skins = [
    { id: 'default-purple', name: '默认紫', colors: { body: '#722ed1', bodyLight: '#b794f6', bodyDark: '#531dab', eye: '#1a1a2e', blush: 'rgba(255, 105, 180, 0.5)', accent: '#722ed1' }, isCustom: false },
    { id: 'forest-green', name: '森林绿', colors: { body: '#237804', bodyLight: '#52c41a', bodyDark: '#135200', eye: '#1a1a2e', blush: 'rgba(250, 173, 20, 0.4)', accent: '#52c41a' }, isCustom: false },
    { id: 'ocean-blue', name: '海洋蓝', colors: { body: '#003a8c', bodyLight: '#1890ff', bodyDark: '#002766', eye: '#1a1a2e', blush: 'rgba(255, 105, 180, 0.4)', accent: '#1890ff' }, isCustom: false },
    { id: 'sakura-pink', name: '樱花粉', colors: { body: '#9e1068', bodyLight: '#eb2f96', bodyDark: '#6e0f4e', eye: '#1a1a2e', blush: 'rgba(255, 182, 193, 0.6)', accent: '#eb2f96' }, isCustom: false },
    { id: 'lava-red', name: '岩浆红', colors: { body: '#820014', bodyLight: '#ff4d4f', bodyDark: '#5c0011', eye: '#1a1a2e', blush: 'rgba(255, 182, 193, 0.5)', accent: '#ff4d4f' }, isCustom: false },
    { id: 'galaxy-gray', name: '银河灰', colors: { body: '#434343', bodyLight: '#bfbfbf', bodyDark: '#1f1f1f', eye: '#1a1a2e', blush: 'rgba(114, 46, 209, 0.4)', accent: '#bfbfbf' }, isCustom: false },
    { id: 'golden', name: '金色', colors: { body: '#ad6800', bodyLight: '#faad14', bodyDark: '#874d00', eye: '#1a1a2e', blush: 'rgba(255, 105, 180, 0.4)', accent: '#faad14' }, isCustom: false },
  ];
  return skins;
});

ipcMain.handle('pet:applySkin', async (_, skinId: string) => {
  // 通知渲染进程应用皮肤
  petWindow?.webContents.send('pet:applySkin', skinId);
  // 保存到配置
  const config = loadConfigFromFile();
  config.currentSkinId = skinId;
  saveConfigToFile(config);
  return true;
});

ipcMain.handle('pet:applySkinTheme', async (_, skinData: { name: string; colors: { body: string; bodyLight: string; bodyDark: string; accent?: string } }) => {
  // AI生成的自定义皮肤
  const customSkin = {
    id: `custom-${Date.now()}`,
    name: skinData.name || 'AI生成皮肤',
    colors: {
      body: skinData.colors.body,
      bodyLight: skinData.colors.bodyLight,
      bodyDark: skinData.colors.bodyDark,
      eye: '#1a1a2e',
      blush: 'rgba(255, 105, 180, 0.5)',
      accent: skinData.colors.accent || skinData.colors.body,
    },
    isCustom: true,
  };
  petWindow?.webContents.send('pet:applySkinData', customSkin);
  return customSkin;
});

// ---------- IPC: 截图隐身模式 ----------
ipcMain.handle('pet:toggleStealth', async (_, enabled?: boolean) => {
  stealthMode = enabled !== undefined ? enabled : !stealthMode;
  applyStealthToAllWindows(stealthMode);
  // 保存到配置
  const config = loadConfigFromFile();
  config.stealthMode = stealthMode;
  saveConfigToFile(config);
  // 更新托盘菜单
  if (tray) {
    const buildContextMenu = () => Menu.buildFromTemplate([
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
        label: '🕵️ 截图隐身',
        type: 'checkbox',
        checked: stealthMode,
        click: (menuItem) => {
          stealthMode = menuItem.checked;
          applyStealthToAllWindows(stealthMode);
          const config = loadConfigFromFile();
          config.stealthMode = stealthMode;
          saveConfigToFile(config);
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
    tray.setContextMenu(buildContextMenu());
  }
  return stealthMode;
});

ipcMain.handle('pet:getStealthMode', async () => {
  return stealthMode;
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

    // 转为JPEG base64（压缩到500KB以内）
    const jpegBuffer = mainSource.thumbnail.toJPEG(80);
    const imageBase64 = jpegBuffer.toString('base64');

    // 同时保存文件
    const tempDir = app.getPath('temp');
    const screenshotPath = path.join(tempDir, `zbot_screenshot_${Date.now()}.jpg`);
    fs.writeFileSync(screenshotPath, jpegBuffer);
    console.log('[Z-Bot Main] 截图保存成功:', screenshotPath);

    return { success: true, path: screenshotPath, imageBase64 };
  } catch (error: any) {
    console.error('[Z-Bot Main] 截图失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ---------- IPC: 截取指定窗口 ----------
ipcMain.handle('screenshot:captureWindow', async (_, windowName?: string) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const source = windowName
      ? sources.find(s => s.name.includes(windowName))
      : sources[0];
    if (!source?.thumbnail) {
      return { success: false, error: '未找到目标窗口' };
    }
    const jpegBuffer = source.thumbnail.toJPEG(80);
    const imageBase64 = jpegBuffer.toString('base64');
    return { success: true, imageBase64, windowName: source.name };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ---------- IPC: 截图+AI分析 ----------
ipcMain.handle('screenshot:captureAndAnalyze', async (_, question?: string) => {
  try {
    const captureResult = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const mainSource = captureResult[0];
    if (!mainSource?.thumbnail) {
      return { success: false, error: '无法获取屏幕截图' };
    }
    const jpegBuffer = mainSource.thumbnail.toJPEG(80);
    const imageBase64 = jpegBuffer.toString('base64');

    // 获取当前AI配置
    const config = loadConfigFromFile();
    const provider = getProviderFromConfig(config as any);

    if (!provider.supportsVision) {
      return { success: false, error: '当前AI引擎不支持视觉分析，请切换到支持Vision的模型' };
    }

    const request: ChatRequest = {
      messages: [
        { role: 'system', content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt },
        {
          role: 'user',
          content: question || '请描述一下你看到的屏幕内容，简要说明当前正在做什么。',
          images: [imageBase64],
        },
      ],
      model: config.aiModel || config.modelName,
      stream: false,
    };

    const response = await chat(provider, request);
    return { success: true, analysis: response.content, imageBase64 };
  } catch (error: any) {
    console.error('[Z-Bot Main] 截图分析失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ---------- IPC: AI引擎 ----------
ipcMain.handle('ai:chat', async (_, request: ChatRequest) => {
  try {
    const config = loadConfigFromFile();
    const provider = getProviderFromConfig(config as any);
    const req: ChatRequest = {
      ...request,
      model: request.model || config.aiModel || config.modelName,
    };
    // 注入工具定义
    if (provider.supportsTools) {
      req.tools = getToolDefinitions();
    }
    const response = await chat(provider, req);

    // 处理工具调用
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolResults: ToolResult[] = [];
      for (const tc of response.toolCalls) {
        const toolCall: ToolCall = {
          id: tc.id || `call_${Date.now()}`,
          name: tc.function?.name || tc.name || '',
          arguments: typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {},
        };

        // 检查是否需要用户确认
        if (toolRequiresConfirmation(toolCall.name)) {
          // 发送到渲染进程请求确认
          const confirmed = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 60000);
            const handler = (_: any, result: { toolCallId: string; confirmed: boolean }) => {
              if (result.toolCallId === toolCall.id) {
                clearTimeout(timeout);
                ipcMain.removeListener('tools:confirmResult', handler);
                resolve(result.confirmed);
              }
            };
            ipcMain.on('tools:confirmResult', handler);
            // 通知渲染进程显示确认对话框
            adminWindow?.webContents.send('tools:confirmRequest', {
              toolCallId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            });
            petWindow?.webContents.send('tools:confirmRequest', {
              toolCallId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            });
          });
          if (!confirmed) {
            toolResults.push({
              toolCallId: toolCall.id,
              result: '用户拒绝了此操作',
              isError: true,
            });
            continue;
          }
        }

        // 执行工具
        const result = await executeTool(toolCall.name, toolCall.arguments);
        result.toolCallId = toolCall.id;
        toolResults.push(result);

        // 特殊处理: control_pet 触发动画
        if (toolCall.name === 'control_pet') {
          const action = toolCall.arguments.action;
          petWindow?.webContents.send('pet:triggerAnimation', action);
          adminWindow?.webContents.send('pet:triggerAnimation', action);
          if (toolCall.arguments.color) {
            petWindow?.webContents.send('pet:applySkinData', {
              id: 'ai-theme',
              name: 'AI主题',
              colors: {
                body: toolCall.arguments.color,
                bodyLight: toolCall.arguments.color,
                bodyDark: toolCall.arguments.color,
                eye: '#fff',
                blush: 'rgba(255,105,180,0.5)',
                accent: toolCall.arguments.color,
              },
              isCustom: true,
            });
          }
        }
      }

      // 将工具结果发回AI继续对话
      const toolMessages = toolResults.map(tr => ({
        role: 'tool' as const,
        content: tr.result,
        toolCallId: tr.toolCallId,
      }));
      const followUpRequest: ChatRequest = {
        messages: [
          ...request.messages,
          { role: 'assistant' as const, content: response.content || '', toolCalls: response.toolCalls },
          ...toolMessages.map(tm => ({ role: 'tool' as const, content: tm.content })),
        ],
        model: req.model,
        stream: false,
      };
      const followUpResponse = await chat(provider, followUpRequest);
      return { ...followUpResponse, toolResults };
    }

    return response;
  } catch (error: any) {
    console.error('[Z-Bot Main] AI聊天错误:', error.message);
    return { content: `抱歉，AI请求失败: ${error.message}`, toolCalls: undefined };
  }
});

ipcMain.handle('ai:testConnection', async (_, providerConfig?: AIProvider) => {
  try {
    if (providerConfig) {
      return await testConnection(providerConfig);
    }
    const config = loadConfigFromFile();
    const provider = getProviderFromConfig(config as any);
    return await testConnection(provider);
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai:getModels', async (_, providerConfig?: AIProvider) => {
  try {
    if (providerConfig) {
      return await getModels(providerConfig);
    }
    const config = loadConfigFromFile();
    const provider = getProviderFromConfig(config as any);
    return await getModels(provider);
  } catch {
    return [];
  }
});

ipcMain.handle('ai:streamChat', async (_, request: ChatRequest) => {
  try {
    const config = loadConfigFromFile();
    const provider = getProviderFromConfig(config as any);
    const req: ChatRequest = {
      ...request,
      model: request.model || config.aiModel || config.modelName,
    };
    const sender = (event: string, data: any) => {
      adminWindow?.webContents.send(event, data);
      petWindow?.webContents.send(event, data);
    };
    return await streamChat(provider, req, sender);
  } catch (error: any) {
    return { content: `流式请求失败: ${error.message}` };
  }
});

ipcMain.handle('ai:getBuiltinProviders', async () => {
  return BUILTIN_PROVIDERS;
});

// ---------- IPC: MCP工具 ----------
ipcMain.handle('tools:list', async () => {
  return getToolList();
});

ipcMain.handle('tools:execute', async (_, name: string, params: any) => {
  return await executeTool(name, params);
});

ipcMain.handle('tools:confirm', async (_, toolCallId: string, confirmed: boolean) => {
  ipcMain.emit('tools:confirmResult', {}, { toolCallId, confirmed });
  return true;
});

// ---------- IPC: 语音打断 ----------
ipcMain.handle('voice:interrupt', async () => {
  adminWindow?.webContents.send('voice:interrupt');
  petWindow?.webContents.send('voice:interrupt');
  return true;
});

// ---------- IPC: 按住说话快捷键 ----------
let pushToTalkActive = false;
ipcMain.handle('voice:pushToTalkStatus', async () => {
  return pushToTalkActive;
});

// 注册按住说话快捷键 (右Option/右Alt)
function registerPushToTalk() {
  const ret = globalShortcut.register('Alt+Shift+V', () => {
    pushToTalkActive = true;
    adminWindow?.webContents.send('voice:pushToTalkStart');
    petWindow?.webContents.send('voice:pushToTalkStart');
  });
  // 松开检测通过另一个快捷键或定时器
  // 简化实现: 用Cmd+Shift+V停止
  const ret2 = globalShortcut.register('Alt+Shift+C', () => {
    pushToTalkActive = false;
    adminWindow?.webContents.send('voice:pushToTalkStop');
    petWindow?.webContents.send('voice:pushToTalkStop');
  });
  if (ret && ret2) {
    console.log('[Z-Bot Main] 按住说话快捷键已注册: Alt+Shift+V 开始, Alt+Shift+C 停止');
  }
}

// ---------- IPC: 文件读取 ----------
ipcMain.handle('file:read', async (_, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content: content.slice(0, 50000) }; // 限制50KB
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('file:readAsBase64', async (_, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' };
    }
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
    const base64 = content.toString('base64');
    return { success: true, base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ---------- IPC: Pin卡片 ----------
interface PinCard {
  id: string;
  content: string;
  createdAt: string;
  conversationId?: string;
}

const pinCardsFile = path.join(dataDir, 'pins.json');

function loadPinCards(): PinCard[] {
  try {
    if (!fs.existsSync(pinCardsFile)) return [];
    return JSON.parse(fs.readFileSync(pinCardsFile, 'utf-8'));
  } catch { return []; }
}

function savePinCards(pins: PinCard[]) {
  ensureDataDir();
  fs.writeFileSync(pinCardsFile, JSON.stringify(pins, null, 2), 'utf-8');
}

ipcMain.handle('pin:create', async (_, content: string) => {
  const pins = loadPinCards();
  const pin: PinCard = { id: Date.now().toString(), content, createdAt: new Date().toISOString() };
  pins.push(pin);
  savePinCards(pins);
  return pin;
});

ipcMain.handle('pin:remove', async (_, id: string) => {
  let pins = loadPinCards();
  pins = pins.filter(p => p.id !== id);
  savePinCards(pins);
  return true;
});

ipcMain.handle('pin:list', async () => {
  return loadPinCards();
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

// ---------- IPC: 宠物养成系统 ----------
// 内存中的宠物状态
let petStats: PetStats = DEFAULT_PET_STATS;

ipcMain.handle('pet:getStats', async () => {
  petStats = decayPetStats(petStats);
  savePetStatsToFile(petStats);
  return petStats;
});

ipcMain.handle('pet:feed', async () => {
  petStats = decayPetStats(petStats);
  petStats.hunger = clampStat(petStats.hunger + 30);
  petStats.lastUpdate = new Date().toISOString();
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 喂食, hunger:', petStats.hunger);
  return petStats;
});

ipcMain.handle('pet:play', async () => {
  petStats = decayPetStats(petStats);
  petStats.happiness = clampStat(petStats.happiness + 20);
  petStats.energy = clampStat(petStats.energy - 10);
  petStats.lastUpdate = new Date().toISOString();
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 玩耍, happiness:', petStats.happiness, 'energy:', petStats.energy);
  return petStats;
});

ipcMain.handle('pet:wash', async () => {
  petStats = decayPetStats(petStats);
  petStats.cleanliness = clampStat(petStats.cleanliness + 40);
  petStats.lastUpdate = new Date().toISOString();
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 洗澡, cleanliness:', petStats.cleanliness);
  return petStats;
});

ipcMain.handle('pet:sleep', async () => {
  petStats = decayPetStats(petStats);
  petStats.isSleeping = !petStats.isSleeping;
  petStats.lastUpdate = new Date().toISOString();
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 切换睡觉状态, isSleeping:', petStats.isSleeping);
  return petStats;
});

ipcMain.handle('pet:medicine', async () => {
  petStats = decayPetStats(petStats);
  petStats.health = clampStat(petStats.health + 30);
  if (petStats.health >= 10) petStats.isSick = false;
  petStats.lastUpdate = new Date().toISOString();
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 治疗, health:', petStats.health);
  return petStats;
});

ipcMain.handle('pet:pet', async () => {
  petStats = decayPetStats(petStats);
  petStats.happiness = clampStat(petStats.happiness + 5);
  petStats.affection = clampStat(petStats.affection + 1);
  petStats.lastUpdate = new Date().toISOString();
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 抚摸, happiness:', petStats.happiness, 'affection:', petStats.affection);
  return petStats;
});

// ---------- 应用生命周期 ----------
app.whenReady().then(() => {
  ensureDataDir();
  // 启动时加载持久化历史到内存
  inMemoryHistory = loadHistoryFromFile();

  // 启动时加载宠物状态并计算离线衰减
  petStats = decayPetStats(loadPetStatsFromFile());
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 宠物状态已加载, stage:', petStats.stage, 'age:', petStats.age);

  // 加载隐身模式配置
  const savedConfig = loadConfigFromFile();
  if (savedConfig.stealthMode !== undefined) {
    stealthMode = savedConfig.stealthMode;
  }

  startSTTServer();
  startTTSServer();
  createAdminWindow();
  createPetWindow();
  createTray();
  registerShortcuts();
  registerPushToTalk();

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

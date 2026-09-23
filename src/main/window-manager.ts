import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { dataDir, ensureDataDir } from './config-store';

/**
 * 窗口生命周期、隐身模式、位置持久化与光标推送。
 * 从 index.ts 拆出（doc/优化方案 T3.1），同时承载 T4.1/T4.2/T4.4/T4.5 与
 * T3.2/T3.3 的窗口侧实现：index 只负责装配，不再持有 BrowserWindow 引用。
 */

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;
// 仅显式调试开关才允许关沙箱（T1.1）
const UNSANDBOXED = process.argv.includes('--zbot-unsandboxed');

let adminWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let stealthMode = true;

export interface WindowManagerDeps {
  initialStealth?: boolean;
  onStealthChange?: (enabled: boolean) => void;
}

let deps: WindowManagerDeps = {};

export function initWindowManager(d: WindowManagerDeps = {}): void {
  deps = d;
  if (typeof d.initialStealth === 'boolean') stealthMode = d.initialStealth;
}

export function getAdminWindow(): BrowserWindow | null {
  return adminWindow && !adminWindow.isDestroyed() ? adminWindow : null;
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null;
}

export function isStealthMode(): boolean {
  return stealthMode;
}

/** 同一事件投递给两个窗口（原先在 index.ts 里成对重复了二十多处） */
export function sendToWindows(channel: string, payload?: unknown): void {
  getAdminWindow()?.webContents.send(channel, payload);
  getPetWindow()?.webContents.send(channel, payload);
}

export function showAdminWindow(): void {
  createAdminWindow();
  adminWindow?.show();
  adminWindow?.focus();
}

export function showPetWindow(): void {
  createPetWindow();
  petWindow?.show();
}

export async function setStealthMode(enabled: boolean): Promise<boolean> {
  stealthMode = enabled;
  applyStealthToAllWindows(stealthMode);
  deps.onStealthChange?.(enabled);
  return stealthMode;
}

export function stopWindowTimers(): void {
  stopCursorPush();
}

// ---------- 截图隐身模式 ----------
// setContentProtection 在 macOS/Windows 均受支持（T4.5 修复 D18 的 darwin-only）
function applyStealthMode(win: BrowserWindow | null, enabled: boolean) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(enabled);
    if (process.platform === 'darwin') {
      win.setHiddenInMissionControl(enabled);
    }
    console.log('[Z-Bot Main] 截图隐身模式:', enabled ? '开启' : '关闭');
  } catch (e: any) {
    console.warn('[Z-Bot Main] 设置隐身模式失败:', e.message);
  }
}

function applyStealthToAllWindows(enabled: boolean) {
  applyStealthMode(petWindow, enabled);
  applyStealthMode(adminWindow, enabled);
}

// ---------- 窗口安全边界（04 §1.2） ----------
const DEV_SERVER_URL = 'http://127.0.0.1:5173';

function attachWindowSecurity(win: BrowserWindow) {
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev
      ? url.startsWith(DEV_SERVER_URL)
      : url.startsWith('file://');
    if (!allowed) {
      console.warn('[Z-Bot Main] 拦截越界导航:', url);
      e.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行 http(s) 外链，避免 file:// 或自定义协议被诱导打开
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function baseWebPreferences() {
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: !UNSANDBOXED,
    webviewTag: false,
    spellcheck: false,
  } as const;
}

// ---------- 宠物窗口位置持久化（T4.2） ----------
interface WindowBounds {
  x: number;
  y: number;
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const file = path.join(dataDir, 'window_bounds.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed;
  } catch {
    // 位置文件损坏时回落默认位置
  }
  return null;
}

function saveWindowBounds(bounds: WindowBounds) {
  try {
    ensureDataDir();
    fs.writeFileSync(path.join(dataDir, 'window_bounds.json'), JSON.stringify(bounds), 'utf-8');
  } catch (e: any) {
    console.warn('[Z-Bot Main] 保存窗口位置失败:', e.message);
  }
}

/** 判断保存的位置是否仍落在某个显示器范围内（拔掉外接屏后不越界恢复） */
function boundsOnSomeDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x >= a.x - 200 && x <= a.x + a.width && y >= a.y - 100 && y <= a.y + a.height;
  });
}

// ---------- 窗口创建 ----------
export function createAdminWindow() {
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
    webPreferences: baseWebPreferences(),
  });

  attachWindowSecurity(adminWindow);

  if (isDev) {
    console.log('[Z-Bot Main] 加载管理端 URL...');
    adminWindow.loadURL(`${DEV_SERVER_URL}/admin/index.html`);
    adminWindow.webContents.once('did-finish-load', () => {
      console.log('[Z-Bot Main] 管理端页面加载完成');
      adminWindow?.webContents.openDevTools();
    });
  } else {
    adminWindow.loadFile(path.join(__dirname, '../renderer/admin/index.html'));
  }

  adminWindow.once('ready-to-show', () => {
    adminWindow?.show();
    if (stealthMode) applyStealthMode(adminWindow, true);
  });

  adminWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      adminWindow?.hide();
    }
  });
}

export function createPetWindow() {
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
    webPreferences: baseWebPreferences(),
  });

  attachWindowSecurity(petWindow);

  // 跨工作区/全屏空间可见（T4.1）
  try {
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e: any) {
    console.warn('[Z-Bot Main] 设置全工作区可见失败:', e.message);
  }

  const saved = loadWindowBounds();
  if (saved && boundsOnSomeDisplay(saved.x, saved.y)) {
    petWindow.setPosition(saved.x, saved.y);
  }

  // 穿透开关跨窗口重建保持
  if (clickThrough) petWindow.setIgnoreMouseEvents(true, { forward: true });

  // 移动结束后再落盘，避免拖拽期间高频写盘
  let boundsSaveTimer: NodeJS.Timeout | null = null;
  const persistLater = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!petWindow || petWindow.isDestroyed()) return;
      const [x, y] = petWindow.getPosition();
      saveWindowBounds({ x, y });
    }, 400);
  };
  petWindow.on('moved', persistLater);
  petWindow.on('resized', persistLater);

  if (isDev) {
    console.log('[Z-Bot Main] 加载萌宠 URL...');
    petWindow.loadURL(`${DEV_SERVER_URL}/pet/index.html`);
    petWindow.webContents.once('did-finish-load', () => {
      console.log('[Z-Bot Main] 萌宠页面加载完成');
    });
  } else {
    petWindow.loadFile(path.join(__dirname, '../renderer/pet/index.html'));
  }

  petWindow.once('ready-to-show', () => {
    petWindow?.show();
    if (stealthMode) applyStealthMode(petWindow, true);
  });

  petWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      petWindow?.hide();
    }
  });
}
// ---------- IPC: 窗口控制 ----------
ipcMain.handle('window:toggle', async (_, mode: 'admin' | 'pet') => {
  if (mode === 'admin') {
    if (!adminWindow) createAdminWindow();
    adminWindow?.show();
    adminWindow?.focus();
    petWindow?.hide();
  } else {
    if (!petWindow) createPetWindow();
    petWindow?.show();
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
  }
});

ipcMain.handle('window:hide', async (_, mode: 'admin' | 'pet') => {
  if (mode === 'admin') {
    adminWindow?.hide();
  } else {
    petWindow?.hide();
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
  petWindow.setPosition(...clampToDisplay(x, y, w, h));
});

/** 以窗口当前所在显示器为准做边界约束（T4.4，修复多屏越界） */
function clampToDisplay(x: number, y: number, w: number, h: number): [number, number] {
  const anchor = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : { x, y, width: w, height: h };
  const display = screen.getDisplayMatching({
    x: anchor.x,
    y: anchor.y,
    width: anchor.width || w,
    height: anchor.height || h,
  });
  const { x: ax, y: ay, width, height } = display.workArea;
  const clampedX = Math.max(ax, Math.min(ax + width - w, Math.round(x)));
  const clampedY = Math.max(ay, Math.min(ay + height - h, Math.round(y)));
  return [clampedX, clampedY];
}

// ---------- 点击穿透（02 §2.1）----------
// 开启后鼠标事件穿过宠物窗口，不遮挡底层操作；forward 保留 hover 以便动画继续。
// 只能由托盘菜单关闭（穿透时窗口收不到点击，渲染进程无法自救）。
let clickThrough = false;

export function isPetClickThrough(): boolean {
  return clickThrough;
}

export function setPetClickThrough(enabled: boolean): void {
  clickThrough = enabled;
  if (!petWindow || petWindow.isDestroyed()) return;
  if (enabled) {
    petWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    petWindow.setIgnoreMouseEvents(false);
  }
}

// ---------- IPC: 贴墙滑下效果 ----------
ipcMain.handle('window:stickToEdge', async () => {
  if (!petWindow) return;
  const [x, y] = petWindow.getPosition();
  const [w, h] = petWindow.getSize();
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const { x: ax, y: ay, width, height } = display.workArea;

  // 检测是否在边缘
  const atLeft = x - ax <= 5;
  const atRight = x >= ax + width - w - 5;
  const atTop = y - ay <= 5;
  const atBottom = y >= ay + height - h - 5;

  if (atLeft || atRight || atTop || atBottom) {
    const targetX = atLeft ? ax : atRight ? ax + width - w : x;
    const targetY = ay + height - h; // 滑到底部
    // 由操作系统完成动画，主进程不再跑 30ms 定时器（T3.3，修复 D16）
    petWindow.setBounds(
      { x: Math.round(targetX), y: Math.round(targetY), width: w, height: h },
      true
    );
  }
});

// ---------- IPC: 鼠标位置推送 ----------
// 渲染进程 100ms 轮询改为 main 侧 200ms 推送，且仅萌宠可见时运行（T3.2，修复 D17）
let cursorTimer: NodeJS.Timeout | null = null;
let lastCursor = { x: -1, y: -1 };

function startCursorPush() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    if (p.x === lastCursor.x && p.y === lastCursor.y) return; // 鼠标静止不推
    lastCursor = p;
    const bounds = petWindow.getBounds();
    // 直接给相对窗口中心的偏移量，渲染端无需再做坐标换算
    petWindow.webContents.send('pet:cursorDelta', {
      dx: p.x - (bounds.x + bounds.width / 2),
      dy: p.y - (bounds.y + bounds.height / 2),
    });
  }, 200);
  cursorTimer.unref?.();
}

function stopCursorPush() {
  if (!cursorTimer) return;
  clearInterval(cursorTimer);
  cursorTimer = null;
}

// ---------- IPC: 触发动画 ----------
ipcMain.handle('pet:triggerAnimation', async (_, animType: string) => {
  petWindow?.webContents.send('pet:triggerAnimation', animType);
  return true;
});

// ---------- IPC: 设置宠物位置（带边界检测） ----------
ipcMain.handle('pet:setPosition', async (_, x: number, y: number) => {
  if (!petWindow) return;
  const [w, h] = petWindow.getSize();
  const [cx, cy] = clampToDisplay(x, y, w, h);
  petWindow.setPosition(cx, cy);
  return { x: cx, y: cy };
});
// ---------- IPC: 截图隐身模式 ----------
ipcMain.handle('pet:toggleStealth', async (_, enabled?: boolean) => {
  await setStealthMode(enabled !== undefined ? enabled : !stealthMode);
  return stealthMode;
});

ipcMain.handle('pet:getStealthMode', async () => {
  return stealthMode;
});

export function wirePetCursorTracking(): void {
  const w = getPetWindow();
  if (!w) return;
  w.on('show', startCursorPush);
  w.on('hide', stopCursorPush);
  if (w.isVisible()) startCursorPush();
}


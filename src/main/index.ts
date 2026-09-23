import {
  app,
  BrowserWindow,
  Tray,
  nativeImage,
  globalShortcut,
  shell,
} from 'electron';
import * as path from 'path';
import { initShortcuts, registerShortcuts } from './shortcut-manager';
import { initMemory } from './memory-system';
import { initQuickCommands } from './quick-commands';
import { autoSwitchSceneryByTime } from './scenery-system';
import { initTasks, startTaskScheduler, stopTaskScheduler, setTaskDispatcher } from './task-system';
import {
  dataDir,
  ensureDataDir,
  migratePlaintextApiKey,
} from './config-store';
import { buildTrayMenu, TrayContext } from './tray-manager';
import { VoiceService, setVoiceService, getVoiceService, STT_PORT, TTS_PORT } from './voice-service';
import { initUpdater, checkForUpdates } from './updater';
import {
  cleanupStaleScreenshots,
  installPermissionGuard,
  refreshAllowedRoots,
  startMemoryExtractTimer,
  installCSP,
  whisperModelPath,
  initRuntimeState,
} from './ipc-handlers';
import { initAiRouter, requestTaskCommand } from './ai-router';
import {
  configStore,
  loadConfigFromFile,
  petStatsStore,
  pinStore,
  historyStore,
} from './stores';
import {
  createAdminWindow,
  createPetWindow,
  getAdminWindow,
  getPetWindow,
  initWindowManager,
  isPetClickThrough,
  isStealthMode,
  sendToWindows,
  setPetClickThrough,
  setStealthMode,
  showAdminWindow,
  stopWindowTimers,
  wirePetCursorTracking,
} from './window-manager';

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

// 渲染进程沙箱保持开启（doc/优化方案/04 §1.2，修复 D01）：
// 仅当显式传入 --zbot-unsandboxed 这类调试开关时才允许关闭，默认不再传 --no-sandbox。
const UNSANDBOXED = process.argv.includes('--zbot-unsandboxed');
// GPU 默认启用；软件渲染兜底改为按需 opt-in（T3.10 / H07）
const FORCE_SOFTWARE_GL = process.argv.includes('--zbot-software-gl');
if (UNSANDBOXED) console.warn('[Z-Bot Main] 警告：沙箱已通过调试开关关闭，仅用于本地排查');
if (FORCE_SOFTWARE_GL) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}


console.log('[Z-Bot Main] 应用启动...');
console.log('[Z-Bot Main] 是否开发模式:', isDev);

let tray: Tray | null = null;



// ---------- STT/TTS 服务器 ----------

/**
 * 打包后 server/ 通过 extraResources 落在 resources 下（asar 内的 .js 无法被 spawn node 执行），
 * 开发态仍在仓库根目录。
 */
function resolveServerDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '../../server');
}

function startVoiceServices(): void {
  const svc = new VoiceService({
    sttPort: STT_PORT,
    ttsPort: TTS_PORT,
    serverDir: resolveServerDir(),
    whisperModel:
      process.env.ZBOT_WHISPER_MODEL || whisperModelPath(loadConfigFromFile().sttModel || 'base'),
  });
  setVoiceService(svc);
  svc.start();
}

function stopServers(): void {
  getVoiceService()?.stop();
  setVoiceService(null);
}

// 单一菜单来源，消除 D15 的 70 行重复实现
function trayContext(): TrayContext {
  return {
    isPetVisible: () => !!getPetWindow() && getPetWindow()!.isVisible(),
    togglePet: () => {
      const pet = getPetWindow();
      if (!pet) createPetWindow();
      getPetWindow()?.show();
    },
    showPet: () => {
      if (!getPetWindow()) createPetWindow();
      getPetWindow()?.show();
    },
    showAdmin: showAdminWindow,
    openSettings: () => {
      createAdminWindow();
      getAdminWindow()?.show();
      getAdminWindow()?.focus();
      getAdminWindow()?.webContents.send('open:settings');
    },
    sendVoice: (event) => {
      sendToWindows(event);
    },
    getStealthMode: () => isStealthMode(),
    setStealthMode: (enabled) => {
      void setStealthMode(enabled);
    },
    getClickThrough: () => isPetClickThrough(),
    setClickThrough: (enabled) => {
      setPetClickThrough(enabled);
      refreshTrayMenu();
    },
    quit: () => {
      (app as any).isQuitting = true;
      app.quit();
    },
  };
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu(trayContext()));
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
  tray.setToolTip('Z-Bot 桌面助手');
  refreshTrayMenu();

  tray.on('double-click', () => trayContext().showAdmin());
}

// ---------- 全局快捷键 ----------
// 统一由 shortcut-manager.ts 注册（registerShortcutsNew），此处旧实现已移除

// ---------- 应用生命周期 ----------
app.whenReady().then(() => {
  ensureDataDir();
  refreshAllowedRoots();
  initAiRouter({ getConfig: () => loadConfigFromFile() });
  // 明文密钥一次性迁移到加密存储（T4.10 / 04 §6.2）
  migratePlaintextApiKey(configStore);
  installPermissionGuard();
  installCSP();
  cleanupStaleScreenshots();

  initRuntimeState();

  // 初始化各种系统
  initMemory(dataDir);
  initQuickCommands();
  initTasks();
  autoSwitchSceneryByTime();
  startMemoryExtractTimer();
  // 任务动作改由窗口 IPC 投递（T1.12，修复 D12 process.send 为 undefined）
  setTaskDispatcher({
    dispatch: (payload) => {
      getPetWindow()?.webContents.send('task:action', payload);
      getAdminWindow()?.webContents.send('task:action', payload);
    },
    requestCommandRun: requestTaskCommand,
  });
  startTaskScheduler();

  // 加载隐身模式配置
  const savedConfig = loadConfigFromFile();
  initWindowManager({
    initialStealth: savedConfig.stealthMode,
    onStealthChange: (enabled) => void configStore.patch({ stealthMode: enabled }),
  });

  startVoiceServices();
  // admin 窗口延迟到首次需要时创建（T3.11），启动只拉起常驻萌宠
  createPetWindow();
  createTray();
  initShortcuts({
    togglePet: () => {
      const pet = getPetWindow();
      if (!pet) {
        createPetWindow();
        return;
      }
      if (pet.isVisible()) pet.hide();
      else pet.show();
    },
    broadcast: (channel) => sendToWindows(channel),
  });
  {
    const { failed } = registerShortcuts(savedConfig.shortcuts || {});
    if (failed.length) console.warn('[Z-Bot Main] 以下快捷键注册失败（被占用或格式非法）:', failed.join(', '));
  }

  wirePetCursorTracking();

  initUpdater((channel, payload) => sendToWindows(channel, payload));
  if (app.isPackaged) {
    // 启动后静默检查一次，结果通过 update:status 推给窗口
    setTimeout(() => void checkForUpdates(), 5000);
  }

  // 随机处理外链
  app.on('browser-window-created', (_, window) => {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
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
  stopWindowTimers();
  stopServers();
  stopTaskScheduler();
  globalShortcut.unregisterAll();
  // 把缓存中未落盘的状态写回磁盘
  void configStore.flush();
  void historyStore.flush();
  void petStatsStore.flush();
  void pinStore.flush();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

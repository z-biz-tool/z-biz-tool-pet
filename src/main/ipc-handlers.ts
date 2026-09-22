import { app,desktopCapturer,ipcMain,session,systemPreferences } from 'electron';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { dataDir } from './config-store';
import { chat, getProviderFromConfig } from './ai-providers';
import type { ChatRequest } from './ai-providers';
import { startMeeting, endMeeting, getMeetingState, cancelMeeting } from './meeting-transcriber';
import { extractMemoryFromConversation } from './memory-system';
import { buildAllowedRoots, guardReadPath, MAX_READ_FILE_BYTES } from './security';
import {
  clampStat,
  decayPetStats,
  DEFAULT_CONFIG,
  DEFAULT_PET_STATS,
  loadConfigFromFile,
  loadHistoryFromFile,
  loadPetStatsFromFile,
  loadPinCards,
  MAX_HISTORY_LENGTH,
  saveConfigToFile,
  saveHistoryToFile,
  savePetStatsToFile,
  savePinCards,
  type ChatMessage,
  type PetConfig,
  type PetStats,
  type PinCard,
} from './stores';
import { getAdminWindow,getPetWindow,sendToWindows } from './window-manager';
import { getVoiceService,STT_PORT } from './voice-service';
import { checkForUpdates, getUpdateStatus, downloadAndInstall } from './updater';
import {
  getShortcuts,
  isValidAccelerator,
  reloadShortcuts,
  isPushToTalkActive,
  type ShortcutKey,
  type ShortcutOverrides,
} from './shortcut-manager';

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

/**
 * 主进程 IPC 处理器集合（doc/优化方案 T3.1）：皮肤/截图/语音/文件/Pin/会议/历史/养成状态。
 * index.ts 只保留启动开关、语音子进程装配、托盘、快捷键与生命周期。
 */

// ---------- IPC: 日志 ----------
ipcMain.on('log', (_, msg: string) => {
  console.log('[Renderer]', msg);
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
  getPetWindow()?.webContents.send('pet:applySkin', skinId);
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
  getPetWindow()?.webContents.send('pet:applySkinData', customSkin);
  return customSkin;
});


// ---------- IPC: 截图 ----------
// 截图频率限制 1 次 / 5 秒（04 §2.1）
let lastScreenshotAt = 0;
export function throttleScreenshot(): boolean {
  const now = Date.now();
  if (now - lastScreenshotAt < 5000) return false;
  lastScreenshotAt = now;
  return true;
}

/** 启动时清理超过 24h 的截图临时文件（T4.7，修复 D20 无清理） */
export function cleanupStaleScreenshots() {
  try {
    const dir = app.getPath('temp');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('zbot_screenshot_')) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch (e: any) {
    console.warn('[Z-Bot Main] 清理截图临时文件失败:', e.message);
  }
}

ipcMain.handle('screenshot:capture', async () => {
  console.log('[Z-Bot Main] 开始截图...');
  if (!throttleScreenshot()) {
    return { success: false, error: '截图过于频繁，请 5 秒后重试' };
  }
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


// ---------- IPC: 语音打断 ----------
ipcMain.handle('voice:interrupt', async () => {
  sendToWindows('voice:interrupt');
  return true;
});

// ---------- IPC: 语音服务代理（T2.5/T2.6，修复 D13 renderer 直连） ----------
// 渲染进程不再直连 8084/8086，token 只存在于主进程
function postJson(baseUrl: string, urlPath: string, body: any, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: new URL(baseUrl).port,
        path: urlPath,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-auth-token': getVoiceService()?.authToken ?? '',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`服务返回 ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data || '{}'));
          } catch {
            reject(new Error('语音服务响应不是合法 JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('语音服务超时'));
    });
    req.write(payload);
    req.end();
  });
}

ipcMain.handle('voice:transcribe', async (_, base64Audio: string) => {
  const svc = getVoiceService();
  if (!svc) return { success: false, error: '语音服务未启动' };
  try {
    const data = await postJson(svc.sttBaseUrl(), '/transcribe', { audio: base64Audio });
    return { success: true, text: data.text || '' };
  } catch (e: any) {
    console.error('[Z-Bot Main] STT 失败:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('voice:speak', async (_, text: string, voice?: string) => {
  const svc = getVoiceService();
  if (!svc) return { success: false, error: '语音服务未启动' };
  try {
    const data = await postJson(svc.ttsBaseUrl(), '/speak', { text, voice });
    return { success: true, audio: data.audio, format: data.format };
  } catch (e: any) {
    console.error('[Z-Bot Main] TTS 失败:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('voice:status', async () => {
  return { services: getVoiceService()?.status() ?? [] };
});

// ---------- 麦克风权限（T2.8，修复 D13 前置能力） ----------
export async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    if (status === 'restricted' || status === 'denied') return false;
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (e: any) {
    console.warn('[Z-Bot Main] 麦克风权限检查失败:', e.message);
    return false;
  }
}

ipcMain.handle('voice:checkMicrophone', async () => ensureMicrophoneAccess());

export function installPermissionGuard() {
  // 仅两个自有窗口可拿媒体权限，其余一律拒绝（04 §4.3）
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const own = [getAdminWindow(), getPetWindow()].some((w) => w && w.webContents.id === wc.id);
    const media = permission === 'media';
    callback(own && media);
  });
}

/**
 * CSP 由主进程按环境注入（04 §1.2），而不是写死在 index.html：
 * dev 下 @vitejs/plugin-react 会往 HTML 里插一段内联 refresh 前置脚本，
 * 静态 meta 的 script-src 'self' 会直接把它拦掉、页面白屏。
 */
export function installCSP() {
  const policy = [
    "default-src 'self'",
    `script-src 'self'${isDev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

// ---------- IPC: 快捷键事件 ----------
ipcMain.on('shortcut:screenshot', () => {
  sendToWindows('shortcut:screenshot');
});

ipcMain.on('shortcut:note', () => {
  sendToWindows('shortcut:note');
});

ipcMain.on('shortcut:translateWord', () => {
  sendToWindows('shortcut:translateWord');
});

ipcMain.on('shortcut:whisperStart', () => {
  sendToWindows('shortcut:whisperStart');
});

// ---------- IPC: 按住说话快捷键 ----------
ipcMain.handle('voice:pushToTalkStatus', async () => isPushToTalkActive());


// ---------- IPC: 自动更新（T5.6） ----------
ipcMain.handle('update:check', async () => checkForUpdates());
ipcMain.handle('update:status', async () => getUpdateStatus());
ipcMain.handle('update:install', async () => downloadAndInstall());

// ---------- IPC: 快捷键与 STT 模型（T4.9） ----------
const STT_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];
const MODELS_DIR = path.join(dataDir, 'models');

export function whisperModelPath(model: string): string {
  return path.join(MODELS_DIR, 'ggml-' + model + '.bin');
}

ipcMain.handle('shortcuts:list', async () => getShortcuts());

ipcMain.handle('shortcuts:update', async (_, overrides: ShortcutOverrides) => {
  const cleaned: ShortcutOverrides = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!isValidAccelerator(String(v || ''))) {
      rejected.push(String(k));
      continue;
    }
    cleaned[k as ShortcutKey] = String(v).trim();
  }
  const { failed } = reloadShortcuts(cleaned);
  return { ok: failed.length === 0 && rejected.length === 0, failed, rejected };
});

ipcMain.handle('stt:models', async () => {
  const current = loadConfigFromFile().sttModel || 'base';
  return {
    current,
    modelsDir: MODELS_DIR,
    models: STT_MODELS.map((m) => ({ id: m, path: whisperModelPath(m), installed: fs.existsSync(whisperModelPath(m)) })),
  };
});

// ---------- IPC: 文件读取（T1.7，修复 D05 任意路径读取） ----------
let allowedReadRoots: string[] = [];

export function refreshAllowedRoots() {
  allowedReadRoots = buildAllowedRoots([
    app.getPath('temp'),
    app.getPath('userData'),
    path.join(dataDir, 'meetings'),
  ]);
}

function rejectPath(filePath: string): { success: false; error: string } | null {
  const guard = guardReadPath(filePath, allowedReadRoots);
  if (!guard.allowed) {
    console.warn('[Z-Bot Main] 拒绝越权文件访问:', filePath, guard.reason);
    return { success: false, error: `无权访问该路径: ${guard.reason}` };
  }
  return null;
}

ipcMain.handle('file:read', async (_, filePath: string) => {
  const denied = rejectPath(filePath);
  if (denied) return denied;
  try {
    const resolved = guardReadPath(filePath, allowedReadRoots).resolved!;
    if (!fs.existsSync(resolved)) {
      return { success: false, error: '文件不存在' };
    }
    const size = fs.statSync(resolved).size;
    if (size > MAX_READ_FILE_BYTES) {
      return { success: false, error: `文件超过 ${MAX_READ_FILE_BYTES / 1024 / 1024}MB 限制` };
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    return { success: true, content: content.slice(0, 50000) }; // 限制50KB
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('file:readAsBase64', async (_, filePath: string) => {
  const denied = rejectPath(filePath);
  if (denied) return denied;
  try {
    const resolved = guardReadPath(filePath, allowedReadRoots).resolved!;
    if (!fs.existsSync(resolved)) {
      return { success: false, error: '文件不存在' };
    }
    const size = fs.statSync(resolved).size;
    if (size > MAX_READ_FILE_BYTES) {
      return { success: false, error: `文件超过 ${MAX_READ_FILE_BYTES / 1024 / 1024}MB 限制` };
    }
    const content = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
    const base64 = content.toString('base64');
    return { success: true, base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ---------- IPC: Pin卡片 ----------

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

// ---------- IPC: 会议转录 ----------
ipcMain.handle('meeting:start', async (_, title: string) => {
  try {
    const state = await startMeeting(
      title || '',
      getVoiceService()?.sttBaseUrl() ?? `http://127.0.0.1:${STT_PORT}`,
      getVoiceService()?.authToken ?? ''
    );
    return { success: true, state };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('meeting:end', async () => {
  try {
    const state = await endMeeting();
    return { success: true, state };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('meeting:cancel', async () => {
  cancelMeeting();
  return { success: true };
});

ipcMain.handle('meeting:getState', async () => {
  return getMeetingState();
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
// 记忆提取定时器 - 每5分钟检查一次
let memoryExtractTimer: NodeJS.Timeout | null = null;

// 开始记忆提取定时器
export function startMemoryExtractTimer() {
  if (memoryExtractTimer) {
    clearInterval(memoryExtractTimer);
  }
  memoryExtractTimer = setInterval(() => {
    if (inMemoryHistory.length > 0) {
      extractMemoryFromConversation(inMemoryHistory.slice(-20)); // 提取最近20条
    }
  }, 5 * 60 * 1000); // 5分钟
  console.log('[Z-Bot Main] 记忆提取定时器已启动');
}

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
  const before = loadConfigFromFile();
  saveConfigToFile(config);

  const applied: { sttModel?: boolean; shortcuts?: boolean } = {};
  // STT 模型换的要重启子进程才生效
  if (config.sttModel && config.sttModel !== before.sttModel) {
    const svc = getVoiceService();
    if (svc) {
      svc.setWhisperModel(whisperModelPath(config.sttModel));
      applied.sttModel = true;
      console.log('[Z-Bot Main] STT 模型切换为:', config.sttModel);
    }
  }
  // 加速键变更直接热重载（被占用时回报失败项）
  if (JSON.stringify(config.shortcuts || {}) !== JSON.stringify(before.shortcuts || {})) {
    const { failed } = reloadShortcuts((config.shortcuts || {}) as ShortcutOverrides);
    applied.shortcuts = failed.length === 0;
    if (failed.length) console.warn('[Z-Bot Main] 部分快捷键注册失败:', failed.join(', '));
  }
  return { ok: true, applied };
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

/** 启动时把磁盘上的历史与宠物状态装进内存（index 在 whenReady 调用） */
export function initRuntimeState(): void {
  inMemoryHistory = loadHistoryFromFile();
  petStats = decayPetStats(loadPetStatsFromFile());
  savePetStatsToFile(petStats);
  console.log('[Z-Bot Main] 宠物状态已加载, stage:', petStats.stage, 'age:', petStats.age);
}

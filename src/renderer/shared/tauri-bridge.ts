/**
 * Electron → Tauri 桥。
 *
 * Z-Bot 的渲染层只认 `window.electronAPI`（96 个方法、67 处引用点）。本文件把它映射到
 * Tauri 的 invoke/listen，让壳可以先跑起来、端点再逐个往 Rust 搬。
 *
 * 类型仍然取自 src/preload/index.ts 的 `ElectronApi = typeof api`：垫片少实现一个方法
 * 就编译不过 —— 沿用 04 §T1.10（修复 D25「类型与运行时不一致」）的同一约束。
 * P4 删 preload 时，这个类型必须迁到渲染层自己的类型文件，否则整条编译期保护会静默消失。
 *
 * channel 名与 Electron 时代保持一致：Rust 侧 emit 的字符串就是这里的事件名。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ElectronApi } from '../../preload/index';

/** 已移植到 Rust 的 invoke 端点：方法名 → 命令名 + 位置参数名（顺序即实参顺序） */
const PORTED: Record<string, { cmd: string; params?: string[] }> = {
  getMode: { cmd: 'app_get_mode' },
  showWindow: { cmd: 'window_show', params: ['mode'] },
  hideWindow: { cmd: 'window_hide', params: ['mode'] },
  toggleWindow: { cmd: 'window_toggle', params: ['mode'] },
  movePetWindow: { cmd: 'window_move_pet', params: ['deltaX', 'deltaY'] },
  setPetPosition: { cmd: 'window_set_pet_position', params: ['x', 'y'] },
  setPetPositionWithBounds: { cmd: 'pet_set_position', params: ['x', 'y'] },
  triggerAnimation: { cmd: 'pet_trigger_animation', params: ['animType'] },
  stickToEdge: { cmd: 'window_stick_to_edge' },
  toggleStealth: { cmd: 'pet_toggle_stealth', params: ['enabled'] },
  getStealthMode: { cmd: 'pet_get_stealth_mode' },
  shortcutsList: { cmd: 'shortcuts_list' },
  shortcutsUpdate: { cmd: 'shortcuts_update', params: ['overrides'] },
  sttModels: { cmd: 'stt_models' },

  // 白名单内的文件读取（Rust 侧 files.rs + security.rs）
  fileRead: { cmd: 'file_read', params: ['filePath'] },
  fileReadAsBase64: { cmd: 'file_read_as_base64', params: ['filePath'] },

  // 配置 / 历史 / Pin（P1，Rust 侧 state.rs）
  loadConfig: { cmd: 'config_load' },
  saveConfig: { cmd: 'config_save', params: ['config'] },
  loadHistory: { cmd: 'history_load' },
  saveHistory: { cmd: 'history_save', params: ['messages'] },
  clearHistory: { cmd: 'history_clear' },
  getConversationHistory: { cmd: 'history_load' },
  addMessageToHistory: { cmd: 'conversation_add_message', params: ['message'] },
  clearConversation: { cmd: 'history_clear' },
  pinList: { cmd: 'pin_list' },
  pinCreate: { cmd: 'pin_create', params: ['content'] },
  pinRemove: { cmd: 'pin_remove', params: ['id'] },

  // 宠物养成（P1，数值规则原样搬自 stores.ts）
  petGetStats: { cmd: 'pet_get_stats' },
  petFeed: { cmd: 'pet_feed' },
  petPlay: { cmd: 'pet_play' },
  petWash: { cmd: 'pet_wash' },
  petSleep: { cmd: 'pet_sleep' },
  petMedicine: { cmd: 'pet_medicine' },
  petPet: { cmd: 'pet_pet' },

  // AI 引擎（P3，Rust 侧 ai.rs + router.rs；错误一律 resolve 成文案，不 reject）
  aiChat: { cmd: 'ai_chat', params: ['request'] },
  aiStreamChat: { cmd: 'ai_stream_chat', params: ['request'] },
  aiTestConnection: { cmd: 'ai_test_connection', params: ['providerConfig'] },
  aiGetModels: { cmd: 'ai_get_models', params: ['providerConfig'] },
  aiGetBuiltinProviders: { cmd: 'ai_get_builtin_providers' },

  // MCP 工具编排（P3，Rust 侧 tools.rs + limiter.rs + security.rs）
  toolsList: { cmd: 'tools_list' },
  toolsConfirm: { cmd: 'tools_confirm', params: ['toolCallId', 'approved', 'alwaysAllow'] },
  toolsCancel: { cmd: 'tools_cancel', params: ['toolCallId'] },
  toolsAlwaysAllowed: { cmd: 'tools_always_allowed' },
  toolsRevokeAlwaysAllowed: { cmd: 'tools_revoke_always_allowed', params: ['name'] },

  // 截图（P3，Rust 侧 screenshot.rs，GDI 直调而非 desktopCapturer）
  captureScreenshot: { cmd: 'screenshot_capture' },
  captureWindow: { cmd: 'screenshot_capture_window', params: ['windowName'] },
  captureAndAnalyze: { cmd: 'screenshot_capture_and_analyze', params: ['question'] },

  // 皮肤（P3，Rust 侧 skins.rs；订阅端 onApplySkin 是手写特例）
  getSkins: { cmd: 'pet_get_skins' },
  applySkin: { cmd: 'pet_apply_skin', params: ['skinId'] },
  applySkinTheme: { cmd: 'pet_apply_skin_theme', params: ['skinData'] },
};

/** 事件订阅端点：channel 与 Electron 同名，Rust 一 emit 就自动接通 */
const EVENTS: Record<string, string> = {
  onAiStreamChunk: 'ai:streamChunk',
  // onApplySkin 不在这里：Electron 的 preload 把它做成双通道收敛，见下面的手写特例
  onCursorDelta: 'pet:cursorDelta',
  onMeetingRollingSummary: 'meeting:rollingSummary',
  onMeetingSegment: 'meeting:segment',
  onMeetingState: 'meeting:state',
  onPushToTalkStart: 'voice:pushToTalkStart',
  onPushToTalkStop: 'voice:pushToTalkStop',
  onShortcutScreenshot: 'shortcut:screenshot',
  onTaskAction: 'task:action',
  onToolsConfirmRequest: 'tools:confirmRequest',
  onTriggerAnimation: 'pet:triggerAnimation',
  onUpdateStatus: 'update:status',
  onVoiceInterrupt: 'voice:interrupt',
  onVoiceStart: 'voice:start',
  onVoiceStop: 'voice:stop',
};

/** 未移植的端点必须显式失败，不能静默返回 undefined —— 否则前端只会看到一个空界面 */
export class NotPortedError extends Error {
  constructor(method: string) {
    super(`未移植到 Tauri：${method}（P3 端点清单里排队）`);
    this.name = 'NotPortedError';
  }
}

function zipArgs(names: string[] | undefined, args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  (names ?? []).forEach((n, i) => {
    out[n] = args[i];
  });
  return out;
}

const impl: Record<string, unknown> = {};

for (const [name, spec] of Object.entries(PORTED)) {
  impl[name] = (...args: unknown[]) => invoke(spec.cmd, zipArgs(spec.params, args));
}

for (const [name, channel] of Object.entries(EVENTS)) {
  impl[name] = (cb: (payload?: unknown) => void) => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen(channel, (event) => cb(event.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  };
}

// 皮肤订阅：Electron 的 preload 把两条通道收敛成同一个回调，渲染层拿到的一直是皮肤对象。
// pet:applySkin 送的是 skinId 字符串，必须回查 getSkins；pet:applySkinData 直接送对象。
// 若这里按普通 EVENTS 直传，App.tsx:293 的 `(skin: PetSkin) => ...` 会收到一个字符串。
type SkinRecord = { id?: string };
impl.onApplySkin = (cb: (payload?: unknown) => void) => {
  let cancelled = false;
  const pending: Array<Promise<UnlistenFn>> = [
    listen<string>('pet:applySkin', (event) => {
      const skinId = event.payload;
      void invoke<SkinRecord[]>('pet_get_skins')
        .then((skins) => {
          const skin = skins.find((s) => s.id === skinId);
          if (skin && !cancelled) cb(skin);
        })
        .catch(() => {});
    }),
    listen<SkinRecord>('pet:applySkinData', (event) => {
      if (!cancelled) cb(event.payload);
    }),
  ];
  return () => {
    cancelled = true;
    for (const p of pending) void p.then((fn) => fn());
  };
};

// 渲染层日志：Electron 走 ipcRenderer.send('log')（发完就返回）。Tauri 没有 send 语义，
// 这里 invoke 之后忽略回执 —— 打包后的 exe 没有控制台，Rust 侧会把它并进 ~/.z-bot/logs/app.log。
impl.log = (msg: unknown) => {
  console.log('[Z-Bot]', msg);
  void invoke('console_log', { message: String(msg) }).catch(() => {});
};

const bridge = new Proxy(impl, {
  get(target, prop) {
    if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return undefined;
    if (prop in target) return target[prop];
    return (...args: unknown[]) => Promise.reject(new NotPortedError(`${prop}(${args.length} 参数)`));
  },
}) as unknown as ElectronApi;

window.electronAPI = bridge;

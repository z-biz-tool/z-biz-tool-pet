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
};

/** 事件订阅端点：channel 与 Electron 同名，Rust 一 emit 就自动接通 */
const EVENTS: Record<string, string> = {
  onAiStreamChunk: 'ai:streamChunk',
  onApplySkin: 'pet:applySkin',
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

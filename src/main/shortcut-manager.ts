import { globalShortcut } from 'electron';

/**
 * 全局快捷键的唯一来源（T4.9）。
 * 之前 shortcut-manager 与 index.ts 里各有一份注册代码，且萌宠切换的
 * CommandOrControl+Shift+Z 从来没被真正调用过（旧实现是无人调用的死代码）。
 * 这里集中定义默认值、支持用户自定义并整体热重载。
 */

export type ShortcutKey =
  | 'petShowHide'
  | 'screenshot'
  | 'note'
  | 'whisperStart'
  | 'pushToTalkStart'
  | 'pushToTalkStop';

// 翻译取词（原 CommandOrControl+Alt+T）已下架：跨应用取词要系统级选区读取，本仓库没有该能力，
// 保留绑定只会从其他应用手里偷走快捷键却只弹一句"待实现"。
export const DEFAULT_ACCELERATORS: Record<ShortcutKey, string> = {
  petShowHide: 'CommandOrControl+Shift+Z',
  screenshot: 'CommandOrControl+Alt+S',
  note: 'CommandOrControl+Alt+N',
  whisperStart: 'CommandOrControl+Alt+P',
  pushToTalkStart: 'Alt+Shift+V',
  pushToTalkStop: 'Alt+Shift+C',
};

export const SHORTCUT_LABELS: Record<ShortcutKey, string> = {
  petShowHide: '显示/隐藏萌宠',
  screenshot: '截图分析',
  note: '快速笔记（剪贴板存入便签）',
  whisperStart: '唤醒宠物（开始语音对话）',
  pushToTalkStart: '按住说话 · 开始',
  pushToTalkStop: '按住说话 · 停止',
};

export type ShortcutOverrides = Partial<Record<ShortcutKey, string>>;

export interface ShortcutDeps {
  togglePet: () => void;
  broadcast: (channel: string) => void;
  /** 快速笔记：把剪贴板文本存成 Pin 便签，返回结果供通知文案使用 */
  quickNote: () => { success: boolean; error?: string; content?: string };
  /** 唤醒宠物：显示萌宠并进入语音对话 */
  wakePet: () => void;
}

const state: Record<ShortcutKey, boolean> = {
  petShowHide: false,
  screenshot: false,
  note: false,
  whisperStart: false,
  pushToTalkStart: false,
  pushToTalkStop: false,
};

let deps: ShortcutDeps | null = null;
let pushToTalkActive = false;
// 本次实际生效的加速键（registerShortcuts 时确定），供设置面板回显
let applied: Record<ShortcutKey, string> = { ...DEFAULT_ACCELERATORS };

export function initShortcuts(d: ShortcutDeps): void {
  deps = d;
}

/** Electron 接受的加速键格式校验：至少要有一个修饰键，且不含空格/换行 */
export function isValidAccelerator(accel: string): boolean {
  if (typeof accel !== 'string') return false;
  const trimmed = accel.trim();
  if (!trimmed || trimmed.length > 60 || /\s{2,}/.test(trimmed)) return false;
  if (!/[+](CommandOrControl|Cmd|Control|Ctrl|Alt|Option|Shift|Super)/i.test(trimmed)) return false;
  const last = trimmed.split('+').pop() || '';
  return /^[A-Za-z0-9`]$|^(Up|Down|Left|Right|Space|Enter|Tab|Esc|F[0-9]{1,2})$/i.test(last);
}

function accelerators(overrides: ShortcutOverrides = {}): Record<ShortcutKey, string> {
  const merged = { ...DEFAULT_ACCELERATORS } as Record<ShortcutKey, string>;
  for (const key of Object.keys(DEFAULT_ACCELERATORS) as ShortcutKey[]) {
    const custom = overrides[key];
    if (custom && isValidAccelerator(custom)) merged[key] = custom.trim();
  }
  return merged;
}

function bind(key: ShortcutKey, accel: string, handler: () => void, failed: string[]): void {
  let ok: boolean;
  try {
    ok = globalShortcut.isRegistered(accel) ? false : globalShortcut.register(accel, handler);
  } catch {
    ok = false;
  }
  state[key] = ok;
  if (!ok) {
    failed.push(`${key} (${accel})`);
    console.warn(`[Shortcut] 注册失败或已被占用: ${key} → ${accel}`);
    return;
  }
  console.log(`[Shortcut] ${key} 已注册: ${accel}`);
}

/** 注册全部快捷键；返回失败项（被其他应用占用等） */
export function registerShortcuts(overrides: ShortcutOverrides = {}): { failed: string[] } {
  if (!deps) throw new Error('initShortcuts() 未调用');
  const acc = accelerators(overrides);
  applied = acc;
  const failed: string[] = [];

  bind('petShowHide', acc.petShowHide, () => deps!.togglePet(), failed);
  bind('screenshot', acc.screenshot, () => deps!.broadcast('shortcut:screenshot'), failed);
  bind('note', acc.note, () => deps!.quickNote(), failed);
  bind('whisperStart', acc.whisperStart, () => deps!.wakePet(), failed);
  bind(
    'pushToTalkStart',
    acc.pushToTalkStart,
    () => {
      pushToTalkActive = true;
      deps!.broadcast('voice:pushToTalkStart');
    },
    failed
  );
  bind(
    'pushToTalkStop',
    acc.pushToTalkStop,
    () => {
      pushToTalkActive = false;
      deps!.broadcast('voice:pushToTalkStop');
    },
    failed
  );

  return { failed };
}

/** 用户改了加速键后热重载：先全清再按新值注册 */
export function reloadShortcuts(overrides: ShortcutOverrides = {}): { failed: string[] } {
  globalShortcut.unregisterAll();
  for (const key of Object.keys(state) as ShortcutKey[]) state[key] = false;
  return registerShortcuts(overrides);
}

export function getShortcuts(): {
  key: ShortcutKey;
  label: string;
  accelerator: string;
  defaultAccelerator: string;
  registered: boolean;
}[] {
  const acc = applied;
  return (Object.keys(DEFAULT_ACCELERATORS) as ShortcutKey[]).map((key) => ({
    key,
    label: SHORTCUT_LABELS[key],
    accelerator: acc[key],
    defaultAccelerator: DEFAULT_ACCELERATORS[key],
    registered: state[key],
  }));
}

export function isPushToTalkActive(): boolean {
  return pushToTalkActive;
}

export function setPushToTalkActive(v: boolean): void {
  pushToTalkActive = v;
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
  for (const key of Object.keys(state) as ShortcutKey[]) state[key] = false;
}

import { app, Menu, MenuItemConstructorOptions } from 'electron';

/**
 * 托盘菜单单一构建函数（doc/优化方案/03 T3.12，修复 D15 的 70 行重复）
 */
export interface TrayNote {
  id: string;
  content: string;
  createdAt: string;
}

export interface TrayContext {
  isPetVisible: () => boolean;
  togglePet: () => void;
  showPet: () => void;
  showAdmin: () => void;
  openSettings: () => void;
  sendVoice: (event: 'voice:start' | 'voice:stop') => void;
  getStealthMode: () => boolean;
  setStealthMode: (enabled: boolean) => void;
  getClickThrough: () => boolean;
  setClickThrough: (enabled: boolean) => void;
  listNotes: () => TrayNote[];
  clearNotes: () => void;
  copyNote: (content: string) => void;
  /** 便签增删后重建菜单（菜单项是打开时的快照） */
  refreshMenu: () => void;
  quit: () => void;
}

/** 便签此前只能写不能读（pinList 无人调用），在托盘补齐查看/取用入口 */
function buildNotesSubmenu(ctx: TrayContext): MenuItemConstructorOptions[] {
  let notes: TrayNote[];
  try {
    notes = ctx.listNotes();
  } catch (e: any) {
    console.warn('[Z-Bot Tray] 便签读取失败:', e?.message);
    return [{ label: '便签读取失败，可在设置里重试', enabled: false }];
  }
  if (notes.length === 0) {
    return [
      { label: '暂无笔记', enabled: false },
      { label: '复制文字后按「快速笔记」快捷键即可存入', enabled: false },
    ];
  }
  const items: MenuItemConstructorOptions[] = notes.map((note) => ({
    label: note.content.replace(/\s+/g, ' ').slice(0, 28) || '(空白的笔记)',
    click: () => ctx.copyNote(note.content),
  }));
  items.push({ type: 'separator' });
  items.push({
    label: `共 ${notes.length} 条 · 点击复制`,
    enabled: false,
  });
  items.push({
    label: '清空全部笔记',
    click: () => {
      ctx.clearNotes();
      ctx.refreshMenu();
    },
  });
  return items;
}

export function buildTrayTemplate(ctx: TrayContext): MenuItemConstructorOptions[] {
  return [
    {
      label: '🐱 显示萌宠',
      click: () => (ctx.isPetVisible() ? ctx.togglePet() : ctx.showPet()),
    },
    {
      label: '💻 打开管理端',
      click: () => ctx.showAdmin(),
    },
    { type: 'separator' },
    { label: '🎙️ 开始语音对话', click: () => ctx.sendVoice('voice:start') },
    { label: '⏹️ 停止语音对话', click: () => ctx.sendVoice('voice:stop') },
    { type: 'separator' },
    { label: '📝 快速笔记', submenu: buildNotesSubmenu(ctx) },
    {
      label: '🕵️ 截图隐身',
      type: 'checkbox',
      checked: ctx.getStealthMode(),
      click: (item) => ctx.setStealthMode(item.checked),
    },
    {
      label: '🫥 点击穿透',
      type: 'checkbox',
      checked: ctx.getClickThrough(),
      click: (item) => ctx.setClickThrough(item.checked),
    },
    { type: 'separator' },
    { label: '⚙️ 设置', click: () => ctx.openSettings() },
    {
      label: '🚀 开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: '❌ 退出', click: () => ctx.quit() },
  ];
}

export function buildTrayMenu(ctx: TrayContext): Menu {
  return Menu.buildFromTemplate(buildTrayTemplate(ctx));
}

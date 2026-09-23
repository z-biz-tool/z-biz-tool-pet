import { app, Menu, MenuItemConstructorOptions } from 'electron';

/**
 * 托盘菜单单一构建函数（doc/优化方案/03 T3.12，修复 D15 的 70 行重复）
 */
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
  quit: () => void;
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

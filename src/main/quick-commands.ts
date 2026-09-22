// 快捷指令配置
export interface QuickCommand {
  id: string;
  name: string;
  trigger: string; // 触发关键词
  response: string; // 回复内容
  action?: 'chat' | 'command' | 'shortcut'; // 动作类型
  command?: string; // 执行的系统命令
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// 快捷指令示例
export const DEFAULT_QUICK_COMMANDS: QuickCommand[] = [
  {
    id: 'cmd_1',
    name: '查天气',
    trigger: '今天天气',
    response: '好的！让我帮你查一下天气~ 🌤️',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cmd_2',
    name: '定番茄钟',
    trigger: '番茄钟',
    response: '好的！开始25分钟专注时间~ 🍅',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cmd_3',
    name: '讲笑话',
    trigger: '讲个笑话',
    response: '为什么程序员分不清万圣节和圣诞节？因为 Oct 31 == Dec 25！😂',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cmd_4',
    name: '休息提醒',
    trigger: '休息一下',
    response: '好呀！起来活动一下身体吧~ 🧘',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cmd_5',
    name: '鼓励一下',
    trigger: '加油',
    response: '你一定可以的！我相信你！💪🐱',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// 快捷指令管理
export interface QuickCommandManager {
  commands: QuickCommand[];
  load(): QuickCommand[];
  save(commands: QuickCommand[]): void;
  add(command: QuickCommand): void;
  remove(id: string): void;
  update(id: string, updates: Partial<QuickCommand>): void;
  find(trigger: string): QuickCommand | undefined;
}

// 简单实现
let commands: QuickCommand[] = [];

export const QuickCommandManager: QuickCommandManager = {
  get commands() {
    return commands;
  },
  load: () => {
    return commands;
  },
  save: (cmds) => {
    commands = cmds;
  },
  add: (cmd) => {
    commands.push(cmd);
  },
  remove: (id) => {
    commands = commands.filter(c => c.id !== id);
  },
  update: (id, updates) => {
    const index = commands.findIndex(c => c.id === id);
    if (index >= 0) {
      commands[index] = { ...commands[index], ...updates, updatedAt: new Date().toISOString() };
    }
  },
  find: (trigger) => {
    return commands.find(c => c.trigger === trigger && c.enabled);
  },
};

// 添加默认指令
export function initQuickCommands(): void {
  // 如果没有指令，添加默认的
  if (commands.length === 0) {
    commands = [...DEFAULT_QUICK_COMMANDS];
  }
}

// 检查是否匹配快捷指令
export function checkQuickCommand(text: string): QuickCommand | undefined {
  const lowerText = text.toLowerCase();
  return commands.find(c => {
    if (!c.enabled) return false;
    const triggerLower = c.trigger.toLowerCase();
    return lowerText.includes(triggerLower);
  });
}

// 获取指令列表
export function getQuickCommands(): QuickCommand[] {
  return commands.filter(c => c.enabled);
}

// 根据关键词查找响应
export function getQuickCommandResponse(keyword: string): string | undefined {
  const cmd = commands.find(c => c.trigger === keyword && c.enabled);
  return cmd?.response;
}

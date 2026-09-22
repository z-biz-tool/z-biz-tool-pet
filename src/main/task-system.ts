import * as cronParser from 'cron-parser';

// ---------- 任务动作投递通道 ----------
// main 不是子进程，process.send 恒为 undefined（修复 D12）；
// 由主进程注入真实的窗口 IPC 分发器与命令确认器。
export interface TaskDispatcher {
  dispatch: (payload: { type: string; content: string; taskName?: string }) => void;
  requestCommandRun: (taskName: string, command: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
}

let dispatcher: TaskDispatcher | null = null;

export function setTaskDispatcher(d: TaskDispatcher): void {
  dispatcher = d;
}

// 自动化任务系统
export interface Task {
  id: string;
  name: string;
  type: 'timer' | 'cron' | 'trigger' | 'sequence';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// 定时任务
export interface TimerTask extends Task {
  type: 'timer';
  interval: number; // 毫秒
  action: {
    type: 'speak' | 'animation' | 'changeScenery' | 'petAction' | 'command';
    content: string;
  };
}

// Cron任务
export interface CronTask extends Task {
  type: 'cron';
  cron: string; // cron表达式
  action: {
    type: 'speak' | 'animation' | 'changeScenery' | 'petAction' | 'command';
    content: string;
  };
}

// 触发任务
export interface TriggerTask extends Task {
  type: 'trigger';
  trigger: string; // 触发关键词
  action: {
    type: 'speak' | 'animation' | 'changeScenery' | 'petAction' | 'command';
    content: string;
  };
}

// 任务流
export interface SequenceTask extends Task {
  type: 'sequence';
  steps: {
    delay: number;
    action: {
      type: 'speak' | 'animation' | 'changeScenery' | 'petAction' | 'command';
      content: string;
    };
  }[];
}

// 任务执行器
export interface TaskExecutor {
  execute(action: any, task?: Task): Promise<void>;
}

// 任务管理
export interface TaskManager {
  getTasks(): Task[];
  add(task: Task): void;
  update(id: string, updates: Partial<Task>): void;
  remove(id: string): void;
  enable(id: string): void;
  disable(id: string): void;
}

let tasks: Task[] = [];

// 任务调度器状态
interface SchedulerState {
  cronJobs: Map<string, NodeJS.Timeout>;
  timerJobs: Map<string, NodeJS.Timeout>;
  lastCronCheck: Date;
}

const schedulerState: SchedulerState = {
  cronJobs: new Map(),
  timerJobs: new Map(),
  lastCronCheck: new Date(),
};

export const TaskManager: TaskManager = {
  getTasks: () => tasks,
  add: (task) => {
    tasks.push(task);
  },
  update: (id, updates) => {
    const index = tasks.findIndex(t => t.id === id);
    if (index >= 0) {
      tasks[index] = { ...tasks[index], ...updates, updatedAt: new Date().toISOString() };
    }
  },
  remove: (id) => {
    tasks = tasks.filter(t => t.id !== id);
  },
  enable: (id) => {
    const task = tasks.find(t => t.id === id);
    if (task) task.enabled = true;
  },
  disable: (id) => {
    const task = tasks.find(t => t.id === id);
    if (task) task.enabled = false;
  },
};

// 任务执行器实现
export const TaskExecutor: TaskExecutor = {
  async execute(action: any, task?: Task): Promise<void> {
    console.log('[Task System] 执行任务动作:', action.type, action.content);
    const taskName = task?.name ?? '未命名任务';

    switch (action.type) {
      case 'speak':
      case 'animation':
      case 'changeScenery':
      case 'petAction':
        // 经主进程注入的分发器送达窗口（修复 D12）
        if (!dispatcher) {
          console.warn('[Task System] 分发器未注入，动作被丢弃:', action.type);
          return;
        }
        console.log('[Task System] 投递动作到宠物窗口:', action.type);
        dispatcher.dispatch({ type: action.type, content: action.content, taskName });
        break;

      case 'command': {
        // 高危动作：必须由主进程取得用户确认后才执行（修复 D03）
        if (!dispatcher) {
          console.error('[Task System] 未注入命令确认器，拒绝执行 shell 动作');
          return;
        }
        try {
          const result = await dispatcher.requestCommandRun(taskName, action.content);
          if (result.ok) console.log('[Task System] 命令执行成功:', result.output?.trim());
          else console.error('[Task System] 命令未执行或失败:', result.error);
        } catch (error: any) {
          // 调度器以 setInterval 触发且不 await，异常必须在此截住，否则变成 unhandled rejection
          console.error('[Task System] 命令动作异常:', error.message);
        }
        break;
      }

      default:
        console.warn('[Task System] 未知动作类型:', action.type);
    }
  }
};

// Cron任务调度器
function scheduleCronTask(task: CronTask): NodeJS.Timeout {
  let lastRun: Date | null = null;
  
  const job = setInterval(() => {
    try {
      const parser = cronParser.parseExpression(task.cron);
      const nextRun = parser.next().toDate();
      
      // 检查是否到了执行时间（允许1分钟内的误差）
      const now = new Date();
      const diffMinutes = Math.abs((now.getTime() - nextRun.getTime()) / 60000);
      
      if (diffMinutes <= 1 && (!lastRun || (now.getTime() - lastRun.getTime()) > 60000)) {
        // 执行任务
        TaskExecutor.execute(task.action, task);
        lastRun = now;
      }
    } catch (error: any) {
      console.error('[Task System] Cron解析失败:', error.message);
    }
  }, 60000); // 每分钟检查一次
  
  return job;
}

// 定时任务调度器
function scheduleTimerTask(task: TimerTask): NodeJS.Timeout {
  return setInterval(() => {
    TaskExecutor.execute(task.action, task);
  }, task.interval);
}

// 启动任务调度器
export function startTaskScheduler(): void {
  console.log('[Task System] 任务调度器启动');
  
  // 清除旧的调度
  schedulerState.cronJobs.forEach(job => clearInterval(job));
  schedulerState.timerJobs.forEach(job => clearInterval(job));
  schedulerState.cronJobs.clear();
  schedulerState.timerJobs.clear();
  
  // 启动新的调度
  tasks.forEach(task => {
    if (!task.enabled) return;
    
    switch (task.type) {
      case 'cron':
        const cronTask = task as CronTask;
        const cronJob = scheduleCronTask(cronTask);
        schedulerState.cronJobs.set(task.id, cronJob);
        console.log('[Task System] Cron任务已调度:', cronTask.name, cronTask.cron);
        break;
      
      case 'timer':
        const timerTask = task as TimerTask;
        const timerJob = scheduleTimerTask(timerTask);
        schedulerState.timerJobs.set(task.id, timerJob);
        console.log('[Task System] 定时任务已调度:', timerTask.name, timerTask.interval + 'ms');
        break;
    }
  });
}

// 停止任务调度器
export function stopTaskScheduler(): void {
  console.log('[Task System] 任务调度器停止');
  
  schedulerState.cronJobs.forEach(job => clearInterval(job));
  schedulerState.timerJobs.forEach(job => clearInterval(job));
  schedulerState.cronJobs.clear();
  schedulerState.timerJobs.clear();
}

// 预设任务
export const DEFAULT_TASKS: (TimerTask | CronTask | TriggerTask | SequenceTask)[] = [
  {
    id: 'task_1',
    name: '定时问候',
    type: 'cron',
    cron: '0 9 * * *',
    action: {
      type: 'speak',
      content: '早上好！今天也要加油哦！☀️',
    },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'task_2',
    name: '休息提醒',
    type: 'cron',
    cron: '0 * * * *',
    action: {
      type: 'speak',
      content: '工作累了要记得休息哦~ 🧘',
    },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'task_3',
    name: '晚上好',
    type: 'cron',
    cron: '0 18 * * *',
    action: {
      type: 'speak',
      content: '晚上好！今天辛苦了~ 🌙',
    },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'task_4',
    name: '晚安',
    type: 'cron',
    cron: '0 23 * * *',
    action: {
      type: 'speak',
      content: '晚安！做个好梦~ 💤',
    },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'task_5',
    name: '心情问候',
    type: 'trigger',
    trigger: '心情不好',
    action: {
      type: 'speak',
      content: '抱抱你~ 不开心的时候我可以陪你~ 💕',
    },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'task_6',
    name: '工作加油',
    type: 'trigger',
    trigger: '加油',
    action: {
      type: 'speak',
      content: '你一定可以的！加油！💪',
    },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// 初始化预设任务
export function initTasks(): void {
  if (tasks.length === 0) {
    tasks = [...DEFAULT_TASKS];
  }
}

// 获取特定类型的任务
export function getTasksByType(type: Task['type']): Task[] {
  return tasks.filter(t => t.type === type && t.enabled);
}

// 获取所有启用的任务
export function getEnabledTasks(): Task[] {
  return tasks.filter(t => t.enabled);
}

// 根据ID获取任务
export function getTaskById(id: string): Task | undefined {
  return tasks.find(t => t.id === id);
}

// 重置所有任务
export function resetTasks(): void {
  tasks = [];
}

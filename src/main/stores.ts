import * as path from 'path';
import {
  JsonStore,
  dataDir,
  configFile,
  saveApiKey,
  resolveApiKey,
} from './config-store';

/**
 * 应用侧的持久化状态：配置 / 对话历史 / 宠物养成 / Pin 卡片。
 * 类型与读写集中在这一层，index.ts 只做装配，IPC 模块从这里取数（doc/优化方案 T3.1）。
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface PetConfig {
  ollamaUrl: string;
  modelName: string;
  systemPrompt: string;
  sttUrl: string;
  ttsUrl: string;
  voiceSpeed: number;
  petName: string;
  themeColor: string;
  currentSkinId?: string;
  stealthMode?: boolean;
  aiProvider?: string;
  aiApiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  providers?: any[];
  
  // 新功能配置
  quickCommands?: any[];
  memoryEnabled?: boolean;
  sceneryEnabled?: boolean;
  particleEnabled?: boolean;
  taskSchedulerEnabled?: boolean;
  autoSwitchScenery?: boolean;
  autoExtractMemory?: boolean;
  // T4.9 可调项
  interruptThreshold?: number;
  sttModel?: string;
  shortcuts?: Record<string, string>;
}

// ---------- 宠物养成系统 ----------
export interface PetStats {
  hunger: number;      // 0-100, 每30分钟-1
  happiness: number;   // 0-100, 每20分钟-1
  energy: number;      // 0-100, 每45分钟-1, 睡觉时+2/分钟
  cleanliness: number; // 0-100, 每60分钟-1
  health: number;      // 0-100, 由其他属性低时自动下降
  affection: number;   // 0-100 好感度, 对话+1, 忽略-1/天
  age: number;         // 天数
  stage: 'egg' | 'baby' | 'child' | 'adult'; // 生命周期
  bornAt: string;      // ISO时间戳
  lastUpdate: string;  // 上次更新时间
  isSleeping: boolean;
  isSick: boolean;
}

export const DEFAULT_PET_STATS: PetStats = {
  hunger: 80,
  happiness: 80,
  energy: 80,
  cleanliness: 80,
  health: 100,
  affection: 50,
  age: 0,
  stage: 'egg',
  bornAt: new Date().toISOString(),
  lastUpdate: new Date().toISOString(),
  isSleeping: false,
  isSick: false,
};

export const DEFAULT_CONFIG: PetConfig = {
  ollamaUrl: 'http://localhost:11434',
  modelName: 'qwen2.5:7b-instruct-q4_K_M',
  systemPrompt: '',
  sttUrl: 'http://localhost:8084',
  ttsUrl: 'http://localhost:8086',
  voiceSpeed: 1.0,
  petName: 'Z-Bot 小猫咪',
  themeColor: '#722ed1',
  stealthMode: true,
  // 新功能默认配置
  memoryEnabled: true,
  sceneryEnabled: true,
  particleEnabled: true,
  taskSchedulerEnabled: true,
  autoSwitchScenery: true,
  autoExtractMemory: true,
  interruptThreshold: 30,
  sttModel: 'base',
};

// ---------- 持久化：内存缓存 + 异步原子写（T3.9，修复 D22/D23） ----------
export const MAX_HISTORY_LENGTH = 200;

export const configStore = new JsonStore<PetConfig>(configFile, DEFAULT_CONFIG);
export const historyStore = new JsonStore<ChatMessage[]>(path.join(dataDir, 'history.json'), []);
export const petStatsStore = new JsonStore<PetStats>(path.join(dataDir, 'pet_stats.json'), DEFAULT_PET_STATS);
export const pinStore = new JsonStore<PinCard[]>(path.join(dataDir, 'pins.json'), []);

export function saveHistoryToFile(messages: ChatMessage[]) {
  void historyStore.write(messages);
}

export function loadHistoryFromFile(): ChatMessage[] {
  return historyStore.read();
}

export function saveConfigToFile(config: PetConfig) {
  // 密钥不进明文配置：单独加密落盘（T4.10）
  if (typeof config.aiApiKey === 'string' && config.aiApiKey) {
    saveApiKey(config.aiApiKey);
    void configStore.write({ ...config, aiApiKey: '' });
    return;
  }
  void configStore.write(config);
}

export function loadConfigFromFile(): PetConfig {
  const cfg = configStore.read();
  const stored = resolveApiKey(cfg);
  return stored ? { ...cfg, aiApiKey: stored } : cfg;
}

export function savePetStatsToFile(stats: PetStats) {
  void petStatsStore.write(stats);
  petStatsStore.scheduleFlush();
}

export function loadPetStatsFromFile(): PetStats {
  return petStatsStore.read();
}

/** 将值限制在 0-100 范围内 */
export function clampStat(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** 根据时间差计算衰减并更新宠物状态 */
export function decayPetStats(stats: PetStats): PetStats {
  const now = new Date();
  const lastUpdate = new Date(stats.lastUpdate);
  const diffMs = now.getTime() - lastUpdate.getTime();
  const diffMinutes = Math.max(0, diffMs / 60000);

  if (diffMinutes < 1) return stats; // 不足1分钟不衰减

  let { hunger, happiness, energy, cleanliness, health, stage } = stats;
  const { affection, isSleeping, bornAt } = stats;

  // 基础衰减
  hunger = clampStat(hunger - Math.floor(diffMinutes / 30));
  happiness = clampStat(happiness - Math.floor(diffMinutes / 20));
  cleanliness = clampStat(cleanliness - Math.floor(diffMinutes / 60));

  if (isSleeping) {
    // 睡觉时能量恢复 +2/分钟
    energy = clampStat(energy + Math.floor(diffMinutes * 2));
  } else {
    energy = clampStat(energy - Math.floor(diffMinutes / 45));
  }

  // 如果hunger<20或cleanliness<20, health开始下降
  if (hunger < 20 || cleanliness < 20) {
    const decayRate = (hunger < 20 ? 1 : 0) + (cleanliness < 20 ? 1 : 0);
    health = clampStat(health - Math.floor(diffMinutes / 60) * decayRate);
  }

  // 如果health<10, isSick=true
  const isSick = health < 10;

  // 计算年龄（天数）
  const bornDate = new Date(bornAt);
  const ageDays = Math.floor((now.getTime() - bornDate.getTime()) / (1000 * 60 * 60 * 24));
  const age = ageDays;

  // 生命周期进化: 如果所有属性>60且age满足条件
  const allAbove60 = hunger > 60 && happiness > 60 && energy > 60 && cleanliness > 60 && health > 60;
  if (allAbove60) {
    if (stage === 'egg' && age >= 1) stage = 'baby';
    else if (stage === 'baby' && age >= 3) stage = 'child';
    else if (stage === 'child' && age >= 7) stage = 'adult';
  }

  return {
    ...stats,
    hunger,
    happiness,
    energy,
    cleanliness,
    health,
    affection,
    age,
    stage,
    isSleeping,
    isSick,
    lastUpdate: now.toISOString(),
  };
}

export interface PinCard {
  id: string;
  content: string;
  createdAt: string;
  conversationId?: string;
}

export function loadPinCards(): PinCard[] {
  return pinStore.read();
}

export function savePinCards(pins: PinCard[]) {
  void pinStore.write(pins);
}

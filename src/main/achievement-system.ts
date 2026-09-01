// 成就系统
export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  condition: (stats: PetStats, history: AchievementHistory) => boolean;
  reward: {
    affection: number;
    happiness: number;
    badge: string;
  };
  unlocked: boolean;
  unlockedAt?: string;
  order: number;
}

// 成就历史
export interface AchievementHistory {
  [achievementId: string]: {
    unlocked: boolean;
    unlockedAt?: string;
    progress: number;
    total: number;
  };
}

// 宠物状态
export interface PetStats {
  hunger: number;
  happiness: number;
  energy: number;
  cleanliness: number;
  health: number;
  affection: number;
  age: number;
  stage: 'egg' | 'baby' | 'child' | 'adult';
  bornAt: string;
  lastUpdate: string;
  isSleeping: boolean;
  isSick: boolean;
  totalFeed: number;
  totalPlay: number;
  totalTalk: number;
  consecutiveDays: number;
  lastLogin: string;
}

// 成就列表
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_feed',
    title: '第一餐',
    description: '给宠物喂食',
    icon: '🍖',
    condition: (stats, history) => stats.totalFeed >= 1 && !history['first_feed']?.unlocked,
    reward: { affection: 10, happiness: 5, badge: '🍜' },
    unlocked: false,
    order: 1,
  },
  {
    id: 'first_play',
    title: '第一次玩耍',
    description: '和宠物玩耍',
    icon: '🎮',
    condition: (stats, history) => stats.totalPlay >= 1 && !history['first_play']?.unlocked,
    reward: { affection: 10, happiness: 10, badge: '🎾' },
    unlocked: false,
    order: 2,
  },
  {
    id: 'first_talk',
    title: '第一次对话',
    description: '和宠物说第一句话',
    icon: '💬',
    condition: (stats, history) => stats.totalTalk >= 1 && !history['first_talk']?.unlocked,
    reward: { affection: 15, happiness: 5, badge: '🗣️' },
    unlocked: false,
    order: 3,
  },
  {
    id: 'stage_baby',
    title: '成长为幼崽',
    description: '宠物成长为幼崽阶段',
    icon: '👶',
    condition: (stats, history) => stats.stage === 'baby' && !history['stage_baby']?.unlocked,
    reward: { affection: 20, happiness: 20, badge: '👶' },
    unlocked: false,
    order: 10,
  },
  {
    id: 'stage_child',
    title: '成长为孩童',
    description: '宠物成长为孩童阶段',
    icon: '🧒',
    condition: (stats, history) => stats.stage === 'child' && !history['stage_child']?.unlocked,
    reward: { affection: 30, happiness: 30, badge: '🧒' },
    unlocked: false,
    order: 20,
  },
  {
    id: 'stage_adult',
    title: '成长为成年',
    description: '宠物成长为成年阶段',
    icon: '🐱',
    condition: (stats, history) => stats.stage === 'adult' && !history['stage_adult']?.unlocked,
    reward: { affection: 50, happiness: 50, badge: '👑' },
    unlocked: false,
    order: 30,
  },
  {
    id: '100_affection',
    title: '亲密无间',
    description: '好感度达到100',
    icon: '❤️',
    condition: (stats, history) => stats.affection >= 100 && !history['100_affection']?.unlocked,
    reward: { affection: 100, happiness: 100, badge: '💖' },
    unlocked: false,
    order: 40,
  },
  {
    id: '7_days',
    title: '一周陪伴',
    description: '连续陪伴7天',
    icon: '📅',
    condition: (stats, history) => stats.consecutiveDays >= 7 && !history['7_days']?.unlocked,
    reward: { affection: 30, happiness: 30, badge: '📅' },
    unlocked: false,
    order: 50,
  },
  {
    id: '30_days',
    title: '一个月陪伴',
    description: '连续陪伴30天',
    icon: '🎁',
    condition: (stats, history) => stats.consecutiveDays >= 30 && !history['30_days']?.unlocked,
    reward: { affection: 50, happiness: 50, badge: '🎉' },
    unlocked: false,
    order: 60,
  },
  {
    id: 'health_master',
    title: '健康大师',
    description: '保持健康100天',
    icon: '🏥',
    condition: (stats, history) => stats.health >= 90 && !history['health_master']?.unlocked,
    reward: { affection: 20, happiness: 20, badge: '🛡️' },
    unlocked: false,
    order: 70,
  },
  {
    id: 'happy_pet',
    title: '快乐宠物',
    description: '保持快乐100天',
    icon: '😄',
    condition: (stats, history) => stats.happiness >= 90 && !history['happy_pet']?.unlocked,
    reward: { affection: 20, happiness: 20, badge: '🎈' },
    unlocked: false,
    order: 80,
  },
  {
    id: 'total_100_talk',
    title: '聊天达人',
    description: '总共聊天100次',
    icon: '📝',
    condition: (stats, history) => stats.totalTalk >= 100 && !history['total_100_talk']?.unlocked,
    reward: { affection: 30, happiness: 30, badge: '🎤' },
    unlocked: false,
    order: 90,
  },
];

// 成就管理系统
export interface AchievementManager {
  getAchievements(): Achievement[];
  checkUnlocks(stats: PetStats, history: AchievementHistory): Achievement[];
  unlock(achievementId: string, stats: PetStats): void;
  getUnlockedCount(history: AchievementHistory): number;
  getTotalCount(): number;
}

export const AchievementManager: AchievementManager = {
  getAchievements: () => ACHIEVEMENTS,
  checkUnlocks: (stats, history) => {
    const unlocked: Achievement[] = [];
    for (const achievement of ACHIEVEMENTS) {
      if (!history[achievement.id]?.unlocked && achievement.condition(stats, history)) {
        unlocked.push(achievement);
      }
    }
    return unlocked;
  },
  unlock: (achievementId, stats) => {
    const achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
    if (achievement) {
      achievement.unlocked = true;
      achievement.unlockedAt = new Date().toISOString();
      
      // 奖励宠物
      stats.affection = Math.min(100, stats.affection + achievement.reward.affection);
      stats.happiness = Math.min(100, stats.happiness + achievement.reward.happiness);
    }
  },
  getUnlockedCount: (history) => {
    return Object.values(history).filter(h => h.unlocked).length;
  },
  getTotalCount: () => ACHIEVEMENTS.length,
};

// 获取未解锁的成就
export function getUnlockedAchievements(history: AchievementHistory): Achievement[] {
  return ACHIEVEMENTS.filter(a => a.unlocked);
}

// 获取已解锁成就数量
export function getUnlockedCount(history: AchievementHistory): number {
  return Object.values(history).filter(h => h.unlocked).length;
}

// 计算解锁进度
export function getUnlockProgress(history: AchievementHistory): { current: number; total: number; percentage: number } {
  const total = ACHIEVEMENTS.length;
  const current = getUnlockedCount(history);
  return {
    current,
    total,
    percentage: Math.round((current / total) * 100),
  };
}

// 重置所有成就
export function resetAchievements(): void {
  for (const achievement of ACHIEVEMENTS) {
    achievement.unlocked = false;
    delete achievement.unlockedAt;
  }
}

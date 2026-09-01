// 场景系统配置
export interface Scenery {
  id: string;
  name: string;
  description: string;
  type: 'day' | 'night' | 'rain' | 'snow' | 'sunset' | 'custom';
  backgroundColor: string;
  petFilter: string;
  particleColor: string;
  animationSpeed: number;
  enabled: boolean;
  createdAt: string;
}

// 预设场景
export const PRESET_SCENERIES: Scenery[] = [
  {
    id: 'day',
    name: '阳光明媚',
    description: '晴朗的白天，阳光灿烂',
    type: 'day',
    backgroundColor: 'linear-gradient(135deg, #87CEEB 0%, #E0F7FA 100%)',
    petFilter: 'none',
    particleColor: '#FFD700',
    animationSpeed: 1.0,
    enabled: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'night',
    name: '月光静谧',
    description: '宁静的夜晚，星光闪烁',
    type: 'night',
    backgroundColor: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    petFilter: 'brightness(1.1) contrast(1.1)',
    particleColor: '#C0C0C0',
    animationSpeed: 0.8,
    enabled: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'rain',
    name: '雨天 mood',
    description: '雨天的宁静氛围',
    type: 'rain',
    backgroundColor: 'linear-gradient(135deg, #4A4A5A 0%, #2C3E50 100%)',
    petFilter: 'sepia(0.3) brightness(0.9)',
    particleColor: '#87CEEB',
    animationSpeed: 0.6,
    enabled: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'sunset',
    name: '夕阳余晖',
    description: '温暖的黄昏时光',
    type: 'sunset',
    backgroundColor: 'linear-gradient(135deg, #FF6B6B 0%, #FFD93D 50%, #6BCB77 100%)',
    petFilter: 'contrast(1.2) brightness(1.1)',
    particleColor: '#FFA500',
    animationSpeed: 1.2,
    enabled: true,
    createdAt: new Date().toISOString(),
  },
];

// 当前场景状态
let currentScenery: Scenery = PRESET_SCENERIES[0];

// 场景管理
export interface SceneryManager {
  getCurrent(): Scenery;
  getAvailable(): Scenery[];
  set(sceneryId: string): boolean;
  setType(type: Scenery['type']): boolean;
  getRandom(): Scenery;
}

export const SceneryManager: SceneryManager = {
  getCurrent: () => currentScenery,
  getAvailable: () => PRESET_SCENERIES.filter(s => s.enabled),
  set: (sceneryId) => {
    const scenery = PRESET_SCENERIES.find(s => s.id === sceneryId);
    if (scenery) {
      currentScenery = scenery;
      return true;
    }
    return false;
  },
  setType: (type) => {
    const scenery = PRESET_SCENERIES.find(s => s.type === type && s.enabled);
    if (scenery) {
      currentScenery = scenery;
      return true;
    }
    return false;
  },
  getRandom: () => {
    const available = PRESET_SCENERIES.filter(s => s.enabled);
    return available[Math.floor(Math.random() * available.length)];
  },
};

// 根据场景获取CSS
export function getSceneryCSS(scenery?: Scenery): string {
  const s = scenery || currentScenery;
  return `
    /* 场景背景 */
    .scenery-bg {
      background: ${s.backgroundColor};
      transition: background 1s ease;
    }
    
    /* 场景粒子效果 */
    .scenery-particle {
      color: ${s.particleColor};
    }
    
    /* 场景动画速度 */
    .scenery-animation {
      animation-duration: ${1 / s.animationSpeed}s;
    }
  `;
}

// 检测当前时间并自动切换场景
export function autoSwitchSceneryByTime(): void {
  const hour = new Date().getHours();
  
  if (hour >= 6 && hour < 18) {
    // 白天
    SceneryManager.setType('day');
  } else if (hour >= 18 && hour < 21) {
    // 傍晚
    SceneryManager.setType('sunset');
  } else {
    // 夜晚
    SceneryManager.setType('night');
  }
}

// 场景切换动画CSS
export const SCENERY_ANIMATION_KEYFRAMES = `
  @keyframes particleFloat {
    0% { transform: translateY(0) rotate(0deg); opacity: 1; }
    100% { transform: translateY(-100px) rotate(360deg); opacity: 0; }
  }
  
  @keyframes rainDrop {
    0% { transform: translateY(-10px); opacity: 0; }
    50% { opacity: 1; }
    100% { transform: translateY(600px); opacity: 0; }
  }
  
  @keyframes snowFall {
    0% { transform: translateY(-10px) translateX(0); opacity: 0; }
    50% { opacity: 1; }
    100% { transform: translateY(600px) translateX(50px); opacity: 0; }
  }
  
  .particle {
    position: absolute;
    font-size: 16px;
    pointer-events: none;
    animation: particleFloat 3s ease-out forwards;
  }
  
  .rain {
    position: absolute;
    width: 2px;
    height: 20px;
    background: #87CEEB;
    animation: rainDrop 0.8s linear infinite;
  }
  
  .snow {
    position: absolute;
    font-size: 12px;
    animation: snowFall 4s linear infinite;
  }
`;

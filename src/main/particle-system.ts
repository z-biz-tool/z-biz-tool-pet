// 粒子特效管理
export interface ParticleConfig {
  id: string;
  type: 'heart' | 'star' | 'music' | 'sparkle' | 'bounce' | 'float';
  content: string;
  speed: number;
  opacity: number;
  count: number;
  enabled: boolean;
}

// 粒子类型配置
export const PARTICLE_TYPES: Record<string, ParticleConfig> = {
  heart: {
    id: 'heart',
    type: 'heart',
    content: '💕',
    speed: 1.5,
    opacity: 0.9,
    count: 5,
    enabled: true,
  },
  star: {
    id: 'star',
    type: 'star',
    content: '✨',
    speed: 1.2,
    opacity: 0.8,
    count: 8,
    enabled: true,
  },
  music: {
    id: 'music',
    type: 'music',
    content: '🎵',
    speed: 1.0,
    opacity: 1.0,
    count: 3,
    enabled: true,
  },
  sparkle: {
    id: 'sparkle',
    type: 'sparkle',
    content: '⭐',
    speed: 1.8,
    opacity: 0.7,
    count: 10,
    enabled: true,
  },
  bounce: {
    id: 'bounce',
    type: 'bounce',
    content: '🎈',
    speed: 2.0,
    opacity: 0.85,
    count: 6,
    enabled: true,
  },
  float: {
    id: 'float',
    type: 'float',
    content: '☁️',
    speed: 0.8,
    opacity: 0.6,
    count: 4,
    enabled: true,
  },
};

// 粒子状态
export interface Particle {
  id: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  scale: number;
  opacity: number;
  createdAt: number;
}

// 粒子生成器
export class ParticleGenerator {
  private particles: Particle[] = [];
  private lastSpawnTime: number = 0;
  private spawnInterval: number = 500;

  // 创建新粒子
  create(type: string, x: number, y: number): Particle | null {
    const config = PARTICLE_TYPES[type];
    if (!config || !config.enabled) return null;

    const angle = Math.random() * Math.PI * 2;
    const speed = (Math.random() * 2 + 0.5) * config.speed;

    return {
      id: `particle_${Date.now()}_${Math.random()}`,
      type,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1, // 向上偏移
      rotation: Math.random() * 360,
      scale: Math.random() * 0.5 + 0.8,
      opacity: config.opacity,
      createdAt: Date.now(),
    };
  }

  // 更新粒子
  update(deltaTime: number): void {
    const now = Date.now();
    
    // 生成新粒子
    if (now - this.lastSpawnTime > this.spawnInterval) {
      const config = PARTICLE_TYPES['star'];
      if (config && config.enabled) {
        this.particles.push(this.create('star', 100, 60)!);
        this.lastSpawnTime = now;
      }
    }

    // 更新所有粒子
    this.particles.forEach(p => {
      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;
      p.vy += 0.5 * deltaTime; // 重力
      p.rotation += 2 * deltaTime;
      p.scale -= 0.01 * deltaTime;
      p.opacity -= 0.01 * deltaTime;
    });

    // 移除消失的粒子
    this.particles = this.particles.filter(p => 
      p.opacity > 0 && 
      p.scale > 0 && 
      p.y < 300 // 在窗口内
    );
  }

  // 获取当前粒子
  getParticles(): Particle[] {
    return this.particles;
  }

  // 生成一组爱心
  generateHearts(x: number, y: number, count: number = 3): Particle[] {
    const hearts: Particle[] = [];
    for (let i = 0; i < count; i++) {
      hearts.push({
        id: `heart_${Date.now()}_${i}`,
        type: 'heart',
        x: x + (i - count / 2) * 30,
        y: y,
        vx: (i - count / 2) * 0.5,
        vy: -2 - Math.random(),
        rotation: Math.random() * 40 - 20,
        scale: 1,
        opacity: 1,
        createdAt: Date.now(),
      });
    }
    return hearts;
  }

  // 清空粒子
  clear(): void {
    this.particles = [];
  }
}

// 全局粒子生成器
export const particleGenerator = new ParticleGenerator();

// 粒子渲染CSS
export const PARTICLE_STYLES = `
  .particle {
    position: absolute;
    pointer-events: none;
    transition: all 0.3s ease;
  }

  /* 爱心粒子 */
  .particle.heart {
    animation: floatHeart 2s ease-out forwards;
  }

  @keyframes floatHeart {
    0% {
      transform: translateY(0) rotate(0deg) scale(1);
      opacity: 1;
    }
    100% {
      transform: translateY(-100px) rotate(360deg) scale(0);
      opacity: 0;
    }
  }

  /* 星星粒子 */
  .particle.star {
    animation: floatStar 2.5s ease-out forwards;
  }

  @keyframes floatStar {
    0% {
      transform: translateY(0) scale(1);
      opacity: 1;
    }
    100% {
      transform: translateY(-120px) scale(0);
      opacity: 0;
    }
  }

  /* 音符粒子 */
  .particle.music {
    animation: floatMusic 2s ease-out forwards;
  }

  @keyframes floatMusic {
    0% {
      transform: translateY(0) rotate(0deg);
      opacity: 1;
    }
    100% {
      transform: translateY(-80px) rotate(360deg);
      opacity: 0;
    }
  }
`;

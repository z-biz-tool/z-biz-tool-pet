// ---------- 动画系统 ----------

export type AnimationType =
  | 'idle' | 'float' | 'walk' | 'dance' | 'roll'
  | 'jump' | 'wiggle' | 'stretch' | 'spin' | 'yawn'
  | 'sleep' | 'chase' | 'blink' | 'lookAtCursor'
  | 'bounce' | 'shake' | 'wobble' | 'petted';

export interface AnimationConfig {
  duration: number;
  keyframes: string;   // CSS @keyframes name
  timing: string;      // CSS animation-timing-function
  iteration: number | 'infinite';
  /** 动画结束后是否回到 idle */
  autoReturnToIdle: boolean;
  /** 优先级: 越大越优先 */
  priority: number;
}

// ---------- CSS Keyframes 定义 ----------

export const ANIMATION_KEYFRAMES = `
@keyframes animIdle {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-10px) rotate(2deg); }
}
@keyframes animFloat {
  0%, 100% { transform: translateY(0) scale(1); }
  25% { transform: translateY(-14px) scale(1.02); }
  50% { transform: translateY(-6px) scale(1); }
  75% { transform: translateY(-12px) scale(1.01); }
}
@keyframes animWalk {
  0% { transform: translateX(0) rotate(0deg); }
  15% { transform: translateX(20px) rotate(-3deg); }
  30% { transform: translateX(40px) rotate(0deg); }
  45% { transform: translateX(60px) rotate(3deg); }
  60% { transform: translateX(40px) rotate(0deg); }
  75% { transform: translateX(20px) rotate(-3deg); }
  100% { transform: translateX(0) rotate(0deg); }
}
@keyframes animDance {
  0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
  12.5% { transform: translateY(-12px) rotate(-8deg) scale(1.05); }
  25% { transform: translateY(0) rotate(0deg) scale(1); }
  37.5% { transform: translateY(-12px) rotate(8deg) scale(1.05); }
  50% { transform: translateY(0) rotate(0deg) scale(1); }
  62.5% { transform: translateY(-8px) rotate(-6deg) scale(1.03); }
  75% { transform: translateY(0) rotate(0deg) scale(1); }
  87.5% { transform: translateY(-8px) rotate(6deg) scale(1.03); }
}
@keyframes animRoll {
  0% { transform: translateX(0) rotate(0deg); }
  25% { transform: translateX(30px) rotate(90deg); }
  50% { transform: translateX(0) rotate(180deg); }
  75% { transform: translateX(-30px) rotate(270deg); }
  100% { transform: translateX(0) rotate(360deg); }
}
@keyframes animJump {
  0% { transform: translateY(0) scaleY(1) scaleX(1); }
  10% { transform: translateY(4px) scaleY(0.85) scaleX(1.1); }
  35% { transform: translateY(-40px) scaleY(1.1) scaleX(0.95); }
  55% { transform: translateY(-40px) scaleY(1.05) scaleX(0.98); }
  80% { transform: translateY(0) scaleY(0.9) scaleX(1.05); }
  90% { transform: translateY(-4px) scaleY(1.05) scaleX(0.98); }
  100% { transform: translateY(0) scaleY(1) scaleX(1); }
}
@keyframes animWiggle {
  0%, 100% { transform: rotate(0deg); }
  10% { transform: rotate(-12deg); }
  20% { transform: rotate(12deg); }
  30% { transform: rotate(-10deg); }
  40% { transform: rotate(10deg); }
  50% { transform: rotate(-8deg); }
  60% { transform: rotate(8deg); }
  70% { transform: rotate(-4deg); }
  80% { transform: rotate(4deg); }
  90% { transform: rotate(-2deg); }
}
@keyframes animStretch {
  0%, 100% { transform: scaleY(1) scaleX(1); }
  20% { transform: scaleY(0.8) scaleX(1.2); }
  40% { transform: scaleY(1.15) scaleX(0.9); }
  60% { transform: scaleY(0.95) scaleX(1.05); }
  80% { transform: scaleY(1.05) scaleX(0.98); }
}
@keyframes animSpin {
  0% { transform: rotate(0deg) scale(1); }
  50% { transform: rotate(180deg) scale(0.9); }
  100% { transform: rotate(360deg) scale(1); }
}
@keyframes animYawn {
  0%, 100% { transform: scale(1); }
  15% { transform: scale(1.05) rotate(-2deg); }
  30% { transform: scale(1.1) rotate(0deg); }
  50% { transform: scale(1.08) rotate(2deg); }
  70% { transform: scale(1.02) rotate(0deg); }
}
@keyframes animSleep {
  0%, 100% { transform: translateY(0) rotate(-3deg) scale(1); }
  50% { transform: translateY(2px) rotate(-3deg) scale(0.98); }
}
@keyframes animBlink {
  0%, 40%, 100% { transform: scaleY(1); }
  45%, 55% { transform: scaleY(0.1); }
}
@keyframes animBounce {
  0%, 100% { transform: translateY(0) scale(1); }
  30% { transform: translateY(-20px) scale(1.05); }
  50% { transform: translateY(0) scale(0.95); }
  65% { transform: translateY(-10px) scale(1.02); }
  80% { transform: translateY(0) scale(0.98); }
}
@keyframes animShake {
  0%, 100% { transform: translateX(0) scale(1); }
  10% { transform: translateX(-6px) scale(1.02); }
  20% { transform: translateX(6px) scale(1.02); }
  30% { transform: translateX(-5px) scale(1.01); }
  40% { transform: translateX(5px) scale(1.01); }
  50% { transform: translateX(-3px) scale(1); }
  60% { transform: translateX(3px) scale(1); }
  70% { transform: translateX(-2px); }
  80% { transform: translateX(2px); }
}
@keyframes animWobble {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-5deg); }
  75% { transform: rotate(5deg); }
}
@keyframes animPetted {
  0% { transform: scale(1) rotate(0deg); }
  15% { transform: scale(1.12) rotate(-4deg); }
  30% { transform: scale(1.08) rotate(4deg); }
  45% { transform: scale(1.1) rotate(-2deg); }
  60% { transform: scale(1.06) rotate(2deg); }
  75% { transform: scale(1.04) rotate(-1deg); }
  100% { transform: scale(1) rotate(0deg); }
}
@keyframes animHeartFloat {
  0% { opacity: 1; transform: translateY(0) scale(0.5); }
  50% { opacity: 0.8; transform: translateY(-30px) scale(1); }
  100% { opacity: 0; transform: translateY(-60px) scale(0.8); }
}
@keyframes animZzz {
  0% { opacity: 0; transform: translate(0, 0) scale(0.5); }
  30% { opacity: 1; transform: translate(5px, -15px) scale(1); }
  100% { opacity: 0; transform: translate(10px, -40px) scale(0.6); }
}
`;

// ---------- 动画配置表 ----------

export const ANIMATIONS: Record<AnimationType, AnimationConfig> = {
  idle: {
    duration: 3000,
    keyframes: 'animIdle',
    timing: 'ease-in-out',
    iteration: 'infinite',
    autoReturnToIdle: false,
    priority: 0,
  },
  float: {
    duration: 4000,
    keyframes: 'animFloat',
    timing: 'ease-in-out',
    iteration: 'infinite',
    autoReturnToIdle: false,
    priority: 1,
  },
  walk: {
    duration: 2000,
    keyframes: 'animWalk',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  dance: {
    duration: 2000,
    keyframes: 'animDance',
    timing: 'ease-in-out',
    iteration: 2,
    autoReturnToIdle: true,
    priority: 2,
  },
  roll: {
    duration: 1200,
    keyframes: 'animRoll',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  jump: {
    duration: 800,
    keyframes: 'animJump',
    timing: 'cubic-bezier(0.33, 1, 0.68, 1)',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 3,
  },
  wiggle: {
    duration: 1000,
    keyframes: 'animWiggle',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  stretch: {
    duration: 1500,
    keyframes: 'animStretch',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  spin: {
    duration: 800,
    keyframes: 'animSpin',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  yawn: {
    duration: 2000,
    keyframes: 'animYawn',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  sleep: {
    duration: 3000,
    keyframes: 'animSleep',
    timing: 'ease-in-out',
    iteration: 'infinite',
    autoReturnToIdle: false,
    priority: 1,
  },
  chase: {
    duration: 2000,
    keyframes: 'animWalk',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 3,
  },
  blink: {
    duration: 300,
    keyframes: 'animBlink',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 5, // 眨眼可以叠加，高优先级但不打断
  },
  lookAtCursor: {
    duration: 200,
    keyframes: 'animIdle',
    timing: 'ease-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 1,
  },
  bounce: {
    duration: 1000,
    keyframes: 'animBounce',
    timing: 'ease-in-out',
    iteration: 2,
    autoReturnToIdle: true,
    priority: 2,
  },
  shake: {
    duration: 800,
    keyframes: 'animShake',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 3,
  },
  wobble: {
    duration: 1500,
    keyframes: 'animWobble',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 2,
  },
  petted: {
    duration: 1200,
    keyframes: 'animPetted',
    timing: 'ease-in-out',
    iteration: 1,
    autoReturnToIdle: true,
    priority: 4,
  },
};

// ---------- 空闲动画调度 ----------

/** 空闲时随机触发的动画列表（不含 idle/float/sleep/blink/lookAtCursor/chase） */
const IDLE_ANIMATIONS: AnimationType[] = [
  'walk', 'dance', 'roll', 'jump', 'wiggle',
  'stretch', 'spin', 'yawn', 'bounce', 'wobble',
];

/** 获取一个随机空闲动画 */
export function getRandomIdleAnimation(): AnimationType {
  return IDLE_ANIMATIONS[Math.floor(Math.random() * IDLE_ANIMATIONS.length)];
}

/** 获取随机空闲间隔（10-30秒） */
export function getRandomIdleInterval(): number {
  return 10000 + Math.random() * 20000;
}

/** 获取随机眨眼间隔（3-8秒） */
export function getRandomBlinkInterval(): number {
  return 3000 + Math.random() * 5000;
}

// ---------- 动画优先级判断 ----------

export type AnimationSource = 'user' | 'status' | 'idle';

/** 判断新动画是否可以打断当前动画 */
export function canInterruptAnimation(
  currentAnim: AnimationType | null,
  newAnim: AnimationType,
  source: AnimationSource
): boolean {
  if (!currentAnim) return true;

  const currentConfig = ANIMATIONS[currentAnim];
  const newConfig = ANIMATIONS[newAnim];

  // 用户交互始终可以打断
  if (source === 'user') return true;

  // 状态动画可以打断空闲动画
  if (source === 'status' && currentConfig.priority <= 1) return true;

  // 空闲动画不能打断任何正在播放的动画
  if (source === 'idle') return false;

  // 同优先级不可打断
  return newConfig.priority > currentConfig.priority;
}

// ---------- 动画CSS生成 ----------

/** 生成动画的CSS style字符串 */
export function getAnimationCSS(animType: AnimationType): string {
  const config = ANIMATIONS[animType];
  const iter = config.iteration === 'infinite' ? 'infinite' : String(config.iteration);
  return `${config.keyframes} ${config.duration}ms ${config.timing} ${iter}`;
}

// ---------- 右键菜单动画列表 ----------

export const ANIMATION_MENU_ITEMS: { label: string; value: AnimationType }[] = [
  { label: '🚶 散步', value: 'walk' },
  { label: '💃 跳舞', value: 'dance' },
  { label: '🔄 翻滚', value: 'roll' },
  { label: '⬆️ 跳跃', value: 'jump' },
  { label: '🫨 扭动', value: 'wiggle' },
  { label: '🤸 伸展', value: 'stretch' },
  { label: '🌀 旋转', value: 'spin' },
  { label: '🥱 打哈欠', value: 'yawn' },
  { label: '😴 睡觉', value: 'sleep' },
  { label: '🏀 弹跳', value: 'bounce' },
  { label: '🫨 抖动', value: 'shake' },
  { label: '🌊 摇摆', value: 'wobble' },
  { label: '🐾 追鼠标', value: 'chase' },
];

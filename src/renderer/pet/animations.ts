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
/* 立绘版的待机：以前 120px 的圆猫飘 10px 刚合适，436px 的人像飘 10px
   会像在坐电梯；改成 5px + 0.6 度，靠 .char-breathe 的呼吸补足「活着」的感觉 */
@keyframes animIdle {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-5px) rotate(0.6deg); }
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
    duration: 4200,
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

/**
 * 空闲动画按养成数值加权，而不是均匀随机。
 *
 * 均匀随机的问题是「她精神抖擞和她快累瘫了，做同一批动作、同样频繁」——
 * 数值就只是 HUD 上的六根条子，跟行为没有任何关系，这也是「没灵魂」最直接的来源。
 * 现在每个动作声明它**想要的角色状态**，抽样时按「当前状态离这个状态有多远」打折：
 * 差得越远，被选中的概率越低（四次方衰减，保证差距大时几乎不出现）。
 *
 * 这套做法照的是 Shimeji / DyberPet 的「期望状态 − 当前状态」加权模型，
 * 但简化成六维直接映射，不额外引入一套 FSM。
 */
interface IdleAnimationProfile {
  anim: AnimationType;
  /** 权重基数：即使完全匹配，也有些动作天生更常见（散步 > 旋转） */
  base: number;
  /** 这个动作期望的精力值（0-100） */
  wantEnergy: number;
  /** 期望的心情值（0-100） */
  wantHappiness: number;
  /** 期望的饱食值。饿着肚子还活蹦乱跳会很违和 */
  wantHunger?: number;
}

/**
 * 精力期望定得松一些（容忍 20 分差距仍有一半概率），心情定得紧（15 分就砍半）——
 * 心情是她「想不想动」的主变量，精力更多是「动得动不了」的物理限制。
 *
 * wantHunger 只给**耗能的动作**（跳舞/翻滚/跳跃/旋转/弹跳）：饿着肚子还
 * 活蹦乱跳很违和，所以饥饿会把概率推向散步、伸懒腰这类省力动作，而不是
 * 让她僵住不动。省力动作不写 wantHunger —— 饿的时候做它们是正常的。
 */
const IDLE_PROFILES: IdleAnimationProfile[] = [
  { anim: 'walk',    base: 14, wantEnergy: 62, wantHappiness: 58 },
  { anim: 'dance',   base: 9,  wantEnergy: 78, wantHappiness: 85, wantHunger: 70 },
  { anim: 'roll',    base: 6,  wantEnergy: 82, wantHappiness: 72, wantHunger: 70 },
  { anim: 'jump',    base: 8,  wantEnergy: 88, wantHappiness: 70, wantHunger: 75 },
  { anim: 'wiggle',  base: 10, wantEnergy: 45, wantHappiness: 40 },
  { anim: 'stretch', base: 12, wantEnergy: 35, wantHappiness: 50 },
  { anim: 'spin',    base: 5,  wantEnergy: 85, wantHappiness: 80, wantHunger: 75 },
  { anim: 'yawn',    base: 9,  wantEnergy: 15, wantHappiness: 45 },
  { anim: 'bounce',  base: 7,  wantEnergy: 70, wantHappiness: 75, wantHunger: 70 },
  { anim: 'wobble',  base: 6,  wantEnergy: 30, wantHappiness: 35 },
];

/** 距离 → 折扣系数。σ 分别是精力/心情的容忍宽度 */
function decay(dist: number, sigma: number): number {
  const d = Math.abs(dist) / sigma;
  return Math.pow(0.25, d * d); // 高斯形状，但用 0.25 作底让衰减更陡
}

export interface IdleMood {
  energy: number;
  happiness: number;
  hunger: number;
}

/** 被抽出的空闲动画，附带「为什么是它」—— 便于测试与日志 */
export interface WeightedPick {
  anim: AnimationType;
  /** 未归一化的权重（用于测试断言趋势） */
  weight: number;
}

/** 六维数值 + 随机源 ⇒ 一个空闲动作。rng 可注入，测试才能确定性断言 */
export function pickIdleAnimation(
  mood: Partial<IdleMood> = {},
  rng: () => number = Math.random
): WeightedPick {
  const energy = clampStat(mood.energy, 60);
  const happiness = clampStat(mood.happiness, 60);
  const hunger = clampStat(mood.hunger, 60);

  const scored = IDLE_PROFILES.map((p) => {
    let w = p.base;
    w *= decay(p.wantEnergy - energy, 20);
    w *= decay(p.wantHappiness - happiness, 15);
    if (p.wantHunger !== undefined) w *= decay(p.wantHunger - hunger, 25);
    return { anim: p.anim, weight: Math.max(w, 0.001) };
  });

  const total = scored.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const item of scored) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return scored[scored.length - 1];
}

function clampStat(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(0, v));
}

/** 兼容旧调用点：无参时按「状态良好」的默认值抽一个 */
export function getRandomIdleAnimation(): AnimationType {
  return pickIdleAnimation().anim;
}

/**
 * 获取随机空闲间隔。精力越低，间隔越长（累的时候不想动）。
 * 基础 10-30 秒，精力满时接近下界，精力见底时接近上界的 1.8 倍。
 */
export function getRandomIdleInterval(mood: Partial<IdleMood> = {}): number {
  const energy = clampStat(mood.energy, 60);
  const base = 10000 + Math.random() * 20000;
  // energy 100 → ×1.0，energy 0 → ×1.8
  const slack = 1 + (1 - energy / 100) * 0.8;
  return Math.round(base * slack);
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

// ---------- 摸头爱心布局 ----------

// 舞台几何：与 pet.css 的 .char-stage（238×399, left:15, 贴底）和
// tauri.conf.json 的 pet 窗口（268×512）保持一致。爱心渲染在 .char-breathe
// 内即舞台坐标系，窗口 clientX/Y 要先减掉这两个偏移才能落位。
export const STAGE_WIDTH = 238;
export const STAGE_HEIGHT = 399;
export const STAGE_OFFSET_X = 15;
/** 512 - 399：舞台贴底，顶部留给气泡 */
export const STAGE_OFFSET_Y = 113;

export interface HeartSpot {
  /** 舞台坐标：爱心元素直接用 left/top 落位 */
  x: number;
  y: number;
  /** 错峰出场：每颗比前一颗晚 60ms，同一帧全弹出来像贴纸 */
  delayMs: number;
}

/**
 * 摸头爱心的落点：从被摸的位置扇形散开。
 *
 * clickX/clickY 是舞台坐标（窗口 clientX/Y 减 STAGE_OFFSET_*）。rng 可注入 ——
 * 布局是纯函数，能在 node --test 里断言「不越界、扇形对称、错峰递增」。
 * 上下界留边：横向 10px 免得 emoji 被裁，纵向不许低于舞台底部上方 60px
 * （爱心往上飘，落在脚边会直接飘出舞台）。
 */
export function heartSpots(
  clickX: number,
  clickY: number,
  count: number,
  rng: () => number = Math.random
): HeartSpot[] {
  const n = Math.min(8, Math.max(1, Math.floor(count)));
  const spots: HeartSpot[] = [];
  for (let i = 0; i < n; i++) {
    // 扇形：第 i 颗横向偏移 (i - 居中) * 18px，再加 ±6px 抖动让排列不呆板
    const spread = (i - (n - 1) / 2) * 18;
    const dx = spread + (rng() * 2 - 1) * 6;
    const dy = (rng() * 2 - 1) * 8;
    spots.push({
      x: Math.min(STAGE_WIDTH - 10, Math.max(10, clickX + dx)),
      y: Math.min(STAGE_HEIGHT - 60, Math.max(20, clickY + dy)),
      delayMs: i * 60,
    });
  }
  return spots;
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

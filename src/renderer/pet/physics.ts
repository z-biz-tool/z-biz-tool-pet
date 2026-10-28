// ---------- 抛掷物理 ----------
//
// 桌宠界的「灵魂」一半在这一个文件里：被拎起来甩出去之后，她要真的落下去、
// 在屏幕底弹两下、贴着边滑一小段才停 —— 而不是像原来那样「松手瞬间贴边」。
//
// 三条设计约束：
// 1. 纯函数、不碰窗口也不碰 DOM。所有位置更新由调用方（App.tsx）逐帧搬给
//    `window_move_pet`，物理本身只回答「下一帧该在哪、发生了什么碰撞」。
//    这样它能被 node --test 直接覆盖，不需要 WebView。
// 2. 用「秒」而不是「帧」做时间单位。刷新率 60/120/144Hz 下行为必须一致，
//    所有积分都乘 dt；调用方负责把 dt 钳在 [0, 8ms] 之内，避免切后台回来
//    那一帧的巨量 dt 把窗口一次性甩出工作区。
// 3. 碰撞目标是**工作区**（work area），不是显示器（monitor）—— 任务栏/Dock
//    占掉的部分不能算可站立的地面，否则她会站在任务栏里。

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhysicsConfig {
  /** 重力，px/s²。2400 约等于「从任务栏高度掉下来用 0.4 秒」 */
  gravity: number;
  /** 空气阻力：每秒速度保留的比例（0.995 = 每秒衰减 0.5%） */
  airDrag: number;
  /** 落地后的水平摩擦：每秒速度保留的比例，越小滑得越短 */
  groundFriction: number;
  /** 反弹系数 0..1，落地后竖直速度按这个比例反向 */
  restitution: number;
  /** 反弹次数上限，超过之后直接贴地停住，不再弹 */
  maxBounces: number;
  /** 竖直速度低于这个值（px/s）就视为「已经站稳」，不再积分 */
  settleSpeed: number;
  /** 速度上限：甩得太快会一帧飞出屏幕，钳住手感也钳住风险 */
  maxSpeed: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 2400,
  airDrag: 0.995,
  groundFriction: 0.12,
  restitution: 0.42,
  maxBounces: 3,
  settleSpeed: 130,
  maxSpeed: 4200,
};

/** 抛掷体：位置是窗口左上角（与 outer_position 同一坐标系） */
export interface ThrowBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 已经反弹过几次 */
  bounces: number;
  /** 已经接触地面（不再受重力，只做水平滑行） */
  grounded: boolean;
  /** 完全静止：调用方应当收掉这一轮物理 */
  settled: boolean;
}

export type PhysicsEventKind = 'land' | 'wall' | 'ceiling';

export interface PhysicsEvent {
  kind: PhysicsEventKind;
  /** 碰撞前的速度大小，用来给落地音效定音量、给抖动定强度 */
  speed: number;
}

export interface StepResult {
  body: ThrowBody;
  events: PhysicsEvent[];
}

/**
 * 用当前位置 + 释放速度造一个飞行体。
 *
 * 速度故意拆成 vx/vy 两个标量，而不是收一个 Vec：位置和速度都是 (x,y)，
 * 嵌套传参时把「速度的 y」错写成位置的第二参，得到的是 vy=undefined ——
 * 这个坑我自己踩过一次，标量签名让它变成类型错误而不是静默的 NaN。
 */
export function makeThrowBody(x: number, y: number, vx: number, vy: number): ThrowBody {
  return { x, y, vx, vy, bounces: 0, grounded: false, settled: false };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 工作区里窗口左上角能到达的矩形范围（区域比窗口还小时退化成一个点） */
export function windowRange(
  area: Rect,
  size: { width: number; height: number }
): { minX: number; minY: number; maxX: number; maxY: number } {
  const rawMaxX = area.x + Math.max(0, area.width - size.width);
  const rawMaxY = area.y + Math.max(0, area.height - size.height);
  return {
    minX: Math.min(area.x, rawMaxX),
    maxX: Math.max(area.x, rawMaxX),
    minY: Math.min(area.y, rawMaxY),
    maxY: Math.max(area.y, rawMaxY),
  };
}

/**
 * 推进一帧。
 *
 * @param body   当前状态
 * @param dt     本帧间隔（秒）
 * @param area   可活动区域（工作区矩形）
 * @param size   窗口自身尺寸（宽高，不含位置）
 * @param cfg    物理参数
 */
export function stepPhysics(
  body: ThrowBody,
  dt: number,
  area: Rect,
  size: { width: number; height: number },
  cfg: PhysicsConfig = DEFAULT_PHYSICS
): StepResult {
  const events: PhysicsEvent[] = [];
  if (body.settled) return { body, events };

  // dt 钳制在 8ms 以内：切后台再回来的第一帧可能有几百毫秒，
  // 直接积分会一帧就把窗口推进工作区外面（clamp 只能救一半）。
  const t = clamp(dt, 0.0005, 0.008);
  const { minX, minY, maxX, maxY } = windowRange(area, size);

  const next: ThrowBody = { ...body };

  if (body.grounded) {
    // 落地后不再受重力：只把水平速度按摩擦衰减，让她滑一小段再停。
    // 这一段是「手感」的来源 —— 直接停住会像撞墙，滑一下才像站在地上。
    next.vx *= Math.pow(cfg.groundFriction, t * 60);
    next.vy = 0;
    next.y = maxY;
    if (Math.abs(next.vx) < 12) {
      next.vx = 0;
      next.settled = true;
    }
  } else {
    // 空气阻力按秒折算，以 60fps 为基准做逐帧折算，手感才跟帧率无关
    const drag = Math.pow(cfg.airDrag, t * 60);
    next.vx = clamp(next.vx * drag, -cfg.maxSpeed, cfg.maxSpeed);
    next.vy = clamp((next.vy + cfg.gravity * t) * drag, -cfg.maxSpeed, cfg.maxSpeed);
  }

  next.x += next.vx * t;
  if (!next.grounded) next.y += next.vy * t;

  // ---- 天花板 ----
  if (!next.grounded && next.y <= minY) {
    const impact = Math.abs(next.vy);
    events.push({ kind: 'ceiling', speed: impact });
    next.y = minY;
    next.vy = impact * cfg.restitution;
  }

  // ---- 左右墙 ----
  if (next.x <= minX) {
    const impact = Math.abs(next.vx);
    if (impact > 1) events.push({ kind: 'wall', speed: impact });
    next.x = minX;
    next.vx = impact * cfg.restitution;
  } else if (next.x >= maxX) {
    const impact = Math.abs(next.vx);
    if (impact > 1) events.push({ kind: 'wall', speed: impact });
    next.x = maxX;
    next.vx = -impact * cfg.restitution;
  }

  // ---- 地面 ----
  if (!next.grounded && next.y >= maxY) {
    const impact = Math.abs(next.vy);
    events.push({ kind: 'land', speed: impact });
    next.y = maxY;
    if (impact < cfg.settleSpeed || next.bounces >= cfg.maxBounces) {
      // 弹够了 / 慢到站得住：转入贴地滑行，不再弹
      next.grounded = true;
      next.vy = 0;
    } else {
      next.vy = -impact * cfg.restitution;
      next.bounces += 1;
    }
  }

  return { body: next, events };
}

// ---------- 释放速度估算 ----------

/** 拖拽时的指针采样点（screenX/screenY + performance.now()） */
export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

/** 只看最近这么久的采样：更早的采样反映的是「上一段拖拽」，不是释放瞬间的手速 */
export const RELEASE_WINDOW_MS = 130;

/**
 * 从指针采样里估出松手瞬间的速度（px/s）。
 *
 * 不是简单取最后一个差分 —— 指针采样抖动很大，单帧差分会算出 3000px/s 的假速度，
 * 结果是轻轻一放她就飞了。这里对窗口内的所有采样做加权平均，**越近的权重越大**，
 * 既抗抖动又保留「甩出去」的手感。
 *
 * 样本不足两个时返回 0（= 不抛掷，走原来的贴边逻辑）。
 */
export function estimateReleaseVelocity(
  samples: PointerSample[],
  maxSpeed: number = DEFAULT_PHYSICS.maxSpeed
): Vec {
  if (samples.length < 2) return { x: 0, y: 0 };

  const newest = samples[samples.length - 1];
  // 保留窗口内的采样，**按时间正序**排列：下面的差分要按 a=较早、b=较晚算，
  // 顺序反了会得到负速度（表现为「甩得越用力，她越往反方向飞」）。
  const recent: PointerSample[] = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (newest.t - samples[i].t > RELEASE_WINDOW_MS) break;
    recent.unshift(samples[i]);
  }
  if (recent.length < 2) return { x: 0, y: 0 };

  // 起点 = 窗口内最旧的那个采样
  const oldest = recent[0];
  const spanMs = newest.t - oldest.t;
  if (spanMs <= 0) return { x: 0, y: 0 };

  // 加权位移：最近的差分权重最高（index 越大越新）
  let wSum = 0;
  let dxSum = 0;
  let dySum = 0;
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1];
    const b = recent[i];
    const w = i; // 线性加权即可，指数加权会让最后一次抖动占绝对主导
    dxSum += (b.x - a.x) * w;
    dySum += (b.y - a.y) * w;
    wSum += w;
  }
  if (wSum <= 0) return { x: 0, y: 0 };

  // 加权位移折算成速度。
  // dxSum/wSum 是「加权平均每段位移」，一段的时长是 spanMs/(段数)，
  // 所以要乘 (段数-1) 才是 px/s —— 漏了这个因子会把速度算小 n-1 倍
  // （表现为甩得很用力却只是轻轻挪一下）。
  const segments = recent.length - 1;
  const scale = (segments * 1000) / (spanMs * wSum);
  const vx = dxSum * scale;
  const vy = dySum * scale;
  return {
    x: clamp(vx, -maxSpeed, maxSpeed),
    y: clamp(vy, -maxSpeed, maxSpeed),
  };
}

/**
 * 速度够不够触发抛掷。
 *
 * 阈值取 380px/s：低于这个值的「移动」其实是把窗口挪一下就停，
 * 直接贴边更符合直觉；高于它才读得出「甩」的意图。
 */
export const THROW_THRESHOLD = 380;

export function shouldThrow(v: Vec, threshold: number = THROW_THRESHOLD): boolean {
  return Math.hypot(v.x, v.y) >= threshold;
}

// 自主行为导演：她「不被打扰时自己在做什么」。
//
// 陪伴引擎（engine.ts）管的是**规则**——饿了几分钟说一句、坐久了提醒起身，
// 台词从常量池里取。它能保证"不冷场"，但保证不了"活着"：同一个场景永远同一句，
// 看两天就腻。
//
// 这一层管的是**念头**：每隔一两分钟问一次后端「你现在想干嘛」，
// 后端跑两轮模型（先想 3 个念头，再自评挑一个）并给出可播放的动作脚本，
// 这里负责按脚本演——走过去、探头、说半句、缩回去。
//
// 三条硬约束：
// 1. **绝不打断**。只在她 idle 且不在专注模式时开演；演到一半用户点她，立刻停。
// 2. **绝不等待**。模型在局域网，慢起来几十秒。请求发出去就忘掉它，
//    结果什么时候回来什么时候演 —— 她发呆想事情本来就该是慢的。
// 3. **失败即静默**。模型不可用是常态（机器没开、显存被占），这时她只是
//    "比平时安静一点"，不能弹任何错误，也不能让气泡显示「心智模型不可用」。

import type { AnimationType } from '../animations';
import type { Emotion } from '../../shared/emotions';

export interface BeatCue {
  anim: string;
  /** 这一步持续多少毫秒 */
  dur: number;
  line: string;
}

export interface Beat {
  thought: string;
  line: string;
  emotion: string;
  script: BeatCue[];
  importance: number;
}

export interface AutonomyConfig {
  enabled: boolean;
  /** 两次自主活动之间的基准间隔（秒） */
  intervalSec: number;
}

export const DEFAULT_AUTONOMY: AutonomyConfig = { enabled: true, intervalSec: 120 };

const CFG_KEY = 'pet_autonomy_cfg';
/** 启动后第一次开演要等多久：入场动画还没跑完就动起来会显得很急 */
const FIRST_DELAY_MS = 35_000;
/** 状态不是 idle 时的重试间隔 */
const BUSY_RETRY_MS = 12_000;
/** 失败退避上限倍数 */
const MAX_BACKOFF = 4;

const ANIMS: AnimationType[] = [
  'idle', 'float', 'walk', 'dance', 'roll', 'jump', 'wiggle', 'stretch', 'spin', 'yawn',
  'sleep', 'chase', 'blink', 'bounce', 'shake', 'wobble',
];

const EMOTIONS: Emotion[] = [
  'happy', 'sad', 'angry', 'surprised', 'tsundere', 'cute', 'shy', 'sleepy', 'scared',
  'whispering', 'confused', 'dominant', 'loving', 'thinking', 'excited', 'proud', 'playful',
  'comforting', 'neutral',
];

export type SayCue = { anim?: AnimationType; emotion?: Emotion; ms?: number };

export interface AutonomyDeps {
  /** 说一句 + 配表情动作。空字符串表示只做动作不出声。 */
  say: (text: string, cue: SayCue) => void;
  getStatus: () => string;
  /** 把她此刻的处境交给后端：idleMinutes/mode/focusToday/affection/energy */
  getState: () => Record<string, unknown>;
  log?: (msg: string) => void;
  /** 注入点：默认走 window.electronAPI.mindBeat */
  request?: (state: Record<string, unknown>) => Promise<MindResponse>;
  now?: () => number;
}

export interface MindResponse {
  ok: boolean;
  beat?: Beat;
  error?: string;
}

// ---------- 纯函数部分（可单测） ----------

export function readConfig(): AutonomyConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return { ...DEFAULT_AUTONOMY };
    return { ...DEFAULT_AUTONOMY, ...(JSON.parse(raw) as Partial<AutonomyConfig>) };
  } catch {
    return { ...DEFAULT_AUTONOMY };
  }
}

export function writeConfig(cfg: AutonomyConfig): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* 配额满/隐私模式：降级为「不记忆设置」，不影响运行 */
  }
}

/**
 * 下一次开演的间隔。基准 ±35% 抖动，失败按 2 的幂退避到 4 倍。
 * 抖动是必须的：固定 120 秒会让她像闹钟，谁也不会觉得闹钟活着。
 */
export function nextDelayMs(intervalSec: number, backoff = 0, rand = Math.random): number {
  const base = Math.max(30, intervalSec) * 1000;
  const jitter = 0.65 + rand() * 0.7;
  const factor = Math.min(MAX_BACKOFF, Math.pow(2, backoff));
  return Math.round(base * jitter * factor);
}

/** 能不能开演：只在 idle 且不在专注模式时。 */
export function canPerform(status: string, mode: string): boolean {
  return status === 'idle' && mode !== 'focus';
}

/**
 * 把后端给的 beat 清洗成能安全播放的形状。
 *
 * 后端已经过滤过一次动作白名单，这里再过滤一次不是重复劳动：
 * 渲染层的动画 key 是编译期常量，一个拼错的动作会让 triggerAnimation
 * 拿到 undefined 然后什么都不发生 —— 那种"点了没反应"最难排查。
 */
export function sanitizeBeat(raw: unknown): Beat | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<Beat>;
  const script: BeatCue[] = [];

  for (const step of Array.isArray(b.script) ? b.script : []) {
    if (!step || typeof step !== 'object') continue;
    const anim = String((step as BeatCue).anim || '');
    if (!ANIMS.includes(anim as AnimationType)) continue;
    const dur = Number((step as BeatCue).dur);
    const line = typeof (step as BeatCue).line === 'string' ? (step as BeatCue).line : '';
    script.push({
      anim,
      dur: Math.min(6000, Math.max(800, Number.isFinite(dur) ? dur : 1600)),
      line: line.slice(0, 40),
    });
    if (script.length >= 4) break;
  }

  if (script.length === 0) return null;

  const emotion = String(b.emotion || '');
  return {
    thought: String(b.thought || '').slice(0, 80),
    line: String(b.line || '').slice(0, 40),
    emotion: EMOTIONS.includes(emotion as Emotion) ? emotion : 'happy',
    script,
    importance: Number.isFinite(b.importance) ? Number(b.importance) : 30,
  };
}

// ---------- 调度器 ----------

export class AutonomyDirector {
  private deps: AutonomyDeps;
  private now: () => number;
  private cfg: AutonomyConfig;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private inFlight = false;
  private backoff = 0;
  /** 正在演第几步，用于中途被打断时准确停住 */
  private performing = false;
  /** 上一次开演的时刻，避免"上一次演了 20 秒，紧接着又来一次" */
  private lastBeatAt = 0;
  /** 用户插手的信号：perform 每一步都检查它 */
  private interrupted = false;

  constructor(deps: AutonomyDeps, cfg?: AutonomyConfig) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.cfg = cfg ?? readConfig();
  }

  getConfig(): AutonomyConfig {
    return { ...this.cfg };
  }

  updateConfig(patch: Partial<AutonomyConfig>): AutonomyConfig {
    this.cfg = { ...this.cfg, ...patch };
    writeConfig(this.cfg);
    if (this.cfg.enabled) {
      this.reschedule(FIRST_DELAY_MS);
    } else {
      this.clearTimer();
      this.log('自主行为已关闭');
    }
    return this.getConfig();
  }

  start(): void {
    if (this.disposed || !this.cfg.enabled) return;
    this.reschedule(FIRST_DELAY_MS);
  }

  stop(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** 暂停一段（比如菜单打开时）：不取消，只是把下一次往后推 */
  postpone(ms = 30_000): void {
    if (this.disposed || !this.cfg.enabled) return;
    this.reschedule(ms);
  }

  /**
   * 打断正在演的脚本。用户一来（点她、开菜单、说话），她必须立刻让位 ——
   * 否则脚本的第 2、3 步会在 1.8 秒后把她刚回的那句话顶掉，
   * 看起来就像"她根本不理你"。
   */
  interrupt(): void {
    this.interrupted = true;
    this.reschedule(nextDelayMs(this.cfg.intervalSec, 0));
  }

  // ---- 内部 ----

  private log(msg: string): void {
    this.deps.log?.(`[Pet] ${msg}`);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private reschedule(ms: number): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.cfg.enabled) return;

    const state = this.deps.getState();
    const mode = String(state.mode ?? 'normal');
    if (!canPerform(this.deps.getStatus(), mode)) {
      // 正在说话/录音/思考，或者她在专注模式里：别打扰，过一会儿再看
      this.reschedule(BUSY_RETRY_MS);
      return;
    }
    if (this.inFlight) {
      this.reschedule(BUSY_RETRY_MS);
      return;
    }

    this.inFlight = true;
    const startedAt = this.now();
    let res: MindResponse;
    try {
      res = await this.request(state);
    } catch (error) {
      res = { ok: false, error: String(error) };
    } finally {
      this.inFlight = false;
    }

    if (this.disposed) return;

    const beat = res.ok ? sanitizeBeat(res.beat) : null;
    if (!beat) {
      // 模型不可用是常态：静默退避，隔一会儿再试
      this.backoff = Math.min(this.backoff + 1, 3);
      this.log(`她这次没想出什么（${res.error ?? '空回应'}），${Math.round(nextDelayMs(this.cfg.intervalSec, this.backoff) / 1000)}s 后再看`);
      this.reschedule(nextDelayMs(this.cfg.intervalSec, this.backoff));
      return;
    }

    this.backoff = 0;
    this.lastBeatAt = this.now();
    this.log(`她想到了：${beat.thought || beat.line}（${beat.script.length} 步，耗时 ${this.now() - startedAt}ms）`);
    await this.perform(beat);

    // 演完之后按完整间隔再排下一次，不然"演得久"会挤掉"歇得久"
    this.reschedule(nextDelayMs(this.cfg.intervalSec, 0));
  }

  private async perform(beat: Beat): Promise<void> {
    this.performing = true;
    this.interrupted = false;
    try {
      for (const step of beat.script) {
        if (this.disposed || this.interrupted) return;
        // 演到一半用户来搭话：立刻停，把位置让给真正的对话
        if (this.deps.getStatus() !== 'idle') return;

        // 只有第一步用整段 thoughts 的台词；后面每一步按 cue 自己带的话说，
        // 否则会出现"走了两步说了三遍同一句话"
        const text = step.line || '';
        const cue: SayCue = {
          anim: step.anim as AnimationType,
          emotion: beat.emotion as Emotion,
          ms: step.dur,
        };
        if (text) {
          this.deps.say(text, cue);
        } else {
          // 不说话也要把动作放出去
          this.deps.say('', cue);
        }
        await this.sleep(step.dur + 120);
      }
    } finally {
      this.performing = false;
    }
  }

  /** beat 收尾后多久之内不该再演（外部想立刻插一次自主活动时可查） */
  getRecentlyActed(withinMs = 60_000): boolean {
    return this.performing || this.now() - this.lastBeatAt < withinMs;
  }

  private async request(state: Record<string, unknown>): Promise<MindResponse> {
    if (this.deps.request) return this.deps.request(state);
    const api = window.electronAPI;
    if (!api?.mindBeat) return { ok: false, error: '未接通' };
    return (await api.mindBeat(state)) as MindResponse;
  }
}

/** 给她此刻的处境拍一张快照，喂给后端。 */
export function snapshotForMind(input: {
  idleMs: number;
  mode: string;
  focusMinutes: number;
  affection: number;
  energy: number;
  topic?: string;
}): Record<string, unknown> {
  return {
    idleMinutes: Math.max(0, Math.round(input.idleMs / 60_000)),
    mode: input.mode,
    focusToday: Math.round(input.focusMinutes),
    affection: Math.round(input.affection),
    energy: Math.round(input.energy),
    topic: input.topic ?? '',
  };
}

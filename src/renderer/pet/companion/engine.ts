// 陪伴引擎：她「主动」做事的全部逻辑都在这里。
//
// 为什么是「一个 tick + 一堆时间戳」而不是若干 setTimeout：
// 上一版把各种定时器散在组件里，改一个阈值就要翻三处 effect，而且专注模式下想
// 「暂停所有打扰」需要挨个 clear —— 漏一个就会在专注中途蹦出一句「喝口水」。
// 现在所有主动行为都由 tick() 每秒巡一遍，要静音就在入口统一 return。
//
// 这一层不碰 React：App 每秒钟喂它一次时间，它通过 deps.say 把话递回去。

// 注意下面的 '.ts' 后缀是刻意的：`npm test` 用 node --experimental-strip-types 直跑
// tests/companion.test.ts，Node 的 ESM 解析不做扩展名补全（Vite 会补，所以别处不用）。
// 为此 tsconfig 开了 allowImportingTsExtensions。
import {
  SCENE_CUES,
  greetingSceneFor,
  pickLine,
  type Scene,
  type SceneCue,
} from './lines.ts';

/** 主动打扰的档位。专注模式下除了 focus* 一律不开口。 */
export type CompanionMode = 'normal' | 'focus';

export interface CompanionDeps {
  /** 说一句话：App 负责渲染气泡 + 触发动画/情绪 */
  say: (text: string, cue: SceneCue) => void;
  /** 当前对话状态（'idle' / 'recording' / 'thinking' / 'speaking' / 'interrupted'） */
  getStatus: () => string;
  getStats: () => {
    hunger: number;
    happiness: number;
    energy: number;
    cleanliness: number;
    health: number;
    affection: number;
    isSleeping: boolean;
    isSick: boolean;
  };
  getCharacter: () => { id: string; name: string };
  /** 用户在改设置时给一条轻提示（可选） */
  flash?: (text: string) => void;
  /** 覆盖「现在」的时间源，仅测试用 */
  now?: () => number;
}

export interface CompanionConfig {
  /** 自言自语（她主动搭话） */
  idleChat: boolean;
  /** 健康提醒（久坐、喝水）与需求表达 */
  care: boolean;
  /** 专注默认时长 */
  focusMinutes: number;
}

export interface CompanionStat {
  /** YYYY-MM-DD，跨天自动清零 */
  date: string;
  focusDone: number;
  focusMinutes: number;
  pets: number;
}

export interface CompanionSnapshot {
  mode: CompanionMode;
  /** 距上一次真实互动多少毫秒。自主行为靠它判断"他多久没理我了" */
  idleMs: number;
  /** 专注剩余毫秒，非专注态为 0 */
  remainMs: number;
  totalMs: number;
  paused: boolean;
  stat: CompanionStat;
}

const CFG_KEY = 'pet_companion_cfg';
const STAT_KEY = 'pet_companion_stat';

export const DEFAULT_CFG: CompanionConfig = { idleChat: true, care: true, focusMinutes: 25 };

// ---- 时间阈值：集中在这里，调手感只改这一块 ----
const TICK_MS = 1000;
/** 自言自语的最短/最长间隔（在区间内随机，避免像闹钟一样准点） */
const IDLE_CHAT_MIN = 55_000;
const IDLE_CHAT_VARIANCE = 60_000;
/** 同一类需求的重复提醒冷却 */
const CARE_COOLDOWN = 8 * 60_000;
/** 喝水提醒周期 */
const DRINK_PERIOD = 45 * 60_000;
/** 连续在座多久提醒起身 */
const SIT_LIMIT = 50 * 60_000;
/** 多久判定「他离开了」 */
const AWAY_AFTER = 12 * 60_000;
/** 超过这么久没有光标活动，就不再认为人还在座位上 */
const ACTIVITY_STALE = 5 * 60_000;
/** 摸头连击的两个间隔档位 */
const COMBO_WINDOW = 2500;
const COMBO_COOLDOWN = 4000;

/** 好感里程碑：跨过这些点时她会有反应 */
const LEVEL_STEPS = [10, 30, 60, 100];

function todayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    // 存储坏了就用默认值继续，不能因为一条坏记录让宠物失去所有主动行为
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满/隐私模式：陪伴层降级为「不记忆」，不影响主功能 */
  }
}

export class CompanionEngine {
  private deps: CompanionDeps;
  private now: () => number;

  private cfg: CompanionConfig;
  private stat: CompanionStat;

  private mode: CompanionMode = 'normal';
  private startedAt: number;

  /** 最近一次任何形式的互动（摸头/说话/菜单） */
  private lastInteraction: number;
  /** 最近一次光标真实移动 */
  private lastActivity: number;
  private away = false;

  /** 下一次自言语的时刻 */
  private nextIdleChat: number;
  /** 各类需求的冷却截止时间 */
  private careUntil: Partial<Record<Scene, number>> = {};
  private nextDrinkAt: number;
  /** 连续在座累计（只在有光标活动时增长，离开会清零） */
  private seatedMs = 0;
  /** 已经为这一轮久坐提醒过 */
  private sitWarned = false;

  /** 摸头连击 */
  private comboCount = 0;
  private lastPokeAt = 0;
  private comboBlockedUntil = 0;
  /** 每 1.5s 最多向养成系统报一次抚摸，避免连击把 IPC 打满 */
  private lastPetReportAt = 0;

  /** 专注钟 */
  private focusTotalMs = 0;
  private focusRemainMs = 0;
  private focusPaused = false;
  private focusHalfTold = false;

  /** 好感里程碑已经说过的档位 */
  private levelSeen: number[] = [];
  /** 卸载标记：延时的台词不能在组件已经卸载后还往气泡里塞字 */
  private disposed = false;

  constructor(deps: CompanionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());

    this.cfg = readJSON<CompanionConfig>(CFG_KEY, DEFAULT_CFG);
    this.stat = this.rollStat(readJSON<CompanionStat>(STAT_KEY, {
      date: todayKey(this.now()),
      focusDone: 0,
      focusMinutes: 0,
      pets: 0,
    }));

    const t = this.now();
    this.startedAt = t;
    this.lastInteraction = t;
    this.lastActivity = t;
    this.nextIdleChat = t + IDLE_CHAT_MIN;
    this.nextDrinkAt = t + DRINK_PERIOD;
    this.levelSeen = LEVEL_STEPS.filter((s) => this.deps.getStats().affection >= s);
  }

  // ---------- 配置 ----------

  getConfig(): CompanionConfig {
    return { ...this.cfg };
  }

  updateConfig(patch: Partial<CompanionConfig>): CompanionConfig {
    this.cfg = { ...this.cfg, ...patch };
    writeJSON(CFG_KEY, this.cfg);
    // 关掉自言自语时立刻把下一次排远，避免「关了还冒一句」
    if (!this.cfg.idleChat) this.nextIdleChat = this.now() + IDLE_CHAT_MIN;
    return this.getConfig();
  }

  // ---------- 外部事件 ----------

  /** 光标动了：既算活动（久坐计时），也算「他回来了」（离开问候） */
  noteActivity(): void {
    const t = this.now();
    this.lastActivity = t;
    if (this.away) {
      this.away = false;
      this.seatedMs = 0;
      this.sitWarned = false;
      // 刚回来不立刻唠叨，隔一会儿再说
      this.say('comeback', 600);
    }
  }

  /** 有明确互动（摸头/对话/点菜单）：重置自言语倒计时 */
  noteInteraction(): void {
    const t = this.now();
    this.lastInteraction = t;
    this.lastActivity = t;
    this.nextIdleChat = t + IDLE_CHAT_MIN + Math.random() * IDLE_CHAT_VARIANCE;
  }

  /**
   * 摸一下。返回本次的表演与「要不要向养成系统报一次好感」。
   *
   * 连击分三档：1~2 下是普通摸头，3~5 下变害羞，6 下起傲娇拒绝并进入 4 秒冷却 ——
   * 不设冷却的话手一抖连点十几下，她会一直重复同一句「停」，比不反应更像坏掉。
   */
  poke(): { cue: SceneCue; report: boolean; scene: Scene } {
    const t = this.now();
    this.noteInteraction();

    if (t < this.comboBlockedUntil) {
      // 冷却中：照样有反应（不能变成「点了没反应」），但不再加好感
      this.say('pet6');
      return { cue: SCENE_CUES.pet6, report: false, scene: 'pet6' };
    }

    this.comboCount = t - this.lastPokeAt <= COMBO_WINDOW ? this.comboCount + 1 : 1;
    this.lastPokeAt = t;

    const scene: Scene = this.comboCount >= 6 ? 'pet6' : this.comboCount >= 3 ? 'pet3' : 'pet1';
    if (scene === 'pet6') {
      this.comboBlockedUntil = t + COMBO_COOLDOWN;
      this.comboCount = 0;
    }

    this.stat.pets += 1;
    this.persistStat();
    this.say(scene);

    // 好感不是白拿的：每 1.5 秒最多报一次，连点 10 下只加 1 点
    const report = t - this.lastPetReportAt > 1500;
    if (report) this.lastPetReportAt = t;

    return { cue: SCENE_CUES[scene], report, scene };
  }

  /** 主动搭话（菜单里的「陪我一会儿」） */
  chat(): void {
    this.noteInteraction();
    this.say(Math.random() < 0.35 ? this.greetingScene() ?? 'idle' : 'idle');
  }

  /** 启动问候：错开 1.4 秒，让入场动画先跑完 */
  greetOnStart(): void {
    const t = this.now();
    if (t - this.startedAt > 8000) return;
    const scene = this.greetingScene();
    if (scene) this.say(scene, 1400);
  }

  // ---------- 专注钟 ----------

  getSnapshot(): CompanionSnapshot {
    return {
      mode: this.mode,
      idleMs: this.now() - this.lastInteraction,
      remainMs: this.focusRemainMs,
      totalMs: this.focusTotalMs,
      paused: this.focusPaused,
      stat: { ...this.stat },
    };
  }

  startFocus(minutes?: number): void {
    const mins = Math.max(1, Math.round(minutes ?? this.cfg.focusMinutes));
    this.focusTotalMs = mins * 60_000;
    this.focusRemainMs = this.focusTotalMs;
    this.focusPaused = false;
    this.focusHalfTold = false;
    this.mode = 'focus';
    this.noteInteraction();
    this.say('focusStart', 0, mins);
  }

  /** 暂停/继续。暂停时专注钟不走，但 mode 仍是 focus（不打扰） */
  toggleFocusPause(): void {
    if (this.mode !== 'focus') return;
    this.focusPaused = !this.focusPaused;
  }

  stopFocus(reason: 'user' | 'done' = 'user'): void {
    if (this.mode !== 'focus') return;
    const doneMs = this.focusTotalMs - this.focusRemainMs;
    const mins = Math.max(1, Math.round(doneMs / 60_000));

    this.mode = 'normal';
    this.focusRemainMs = 0;
    this.focusTotalMs = 0;
    this.focusPaused = false;

    if (reason === 'done') {
      this.stat.focusDone += 1;
      this.stat.focusMinutes += mins;
      this.persistStat();
      this.say('focusEnd', 0, mins);
    } else {
      this.say('focusGiveUp');
    }

    // 退出专注后重新排队下一次自言语，别让他刚结束就被连着打扰
    this.noteInteraction();
  }

  // ---------- 主循环 ----------

  tick(): void {
    if (this.disposed) return;
    const t = this.now();
    const status = this.deps.getStatus();
    // 说话/录音/思考期间一律不主动开口；专注只放行专注自己的提示
    const canTalk = status === 'idle';

    this.rollStatIfNeeded(t);

    // 1) 专注倒计时（不受 canTalk 影响，它是计时器）
    if (this.mode === 'focus' && !this.focusPaused) {
      this.focusRemainMs -= TICK_MS;
      if (!this.focusHalfTold && this.focusRemainMs <= this.focusTotalMs / 2) {
        this.focusHalfTold = true;
        if (canTalk) this.say('focusMid', 0, Math.round(this.focusTotalMs / 60_000));
      }
      if (this.focusRemainMs <= 0) {
        this.stopFocus('done');
        return;
      }
    }

    // 2) 在座时长：只在真的动过鼠标时累加
    const active = t - this.lastActivity < ACTIVITY_STALE;
    if (!active) {
      if (t - this.lastActivity > AWAY_AFTER) {
        this.away = true;
        this.seatedMs = 0;
        this.sitWarned = false;
      }
    } else {
      this.seatedMs += TICK_MS;
    }

    // 专注模式下除了专注本身，不再产生任何主动打扰
    if (this.mode === 'focus' || !canTalk) {
      // 正在说话/思考时把下一次搭话往后推：否则 AI 刚闭嘴她就接一句，
      // 用户会以为后半句是 AI 说的
      if (!canTalk) this.nextIdleChat = Math.max(this.nextIdleChat, t + 20_000);
      return;
    }

    // 3) 需求表达（饿了/困了/脏了/生病）—— 一次只提一件，按严重度排序
    if (this.cfg.care && this.seatedMs > 90_000) this.maybeExpressNeed();

    // 4) 久坐与喝水
    if (this.cfg.care && !this.away) {
      if (!this.sitWarned && this.seatedMs >= SIT_LIMIT) {
        this.sitWarned = true;
        this.say('sit', 0, Math.round(this.seatedMs / 60_000));
      }
      if (t >= this.nextDrinkAt) {
        this.nextDrinkAt = t + DRINK_PERIOD;
        this.say('drink');
        return;
      }
    }

    // 5) 好感里程碑
    this.maybeLevelUp();

    // 6) 自言自语
    if (this.cfg.idleChat && t >= this.nextIdleChat) {
      this.nextIdleChat = t + IDLE_CHAT_MIN + Math.random() * IDLE_CHAT_VARIANCE;
      this.say('idle');
    }
  }

  // ---------- 内部 ----------

  private say(scene: Scene, delayMs = 0, minutes?: number): void {
    if (this.disposed) return;
    const { id, name } = this.deps.getCharacter();
    const text = pickLine(scene, { characterId: id, name, minutes });
    if (!text) return;
    const cue = SCENE_CUES[scene] ?? {};

    if (delayMs > 0) {
      setTimeout(() => {
        // React StrictMode 会 mount→unmount→mount，第一个引擎的延时回调必须作废，
        // 否则开发态每次启动都会听到两句问候
        if (!this.disposed) this.deps.say(text, cue);
      }, delayMs);
    } else {
      this.deps.say(text, cue);
    }
  }

  /** 卸载：停掉所有延时行为。不清的话 tick 与延迟台词会在组件卸载后继续跑 */
  dispose(): void {
    this.disposed = true;
  }

  private greetingScene(): Scene | null {
    return greetingSceneFor(new Date(this.now()).getHours());
  }

  private maybeExpressNeed(): void {
    const s = this.deps.getStats();
    if (s.isSleeping || this.mode !== 'normal') return;

    // 严重度排序：生病 > 快饿死 > 精力见底 > 脏 > 一般饥饿
    const candidates: { scene: Scene; urgent: boolean }[] = [];
    if (s.isSick) candidates.push({ scene: 'sick', urgent: true });
    if (s.hunger < 35) candidates.push({ scene: 'hungry', urgent: true });
    if (s.energy < 30) candidates.push({ scene: 'sleepy', urgent: false });
    if (s.cleanliness < 40) candidates.push({ scene: 'dirty', urgent: false });
    if (s.happiness < 40) candidates.push({ scene: 'lonely', urgent: false });

    const t = this.now();
    for (const c of candidates) {
      const until = this.careUntil[c.scene] ?? 0;
      if (t < until) continue;
      // 越紧急冷却越短：快饿死时不能因为「8 分钟说过一次」就闭嘴
      this.careUntil[c.scene] = t + (c.urgent ? CARE_COOLDOWN / 2 : CARE_COOLDOWN);
      this.say(c.scene);
      return;
    }
  }

  private maybeLevelUp(): void {
    const affection = this.deps.getStats().affection;
    for (const step of LEVEL_STEPS) {
      if (affection >= step && !this.levelSeen.includes(step)) {
        this.levelSeen.push(step);
        this.say('levelup');
        return;
      }
    }
  }

  private rollStat(s: CompanionStat): CompanionStat {
    const today = todayKey(this.now());
    if (s.date === today) return s;
    return { date: today, focusDone: 0, focusMinutes: 0, pets: 0 };
  }

  private rollStatIfNeeded(t: number): void {
    if (this.stat.date === todayKey(t)) return;
    this.stat = { date: todayKey(t), focusDone: 0, focusMinutes: 0, pets: 0 };
    this.persistStat();
  }

  private persistStat(): void {
    writeJSON(STAT_KEY, this.stat);
  }
}

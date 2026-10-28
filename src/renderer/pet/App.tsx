import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AnimationType,
  ANIMATION_KEYFRAMES,
  ANIMATIONS,
  ANIMATION_MENU_ITEMS,
  pickIdleAnimation,
  getRandomIdleInterval,
  canInterruptAnimation,
  getAnimationCSS,
} from './animations';
import {
  DEFAULT_PHYSICS,
  RELEASE_WINDOW_MS,
  makeThrowBody,
  stepPhysics,
  estimateReleaseVelocity,
  shouldThrow,
  type ThrowBody,
  type Rect,
  type Vec,
} from './physics';
import {
  resumeUnlock as resumeAudio,
  setMuted as setSoundMuted,
  playLand,
  playBump,
  playPet,
  playThrow,
  playLevelUp,
  playPing,
} from './sound';
import { msPerChar, revealText } from './typewriter';
import { PetSkin, getSkinCSSVariables } from '../shared/skins';
import {
  CHARACTERS,
  CHARACTER_SKINS,
  PERSONA_PROMPTS,
  characterOf,
  getSkinById,
} from './characters';
import { CompanionEngine, DEFAULT_CFG, type CompanionSnapshot } from './companion/engine';
import {
  AutonomyDirector,
  DEFAULT_AUTONOMY,
  readConfig as readAutonomyConfig,
  snapshotForMind,
  type AutonomyConfig,
  type SayCue,
} from './companion/autonomy';
import type { SceneCue } from './companion/lines';
import {
  Emotion,
  PetStats as PetCoreStats,
  EMOTION_CONFIGS,
  resolveEmotion,
  buildEmotionPromptSuffix,
} from '../shared/emotions';
import { clampMenuPosition, errorMessage } from '../shared/interaction';
import './pet.css';

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

type PetStatus = 'idle' | 'recording' | 'thinking' | 'speaking' | 'interrupted';

// 气泡文案：这是唯一一处用户「不看界面也能读懂现在在干什么」的地方，
// 所以每一句都写成「状态 + 下一步能做什么」，而不是一个名词。
const STATUS_TEXT: Record<PetStatus, string> = {
  idle: '',
  recording: '在听…再点一下结束',
  thinking: '思考中',
  speaking: '说话中 · 随时可以打断我',
  interrupted: '被打断了，接着说',
};

const DEFAULT_OLLAMA = 'http://localhost:11434';
const DEFAULT_STT = 'http://localhost:8084';
const DEFAULT_TTS = 'http://localhost:8086';
const DEFAULT_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DEFAULT_PET_NAME = '';
// 旧版默认人设（一只小猫咪）。判定「用户没改过 prompt」时要认得它，
// 否则换角色后还留着猫的设定，AI 会一边被喊名字一边自称猫。
const LEGACY_PROMPT =
  '你是一只可爱的桌面萌宠小猫咪，名字叫Z-Bot。性格活泼可爱、温柔体贴，用简短温馨的语言回复。';

// 语音打断阈值（可配置，默认30）
const INTERRUPT_THRESHOLD = 30;

// 录音硬上限：MediaRecorder 的分片全在内存里，按住不放不该无限录（02 §2.4）
const MAX_RECORDING_MS = 30_000;

// 手势分层的两个关键阈值。
// 长按改成「说话」而不是单击，是因为单击原本就直接开麦：随手点她一下会弹权限框、
// 或者录到半秒环境音就发出去 —— 桌面上最容易被误触的动作不该挂最重的功能。
const LONG_PRESS_MS = 480;
/** 按住超过这个位移就算拖拽，不再判定为点击 */
const DRAG_SLOP = 6;
/** 立绘缩放范围：小于 0.85 看不清表情，大于 1.15 会顶出窗口 */
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.15;
const SCALE_KEY = 'pet_scale';

function clampScale(v: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100));
}

// 成长阶段 ⇒ 立绘缩放。以前是「圆的直径 90→140」，现在换成整体缩放，
// 幅度收窄到 0.94~1.00：放大会顶出窗口，缩小到 0.9 以下又像被丢远了。
const STAGE_SCALE: Record<PetCoreStats['stage'], number> = {
  egg: 0.94,
  baby: 0.96,
  child: 0.98,
  adult: 1,
};

// 阶段名只用于 HUD 那一行字：状态里存的是英文枚举，直接打到中文界面上会露出「阶段 egg」。
const STAGE_LABEL: Record<PetCoreStats['stage'], string> = {
  egg: '孵化',
  baby: '幼年',
  child: '少年',
  adult: '成年',
};

// HUD 六维属性条
const STAT_BARS: { key: keyof PetCoreStats; label: string; icon: string; color: string }[] = [
  { key: 'hunger', label: '饱食', icon: '🍖', color: '#faad14' },
  { key: 'happiness', label: '心情', icon: '😊', color: '#eb2f96' },
  { key: 'energy', label: '精力', icon: '⚡', color: '#1890ff' },
  { key: 'cleanliness', label: '清洁', icon: '🛁', color: '#13c2c2' },
  { key: 'health', label: '健康', icon: '❤️', color: '#ff4d4f' },
  { key: 'affection', label: '好感', icon: '💕', color: '#722ed1' },
];


const DEFAULT_STATS: PetCoreStats = {
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

/** #RRGGBB / #RGB ⇒ rgba(...)，给光晕用 */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(140, 140, 200, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// 气泡打字机：她「说的话」逐字长出来，状态词（在听…/思考中）仍然瞬间出现 ——
// 台词有打字过程才像在开口，状态词慢半拍只会被当成程序卡死。
// 推进逻辑全在纯函数 typewriter.ts（注入时间即可测），这里只负责把
// performance.now() 喂进去。文案或 retrigger 变化时在渲染期就切到新句开头
// （React 官方的 render-phase state 调整），而不是等 effect —— 否则气泡会
// 先闪一帧上一句（或整段全文）再跳回第一个字。
function useTypewriter(text: string, retrigger?: unknown): string {
  const [entry, setEntry] = useState(() => ({ text, retrigger, shown: revealText(text, 0) }));
  if (entry.text !== text || entry.retrigger !== retrigger) {
    setEntry({ text, retrigger, shown: revealText(text, 0) });
  }

  useEffect(() => {
    // 短句（≤6 字）没有打字过程；系统要求「减少动态效果」时也直接出全
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (msPerChar(text) === 0 || reduced) {
      setEntry((e) => (e.text === text ? { ...e, shown: text } : e));
      return;
    }

    const start = performance.now();
    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - start;
      const shown = revealText(text, elapsed);
      setEntry((e) => (e.text === text ? { ...e, shown } : e));
      if (shown === text) return; // 出全了就停在这帧，不再空转
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, retrigger]);

  return entry.shown;
}

function App() {
  const [status, setStatus] = useState<PetStatus>('idle');
  const [lastMessage, setLastMessage] = useState('');
  const [hint, setHint] = useState('');
  const [config, setConfig] = useState({
    ollamaUrl: DEFAULT_OLLAMA,
    sttUrl: DEFAULT_STT,
    ttsUrl: DEFAULT_TTS,
    modelName: DEFAULT_MODEL,
    systemPrompt: CHARACTERS[0].persona,
    petName: DEFAULT_PET_NAME,
    voiceSpeed: 1.0,
    particleEnabled: true,
    interruptThreshold: 30,
  });

  // 动画状态
  const [currentAnimation, setCurrentAnimation] = useState<AnimationType>('idle');
  const [animationCSS, setAnimationCSS] = useState<string>(getAnimationCSS('idle'));
  const [hearts, setHearts] = useState<number[]>([]);
  const [zzzVisible, setZzzVisible] = useState(false);
  // 跟随鼠标的微小倾斜：旧版是「瞳孔跟随」，立绘上做不到动眼，
  // 改成整个人向鼠标方向偏一点点 —— 更含蓄，但一样能感觉到她在看你。
  const [cursorLean, setCursorLean] = useState({ x: 0, y: 0 });

  // 养成 / 情绪 / 面板状态
  const [petStats, setPetStats] = useState<PetCoreStats>(DEFAULT_STATS);
  const [currentEmotion, setCurrentEmotion] = useState<Emotion>('happy');
  const [showHUD, setShowHUD] = useState(false);
  const [micGuide, setMicGuide] = useState(false);

  // ---------- 陪伴层 ----------
  // 她主动说的话走独立通道，不塞进 lastMessage：AI 的回复要留在气泡里让人读，
  // 她随口一句「喝口水」不该把上一条回答顶掉 —— 反过来，新话出口时旧回复要让位。
  const [companionSay, setCompanionSay] = useState<{ text: string; nonce: number } | null>(null);
  const [companionSnap, setCompanionSnap] = useState<CompanionSnapshot>({
    mode: 'normal',
    idleMs: 0,
    remainMs: 0,
    totalMs: 0,
    paused: false,
    stat: { date: '', focusDone: 0, focusMinutes: 0, pets: 0 },
  });
  const [careMenuOpen, setCareMenuOpen] = useState(false);
  const [companionMenuOpen, setCompanionMenuOpen] = useState(false);
  const [companionCfg, setCompanionCfg] = useState({ ...DEFAULT_CFG });
  const [autonomyCfg, setAutonomyCfg] = useState<AutonomyConfig>(() => readAutonomyConfig());
  const [petScale, setPetScale] = useState(() => {
    const raw = Number(localStorage.getItem(SCALE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampScale(raw) : 1;
  });
  const companionRef = useRef<CompanionEngine | null>(null);
  const autonomyRef = useRef<AutonomyDirector | null>(null);
  const sayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const petScaleRef = useRef(petScale);
  petScaleRef.current = petScale;
  const cursorDeltaRef = useRef({ dx: 0, dy: 0 });
  // 流式回复缓冲（T3.8）：main 只把 chunk 发给发起窗口，这里按 ref 判定归属
  const streamActiveRef = useRef(false);
  const streamBufRef = useRef('');
  const petStatsRef = useRef<PetCoreStats>(DEFAULT_STATS);
  petStatsRef.current = petStats;
  const handlePetActionRef = useRef<((action: string) => void) | null>(null);

  // 2026-10-21：下面三个 ref 是为修 ESLint 报的 3 条 `react-hooks/exhaustive-deps`
  // （缺依赖）而加的**转发层**。原来三处 useCallback 的依赖数组都是 `[]`，
  // 但回调里用了后面才声明的函数（`triggerAnimation` / `startIdleScheduler` / `spawnHearts`）
  // ⇒ 闭包捕获的是**首次渲染时**的旧引用。今天这三者的实现都只读 ref、不读 state，
  // 所以行为上暂时等价；但一旦它们内部改用 state 或 props，闭包就会**静默过期**。
  //
  // 修法不用「把函数挪到依赖数组里」（那会连带重跑整条 effect 链），
  // 而是照本仓既有的 handlePetActionRef 约定做 ref 转发 —— 闭包里读 ref.current，
  // 永远是最新实现，依赖数组保持 `[]`。
  const triggerAnimationRef = useRef<((animType: AnimationType, source?: 'user' | 'status' | 'idle') => void) | null>(null);
  const startIdleSchedulerRef = useRef<(() => void) | null>(null);
  const spawnHeartsRef = useRef<(() => void) | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 统一提示条：后一条提示覆盖前一条，避免旧定时器把新提示提前清掉
  const flashHint = useCallback((text: string, ms = 4000) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    setHint(text);
    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null;
      setHint('');
    }, ms);
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const stats = await window.electronAPI?.petGetStats();
      if (stats) setPetStats(stats as PetCoreStats);
    } catch (error) {
      // 养成数值是后台刷新，失败时保留上一次的值即可；但必须留痕，不能静默
      log('[Pet] 养成状态刷新失败: ' + errorMessage(error, '主进程无响应'));
    }
  }, []);

  // 主进程动作投递（定时任务 speak/animation/... 修复 D12 后的接收端）
  const handleTaskAction = useCallback(
    (payload: { type: string; content: string; taskName?: string }) => {
      switch (payload.type) {
        case 'speak':
          setLastMessage(payload.content);
          setStatus('speaking');
          break;
        case 'animation':
          triggerAnimationRef.current?.(payload.content as AnimationType, 'user');
          break;
        case 'petAction':
          void handlePetActionRef.current?.(payload.content);
          break;
        default:
          break;
      }
    },
    []
  );

  // 皮肤（= 角色）
  const [currentSkin, setCurrentSkin] = useState<PetSkin>(CHARACTER_SKINS[0]);
  const [skinVars, setSkinVars] = useState<Record<string, string>>(getSkinCSSVariables(CHARACTER_SKINS[0]));
  const currentSkinRef = useRef<PetSkin>(CHARACTER_SKINS[0]);
  currentSkinRef.current = currentSkin;
  const persona = characterOf(currentSkin.id);
  // 她自称用界面上的名字（用户可以在管理端改名），所以台词里的 {me} 走这个 ref
  const petNameRef = useRef(DEFAULT_PET_NAME);
  petNameRef.current = config.petName?.trim() || persona.name;

  // 场景和粒子状态
  const [currentScenery, setCurrentScenery] = useState({
    id: 'day',
    name: '阳光明媚',
    type: 'day',
    backgroundColor: 'linear-gradient(135deg, #87CEEB 0%, #E0F7FA 100%)',
    particleColor: '#FFD700',
  });
  // 默认从 emoji 换成光点：立绘是主角，飘落的心形星形会跟画面打架。
  // 类型 'mote' 是新增的，旧配置里的 emoji 粒子照旧渲染，不影响存量用户。
  const [particleEffects, setParticleEffects] = useState<
    { id: string; type: 'heart' | 'star' | 'music' | 'sparkle' | 'bounce' | 'float' | 'mote'; content: string; enabled?: boolean }[]
  >([
    { id: 'm1', type: 'mote', content: '' },
    { id: 'm2', type: 'mote', content: '' },
    { id: 'm3', type: 'mote', content: '' },
    { id: 'm4', type: 'mote', content: '' },
  ]);

  // 粒子布局只计算一次：原先把 Math.random() 写在 render 的 inline style 里，
  // 每次重渲染都会重排这些常驻 infinite 动画元素
  const particleLayouts = useMemo(
    () =>
      particleEffects
        .filter((p) => p.enabled !== false)
        .map((p, i) => ({
          id: p.id,
          type: p.type,
          content: p.content,
          style: {
            left: `${12 + ((i * 23) % 72)}%`,
            animationDelay: `${((i * 17) % 46) / 10}s`,
            animationDuration: `${6 + ((i * 7) % 5)}s`,
          } as React.CSSProperties,
        })),
    [particleEffects]
  );

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; show: boolean }>({ x: 0, y: 0, show: false });
  const [skinMenuOpen, setSkinMenuOpen] = useState(false);
  const [animMenuOpen, setAnimMenuOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStateRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    /** 拖拽过程中的指针采样，用来在松手瞬间估出「甩出去」的速度 */
    samples: { x: number; y: number; t: number }[];
  }>({
    dragging: false,
    startX: 0,
    startY: 0,
    samples: [],
  });
  // 一次按下的完整生命周期：按下 → (拖拽 | 长按说话 | 点击摸头) 三选一
  const pressRef = useRef<{
    downAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    recording: boolean;
    moved: boolean;
    x: number;
    y: number;
  }>({ downAt: 0, timer: null, recording: false, moved: false, x: 0, y: 0 });
  const lastStruggleAtRef = useRef(0);
  /** 摸头失败提示的节流：0 表示还没提示过 */
  const petErrorHintRef = useRef(0);
  // 松手判定要在 window 上收口（拖拽时指针可能已经移出小窗），因此用 ref 转发，
  // 避免把每次渲染新生成的闭包绑死在首次 effect 里。
  const finishPressRef = useRef<(() => void) | null>(null);
  const statusRef = useRef<PetStatus>('idle');
  statusRef.current = status;

  // 语音打断相关 refs
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const isSpeakingRef = useRef(false);
  const interruptStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const interruptAnimFrameRef = useRef<number | null>(null);
  const interruptThresholdRef = useRef(INTERRUPT_THRESHOLD);

  // 动画相关 refs
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 2026-10-21 删掉 `cursorTrackRef`：它是 Electron 时代「前端 100ms 轮询取光标位置」
  // 那条路径的遗留 —— 移植到 Tauri 时实现被删了（依赖的 window.electronAPI.getCursorPosition
  // 不存在），但 ref 声明与卸载时的 clearInterval 漏删，于是留下一个**永远不会被赋值**的孤儿。
  // 光标跟随功能本身**没有丢**：已改为主进程推送（T3.2 的 applyCursorDelta）。
  const currentAnimRef = useRef<AnimationType>('idle');
  currentAnimRef.current = currentAnimation;

  // 抛掷物理：飞行中的状态放在 ref 里，rAF 回调永远读得到最新值，
  // 也不需要为它触发任何 re-render（位置是窗口属性，不是 React 状态）。
  const physicsRef = useRef<{
    body: ThrowBody | null;
    area: Rect | null;
    size: { width: number; height: number } | null;
    lastAt: number;
    frame: number | null;
    lastLandedAt: number;
  }>({ body: null, area: null, size: null, lastAt: 0, frame: null, lastLandedAt: 0 });
  /** 音效开关：与粒子开关分开，因为「静音」和「不想看飘落物」是两种诉求 */
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('pet_sound') !== '0');
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
  useEffect(() => {
    setSoundMuted(!soundOn);
    localStorage.setItem('pet_sound', soundOn ? '1' : '0');
  }, [soundOn]);

  /** 掉出屏幕太多时把自己拉回来（多屏切换/分辨率变化后窗口可能落在不可见区域） */
  const recoverIfLost = useCallback(async () => {
    const api = window.electronAPI;
    const b = await api?.getMotionBounds?.().catch(() => null);
    if (!b) return false;
    const area: Rect = { x: b.areaX, y: b.areaY, width: b.areaW, height: b.areaH };
    const visW = Math.max(0, Math.min(b.winX + b.winW, area.x + area.width) - Math.max(b.winX, area.x));
    const visH = Math.max(0, Math.min(b.winY + b.winH, area.y + area.height) - Math.max(b.winY, area.y));
    // 超过 25% 不可见才拉：贴边站住是正常姿态，不该被当成掉落
    if (visW * visH >= b.winW * b.winH * 0.75) return false;
    const p = await api?.recoverPetPosition?.().catch(() => null);
    if (p) {
      log(`[Pet] 检测到窗口不可见，已拉回 (${p.x}, ${p.y})`);
      flashHint('刚才跑到屏幕外了，我回来了', 3000);
      playLand(0.5);
    }
    return !!p;
  }, [flashHint]);

  /** 结束这一轮物理：清 rAF、清状态 */
  const stopPhysics = useCallback(() => {
    const p = physicsRef.current;
    if (p.frame != null) cancelAnimationFrame(p.frame);
    p.frame = null;
    p.body = null;
    p.lastAt = 0;
  }, []);

  /**
   * 抛出：从当前窗口位置 + 释放速度开始积分。
   *
   * 关键取舍 —— 整段飞行只在开始时取一次工作区（一次 IPC），之后每帧的
   * 位置更新全在渲染进程算完再 `movePetWindow` 增量推过去。若改成每帧都
   * 查工作区，一次抛掷要几十次 invoke，延迟会叠到肉眼可见的卡顿。
   */
  const launchPhysics = useCallback(
    async (velocity: Vec) => {
      const api = window.electronAPI;
      if (!api?.getMotionBounds) return;
      const b = await api.getMotionBounds().catch(() => null);
      if (!b) {
        // 拿不到边界就没有可以碰撞的墙，退回贴边，别让她悬在半空
        void api.stickToEdge?.();
        return;
      }
      const p = physicsRef.current;
      if (p.frame != null) cancelAnimationFrame(p.frame);
      p.body = makeThrowBody(b.winX, b.winY, velocity.x, velocity.y);
      p.area = { x: b.areaX, y: b.areaY, width: b.areaW, height: b.areaH };
      p.size = { width: b.winW, height: b.winH };
      p.lastAt = performance.now();
      p.lastLandedAt = 0;

      // 拎起来的那一下：给一点声音反馈，让人知道「这次是甩，不是挪」
      if (soundOnRef.current) {
        playThrow(Math.min(1, Math.hypot(velocity.x, velocity.y) / 2000));
      }

      const frame = (now: number) => {
        const st = physicsRef.current;
        if (!st.body || !st.area || !st.size) return;
        // dt 由物理层自己钳到 8ms，这里只负责传真实间隔（切后台回来的第一帧可能很大）
        const dt = (now - st.lastAt) / 1000;
        st.lastAt = now;

        const before = st.body;
        const { body, events } = stepPhysics(before, dt, st.area, st.size, DEFAULT_PHYSICS);
        st.body = body;

        const dx = Math.round(body.x - before.x);
        const dy = Math.round(body.y - before.y);
        if (dx !== 0 || dy !== 0) void api.movePetWindow?.(dx, dy);

        for (const ev of events) {
          if (ev.kind === 'land') {
            // 反弹时每次触地都响；但 120ms 内不重复播，避免高帧率下音效糊成一片
            if (soundOnRef.current && now - st.lastLandedAt > 120) {
              st.lastLandedAt = now;
              playLand(ev.speed / 2000);
            }
            // 落地抖一下：用户主动抛的才抖，自己飘下来的不抖
            triggerAnimationRef.current?.('wobble', 'user');
          } else if (ev.kind === 'wall' || ev.kind === 'ceiling') {
            if (soundOnRef.current && now - st.lastLandedAt > 120) {
              st.lastLandedAt = now;
              playBump(ev.speed / 2000);
            }
          }
        }

        // 收尾：站稳就贴边（贴边是既有行为，保证她最后停在工作区底部）
        if (body.settled) {
          physicsRef.current.frame = null;
          physicsRef.current.body = null;
          void api.stickToEdge?.();
          return;
        }
        st.frame = requestAnimationFrame(frame);
      };
      p.frame = requestAnimationFrame(frame);
    },
    []
  );

  // 掉落自救：分辨率变化、外接屏拔掉、全屏应用抢占，都可能让窗口落在
  // 工作区外 —— 那时她就"没了"，而且用户完全不知道去哪找。每 20 秒查一次，
  // 超过 25% 不可见就把自己拉回来（VPet 的 ResetPosition 同款）。
  useEffect(() => {
    const timer = setInterval(() => {
      // 飞行中不插手：物理层自己知道在哪，中途纠正会打断落点
      if (physicsRef.current.frame != null) return;
      void recoverIfLost();
    }, 20_000);
    return () => clearInterval(timer);
  }, [recoverIfLost]);

  useEffect(() => {
    log('[Pet] 组件初始化');
    // 一条启动自检：语音是主功能，采集能力有没有被 WebView 暴露，事后靠翻日志要能一眼看出来。
    // macOS 缺 NSMicrophoneUsageDescription 时这里会是 false，且不会弹任何权限框。
    const canCapture = !!navigator.mediaDevices?.getUserMedia;
    log(`[Pet] 采集能力: mediaDevices=${canCapture ? 'ok' : '不可用'}`);
    if (!canCapture) {
      log('[Pet] 提示：本机 WebView 未暴露 mediaDevices，语音输入与打断将不可用');
    }

    // preload 注入失败时宠物仍要能动，但必须让用户知道为什么点什么都没反应
    if (!window.electronAPI) {
      console.error('[Pet] electronAPI 缺失：预加载脚本未注入，宠物进入只读降级模式');
      setHint('主进程通道异常 · 仅本地动画');
    }

    // 加载配置
    window.electronAPI?.loadConfig().then((cfg) => {
      if (cfg) {
        // 角色：老配置里是 'default-purple' 这类已下线的 id，getSkinById 会退回第一个角色
        const skin = getSkinById(cfg.currentSkinId);
        setCurrentSkin(skin);
        setSkinVars(getSkinCSSVariables(skin));

        const personaOfSkin = characterOf(skin.id).persona;
        const savedPrompt = cfg.systemPrompt;
        // 没写过、或还是旧版猫咪设定、或还是某个角色的人设 ⇒ 跟随当前角色
        const promptIsDefault =
          !savedPrompt || savedPrompt === LEGACY_PROMPT || PERSONA_PROMPTS.includes(savedPrompt);

        setConfig({
          ollamaUrl: cfg.ollamaUrl || DEFAULT_OLLAMA,
          sttUrl: cfg.sttUrl || DEFAULT_STT,
          ttsUrl: cfg.ttsUrl || DEFAULT_TTS,
          modelName: cfg.modelName || DEFAULT_MODEL,
          systemPrompt: promptIsDefault ? personaOfSkin : savedPrompt,
          petName: cfg.petName === 'Z-Bot 小猫咪' ? DEFAULT_PET_NAME : cfg.petName || DEFAULT_PET_NAME,
          voiceSpeed: cfg.voiceSpeed || 1.0,
          interruptThreshold: cfg.interruptThreshold || 30,
          particleEnabled: cfg.particleEnabled !== false,
        });
        interruptThresholdRef.current = cfg.interruptThreshold || 30;
      }
    }).catch((e: any) => {
      // 读配置失败只降级到默认值，宠物必须照常可见可点
      log('[Pet] 配置读取失败，改用默认设置: ' + errorMessage(e, '主进程无响应'));
      flashHint('配置读取失败 · 已用默认设置', 5000);
    });

    const unsubStart = window.electronAPI?.onVoiceStart(() => startRecording());
    const unsubStop = window.electronAPI?.onVoiceStop(() => stopRecording());

    // 启动空闲动画调度
    startIdleScheduler();
    // 拉取养成状态并订阅主进程推送
    refreshStats();
    const statsTimer = setInterval(() => void refreshStats(), 30_000);
    const unsubCursor = window.electronAPI?.onCursorDelta?.(applyCursorDelta);
    const unsubTask = window.electronAPI?.onTaskAction?.((payload) => handleTaskAction(payload));
    const unsubChunk = window.electronAPI?.onAiStreamChunk?.((chunk) => {
      if (!streamActiveRef.current) return;
      if (chunk?.content) {
        streamBufRef.current += chunk.content;
        setLastMessage(streamBufRef.current);
      }
      if (chunk?.done) streamActiveRef.current = false;
    });

    // 监听动画触发IPC
    const unsubAnim = window.electronAPI?.onTriggerAnimation?.((anim: string) => {
      triggerAnimation(anim as AnimationType, 'user');
    });
    // 监听皮肤应用IPC
    const unsubSkin = window.electronAPI?.onApplySkin?.((skin: PetSkin) => {
      applySkin(skin);
    });

    // 加载场景和粒子设置
    try {
      const savedScenery = localStorage.getItem('current_scenery');
      if (savedScenery) {
        setCurrentScenery(JSON.parse(savedScenery));
      }

      const savedParticles = localStorage.getItem('particle_settings');
      if (savedParticles) {
        setParticleEffects(JSON.parse(savedParticles));
      }
    } catch (e) {
      log('[Pet] 加载场景设置失败');
    }

    // 管理端改场景/粒子写的是同一 origin 的 localStorage；监听 storage 才能即时生效，
    // 而不是“保存成功、萌宠等重启才变”（合同一.1：可点击 = 有结果）
    const onStorage = (event: StorageEvent) => {
      if (!event.newValue) return;
      try {
        if (event.key === 'current_scenery') {
          setCurrentScenery(JSON.parse(event.newValue));
        } else if (event.key === 'particle_settings') {
          const parsed = JSON.parse(event.newValue);
          if (Array.isArray(parsed)) setParticleEffects(parsed);
        }
      } catch (error) {
        log('[Pet] 场景设置同步失败: ' + errorMessage(error, '数据格式非法'));
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
      stopRecording();
      stopInterruptListener();
      unsubStart?.();
      unsubStop?.();
      unsubAnim?.();
      unsubSkin?.();
      unsubCursor?.();
      unsubTask?.();
      unsubChunk?.();
      clearInterval(statsTimer);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      // 卸载时若还在飞行，必须取消 rAF：回调里持有 api.movePetWindow，
      // 组件已销毁后继续推窗口只会报错或把窗口推到奇怪的位置
      stopPhysics();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 动画系统 ----------

  const triggerAnimation = useCallback((animType: AnimationType, source: 'user' | 'status' | 'idle' = 'user') => {
    if (!canInterruptAnimation(currentAnimRef.current, animType, source)) {
      return;
    }

    // 清除之前的动画定时器
    if (animationTimerRef.current) {
      clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }

    setCurrentAnimation(animType);
    setAnimationCSS(getAnimationCSS(animType));

    const animConfig = ANIMATIONS[animType];

    // sleep动画显示Zzz
    if (animType === 'sleep') {
      setZzzVisible(true);
    } else {
      setZzzVisible(false);
    }

    // 有限次动画结束后回到idle
    if (animConfig.autoReturnToIdle && animConfig.iteration !== 'infinite') {
      const totalDuration = animConfig.duration * (typeof animConfig.iteration === 'number' ? animConfig.iteration : 1);
      animationTimerRef.current = setTimeout(() => {
        setCurrentAnimation('idle');
        setAnimationCSS(getAnimationCSS('idle'));
        currentAnimRef.current = 'idle';
        // 重新启动空闲调度
        startIdleSchedulerRef.current?.();
      }, totalDuration + 50);
    }
  }, []);
  // ref 转发：让早于本函数声明的闭包（handleTaskAction）也能调到最新实现
  triggerAnimationRef.current = triggerAnimation;

  const startIdleScheduler = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // 空闲动作与间隔都按当前养成数值抽：精力见底时她更爱伸懒腰、打哈欠，
    // 间隔也拉长；数值不是 HUD 上的摆设，而是真的决定她在干什么。
    // petStatsRef 每次渲染刷新，这里读到的永远是最新值，不需要进依赖数组。
    const mood = () => {
      const s = petStatsRef.current;
      return { energy: s.energy, happiness: s.happiness, hunger: s.hunger };
    };
    idleTimerRef.current = setTimeout(() => {
      if (statusRef.current === 'idle' && currentAnimRef.current === 'idle') {
        const pick = pickIdleAnimation(mood());
        log(`[Pet] 空闲动作 → ${pick.anim}（精力${Math.round(petStatsRef.current.energy)} 心情${Math.round(petStatsRef.current.happiness)}）`);
        triggerAnimationRef.current?.(pick.anim, 'idle');
      }
    }, getRandomIdleInterval(mood()));
  }, []);
  // ref 转发：让早于本函数声明的闭包（triggerAnimation 内部）能调到最新实现
  startIdleSchedulerRef.current = startIdleScheduler;

  // 鼠标追踪改为消费主进程推送（T3.2）：渲染端不再有 100ms 轮询定时器
  const applyCursorDelta = useCallback((delta: { dx: number; dy: number }) => {
    cursorDeltaRef.current = delta;
    // 光标真的动了才算「人在座位上」：主进程即使光标静止也会推 (0,0)，
    // 不设阈值的话久坐计时会在人已经离开时继续累加，然后对着空房间提醒起身。
    if (Math.abs(delta.dx) + Math.abs(delta.dy) > 2) {
      companionRef.current?.noteActivity();
    }
    if (statusRef.current !== 'idle') return;
    if (currentAnimRef.current !== 'idle' && currentAnimRef.current !== 'float') return;
    const { dx, dy } = delta;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const reach = 2.4;
    setCursorLean({
      x: Math.round((dx / dist) * reach * 10) / 10,
      y: Math.round((dy / dist) * reach * 10) / 10,
    });
  }, []);

  // ---------- 皮肤（角色）系统 ----------

  const persistSkin = useCallback((skin: PetSkin) => {
    window.electronAPI
      ?.loadConfig()
      .then((cfg) => {
        if (cfg) return window.electronAPI?.saveConfig({ ...cfg, currentSkinId: skin.id });
        return undefined;
      })
      .catch((error) => {
        // 皮肤已在本窗生效；落盘失败只影响下次启动，记日志但不再打断用户
        log('[Pet] 皮肤保存失败: ' + errorMessage(error, '主进程无响应'));
      });
  }, []);

  const applySkin = useCallback((skin: PetSkin) => {
    // 三条来路都要收敛到同一件事：
    //   1. pet:applySkin 送 id ⇒ 桥接层回查 Rust 色板，拿回来的是「有配色、没立绘」的对象；
    //   2. pet:applySkinData 送 AI 自定义色板 ⇒ 同理；
    //   3. 本地换角色 ⇒ 自带立绘。
    // 前两种如果直接 set，立绘区域会空掉，所以先按 id 认回本地角色；
    // 认不出来的（AI 自定义色板）保留当前人像、只换配色。
    const known = CHARACTER_SKINS.find((s) => s.id === skin.id);
    const merged: PetSkin = known
      ? known
      : {
          ...skin,
          portrait: currentSkinRef.current.portrait,
          face: currentSkinRef.current.face,
          role: currentSkinRef.current.role,
          greeting: currentSkinRef.current.greeting,
        };
    setCurrentSkin(merged);
    setSkinVars(getSkinCSSVariables(merged));
    persistSkin(merged);
    log('[Pet] 应用角色/配色: ' + merged.name);
  }, [persistSkin]);

  /** 换角色：配色 + 立绘 + 人设（人设只在用户没自定义过时才跟着换） */
  const selectCharacter = useCallback((id: string) => {
    const skin = getSkinById(id);
    const nextPersona = characterOf(id).persona;
    setCurrentSkin(skin);
    setSkinVars(getSkinCSSVariables(skin));
    setLastMessage('');
    setConfig((prev) => {
      const promptIsDefault = !prev.systemPrompt || PERSONA_PROMPTS.includes(prev.systemPrompt);
      return promptIsDefault ? { ...prev, systemPrompt: nextPersona } : prev;
    });
    window.electronAPI
      ?.loadConfig()
      .then((cfg) => {
        if (!cfg) return undefined;
        const promptIsDefault =
          !cfg.systemPrompt || cfg.systemPrompt === LEGACY_PROMPT || PERSONA_PROMPTS.includes(cfg.systemPrompt);
        return window.electronAPI?.saveConfig({
          ...cfg,
          currentSkinId: skin.id,
          ...(promptIsDefault ? { systemPrompt: nextPersona } : {}),
        });
      })
      .catch((error) => {
        log('[Pet] 角色切换落盘失败: ' + errorMessage(error, '主进程无响应'));
      });
    flashHint(`换成了 ${skin.name}`, 2200);
    log('[Pet] 切换角色: ' + skin.id);
  }, [flashHint]);

  // ---------- 语音打断监听 ----------
  const startInterruptListener = async () => {
    if (isSpeakingRef.current && interruptStreamRef.current) return;

    // 打断监听是「锦上添花」：拿不到麦克风就静静退出，不要在这里弹权限引导打断用户。
    // 但也不能什么都不记 —— 否则用户会觉得语音打断偶尔失灵而查不到原因。
    if (!navigator.mediaDevices?.getUserMedia) {
      log('[Pet] 语音打断不可用：本机 WebView 未暴露 mediaDevices');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      interruptStreamRef.current = stream;

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      log('[Pet] 语音打断监听已启动');

      const checkVolume = () => {
        if (!isSpeakingRef.current || !analyserRef.current) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;

        if (avg > interruptThresholdRef.current) {
          log('[Pet] 检测到用户说话，音量: ' + avg.toFixed(1));
          handleInterrupt();
          return;
        }
        interruptAnimFrameRef.current = requestAnimationFrame(checkVolume);
      };
      checkVolume();
    } catch (error: any) {
      log('[Pet] 启动打断监听失败: ' + errorMessage(error, '未知错误'));
    }
  };

  const stopInterruptListener = () => {
    if (interruptAnimFrameRef.current) {
      cancelAnimationFrame(interruptAnimFrameRef.current);
      interruptAnimFrameRef.current = null;
    }
    if (interruptStreamRef.current) {
      interruptStreamRef.current.getTracks().forEach((track) => track.stop());
      interruptStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      // 关 AudioContext 是卸载清理：关不掉也拦不住下一次录音，留日志即可
      audioContextRef.current.close().catch((error) => {
        log('[Pet] 关闭打断监听 AudioContext 失败: ' + errorMessage(error, '未知错误'));
      });
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  };

  const handleInterrupt = () => {
    log('[Pet] 语音打断!');
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    isSpeakingRef.current = false;
    stopInterruptListener();

    setStatus('interrupted');
    setTimeout(() => {
      setStatus('idle');
      startRecording();
    }, 500);
  };

  // ---------- 录音 ----------
  const startRecording = async () => {
    if (statusRef.current === 'recording') {
      stopRecording();
      return;
    }
    if (statusRef.current !== 'idle' && statusRef.current !== 'interrupted') return;

    log('[Pet] 开始录音...');
    try {
      // T2.9：录音前预检权限，被拒时给可操作的引导，而不是静默失败。
      // 预检本身也可能 reject（主进程不可用），与 getUserMedia 失败走同一个 catch。
      const granted = await window.electronAPI?.checkMicrophone();
      if (granted === false) {
        log('[Pet] 麦克风未授权，显示引导');
        setMicGuide(true);
        setStatus('idle');
        return;
      }

      // 第二道关：这台机器的 WKWebView 到底有没有暴露采集能力。
      // macOS 上 Info.plist 缺 NSMicrophoneUsageDescription 时 mediaDevices 是 undefined，
      // 直接写 getUserMedia 会抛 TypeError（onclick 一片安静，用户以为点坏了）。
      // 分不清是「系统没声明」还是「权限被拒」，两种情况都走麦克风引导，让用户有一条路可走。
      if (!navigator.mediaDevices?.getUserMedia) {
        log('[Pet] 本机 WebView 无采集能力（mediaDevices 不可用），显示引导');
        setMicGuide(true);
        setStatus('idle');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        await processAudio(audioBlob);
      };

      mediaRecorder.start();
      setStatus('recording');
      log('[Pet] 录音中...');
      recordCapTimerRef.current = setTimeout(() => {
        recordCapTimerRef.current = null;
        if (statusRef.current !== 'recording') return;
        log('[Pet] 录音达到上限，自动停止');
        setHint(`录音已达 ${Math.round(MAX_RECORDING_MS / 1000)}s 上限`);
        stopRecording();
      }, MAX_RECORDING_MS);
    } catch (error: any) {
      log('[Pet] 录音错误: ' + errorMessage(error, '未知错误'));
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        setMicGuide(true);
      } else {
        flashHint('无法开始录音：' + errorMessage(error, '请检查麦克风是否可用'));
      }
      setStatus('idle');
    }
  };

  const stopRecording = () => {
    if (recordCapTimerRef.current) {
      clearTimeout(recordCapTimerRef.current);
      recordCapTimerRef.current = null;
    }
    if (mediaRecorderRef.current && statusRef.current === 'recording') {
      log('[Pet] 停止录音');
      mediaRecorderRef.current.stop();
    }
  };

  // ---------- 截图分析 ----------
  // 旧实现先弹「📸 截图完成」再请求，且只截图不分析（菜单却写“截图分析”）——
  // 两处都违反合同：成功提示必须在 await 返回后，动作名必须与结果一致。
  const captureAndAnalyzeScreen = async () => {
    log('[Pet] 开始截图分析...');
    setContextMenu((prev) => ({ ...prev, show: false }));
    setStatus('thinking');
    flashHint('正在分析屏幕…', 8000);
    try {
      const result = await window.electronAPI?.captureAndAnalyze();
      if (result?.success && result.analysis) {
        log('[Pet] 截图分析完成');
        setLastMessage(result.analysis);
        flashHint('截图分析完成');
      } else {
        const reason = result?.error || '截图或视觉模型不可用';
        log('[Pet] 截图分析失败: ' + reason);
        flashHint('截图分析失败：' + reason, 6000);
      }
    } catch (error) {
      log('[Pet] 截图分析异常: ' + errorMessage(error, '未知错误'));
      flashHint('截图分析失败：' + errorMessage(error, '主进程无响应'), 6000);
    } finally {
      setStatus('idle');
    }
  };

  // ---------- 语音识别 -> 对话 -> TTS ----------
  const processAudio = async (audioBlob: Blob) => {
    setStatus('thinking');
    const reader = new FileReader();
    reader.onerror = () => {
      log('[Pet] 读取录音失败');
      flashHint('读取录音失败，请重新录音');
      setStatus('idle');
    };
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      log('[Pet] 发送音频到 STT...');
      try {
        // 经主进程代理，渲染端不再直连 8084（T2.6）
        const data = await window.electronAPI?.voiceTranscribe(base64);
        log('[Pet] STT 响应: ' + JSON.stringify(data));
        if (data?.success && data.text) {
          await handleVoiceInput(data.text);
        } else {
          // 合同二/六：失败必须看得见，不能只写日志然后回到待机
          const reason = data?.error
            ? data.error
            : data
              ? '没有听清，请再说一次'
              : '语音服务无响应';
          log('[Pet] 语音识别失败: ' + reason);
          flashHint('语音识别失败：' + reason, 6000);
          setStatus('idle');
        }
      } catch (error) {
        log('[Pet] STT 错误: ' + errorMessage(error, '未知错误'));
        flashHint('语音识别失败：' + errorMessage(error, '请检查本地语音模型'), 6000);
        setStatus('idle');
      }
    };
    reader.readAsDataURL(audioBlob);
  };

  const handleVoiceInput = async (text: string) => {
    if (!text.trim()) {
      flashHint('没有识别到文字，请再说一次');
      setStatus('idle');
      return;
    }
    setStatus('thinking');
    setLastMessage('');
    const emotionSuffix = buildEmotionPromptSuffix(currentEmotion);
    try {
      log('[Pet] 请求 AI 回复（流式）...');
      // 流式：首字直接落到气泡，工具与确认仍在主进程 ai:streamChat 内完成（T3.7/T3.8）
      streamBufRef.current = '';
      streamActiveRef.current = true;
      const response = await window.electronAPI?.aiStreamChat({
        messages: [
          { role: 'system', content: config.systemPrompt + emotionSuffix },
          { role: 'user', content: text },
        ],
        model: config.modelName,
        stream: true,
      });
      if (!response) {
        log('[Pet] AI 无响应');
        flashHint('对话失败：AI 服务无响应', 6000);
        setStatus('idle');
        return;
      }
      const reply = response.content || streamBufRef.current || '抱歉，我无法理解您的问题。';
      log('[Pet] AI 响应: ' + reply.slice(0, 50));
      setLastMessage(reply);

      // 根据AI回复更新情绪
      const newEmotion = resolveEmotion(petStats, reply);
      setCurrentEmotion(newEmotion);

      // 播放TTS并启动打断监听
      await speakWithInterrupt(reply);
    } catch (error) {
      log('[Pet] 对话失败: ' + errorMessage(error, '未知错误'));
      flashHint('对话失败：' + errorMessage(error, 'AI 服务无响应'), 6000);
      setStatus('idle');
    } finally {
      // 无论成功/失败/提前 return，都必须摘掉流式归属，避免后续 chunk 写进旧气泡
      streamActiveRef.current = false;
    }
  };

  const speakWithInterrupt = async (text: string) => {
    setStatus('speaking');
    isSpeakingRef.current = true;

    try {
      // 主进程代理本地 TTS，音频不再经过任何远端服务（T2.5/T2.1）
      const ttsData = await window.electronAPI?.voiceSpeak(text);
      if (ttsData?.success && ttsData.audio) {
        const audio = new Audio(`data:audio/${ttsData.format || 'mp3'};base64,${ttsData.audio}`);
        currentAudioRef.current = audio;

        audio.onended = () => {
          log('[Pet] TTS 播放完成');
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          stopInterruptListener();
          setStatus('idle');
        };

        audio.onerror = () => {
          log('[Pet] TTS 播放错误');
          flashHint('语音播放失败，文字回复已保留');
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          stopInterruptListener();
          setStatus('idle');
        };

        await audio.play();
        startInterruptListener();
      } else {
        const reason = ttsData?.error || '语音合成不可用';
        log('[Pet] TTS 失败: ' + reason);
        flashHint('语音播放失败（' + reason + '），文字回复已保留', 5000);
        isSpeakingRef.current = false;
        setStatus('idle');
      }
    } catch (error) {
      log('[Pet] TTS 异常: ' + errorMessage(error, '未知错误'));
      flashHint('语音播放失败，文字回复已保留');
      isSpeakingRef.current = false;
      stopInterruptListener();
      setStatus('idle');
    }
  };

  // ---------- 交互 ----------
  const toggleMode = () => {
    const api = window.electronAPI;
    if (!api) {
      flashHint('管理端通道不可用 · 仅本地动画');
      return;
    }
    api.toggleWindow('admin').catch((error) => {
      log('[Pet] 打开管理端失败: ' + errorMessage(error, '主进程无响应'));
      flashHint('打开管理端失败：' + errorMessage(error, '主进程无响应'));
    });
  };

  // ---------- 陪伴层：她说的话怎么落到界面上 ----------
  /**
   * 她开口说话。cue 决定这一句配什么表情、什么动作、停多久。
   *
   * 三条约定：
   * - 新话出口时清掉上一条 AI 回复，否则旧回答会一直占着气泡，自言自语永远看不见；
   * - 停留时长按字数算（3.5s + 每字 0.22s），短句一闪而过等于没说；
   * - 情绪是**临时**的，不改 petStats，下一次 refreshStats 会按真实数值纠正回来。
   */
  const handleCompanionSay = useCallback((text: string, cue: SceneCue) => {
    if (!text) return;
    setLastMessage('');
    setCompanionSay({ text, nonce: Date.now() });

    if (cue.emotion) setCurrentEmotion(cue.emotion);
    if (cue.anim) triggerAnimationRef.current?.(cue.anim, 'user');
    if (cue.hearts) spawnHeartsRef.current?.();
    if (cue.sfx === 'levelup' && soundOnRef.current) playLevelUp();

    if (sayTimerRef.current) clearTimeout(sayTimerRef.current);
    const ms = cue.ms ?? Math.min(12_000, 3_500 + text.length * 220);
    sayTimerRef.current = setTimeout(() => {
      sayTimerRef.current = null;
      setCompanionSay(null);
      // 情绪跟着这句话走，说完退回「她真实的状态」——否则被摸一下之后会一直挂着害羞脸
      setCurrentEmotion(resolveEmotion(petStatsRef.current));
    }, ms);
  }, []);

  // ---------- 手势分层 ----------
  // 单击 = 摸头（可连击）、长按 = 说话、拖拽 = 挣扎着被搬走、滚轮 = 缩放立绘。
  // 原来的单击直接开麦，等于把最重的功能挂在最容易被误触的手势上。
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 正在飞行中又被抓住 ⇒ 物理立刻让位。不取消的话 rAF 会继续推窗口，
    // 出现「手已经按住了，她还在自己往下滑」的打架。
    stopPhysics();
    // 用户碰她 = 脚本让位：不打断的话她自己的动作会在两秒后顶掉刚回的话
    autonomyRef.current?.interrupt();
    const p = pressRef.current;
    p.downAt = Date.now();
    p.recording = false;
    p.moved = false;
    p.x = e.screenX;
    p.y = e.screenY;

    dragStateRef.current = { dragging: true, startX: e.screenX, startY: e.screenY, samples: [] };
    // 音频上下文必须在用户手势里解锁，否则第一个音（通常是摸头）会被 WebView 静默吞掉
    if (soundOnRef.current) resumeAudio();

    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      p.timer = null;
      // 按住不动才说话：松手即结束，和语音助手「按住说话」的心智一致
      if (statusRef.current !== 'idle' && statusRef.current !== 'interrupted') return;
      p.recording = true;
      log('[Pet] 长按说话');
      void startRecording();
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = () => {
    const p = pressRef.current;
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    if (p.recording) {
      p.recording = false;
      stopRecording();
      return;
    }
    // 拖过就不算点：谁也不会想在挪窗之后被记一次摸头
    if (p.moved) return;
    if (Date.now() - p.downAt >= LONG_PRESS_MS) return;
    if (statusRef.current !== 'idle') {
      // 非 idle 时点她的语义保持原样：说话中是打断，录音中是结束（托盘/P 键起录时走这条）
      if (statusRef.current === 'speaking') handleInterrupt();
      else if (statusRef.current === 'recording') stopRecording();
      return;
    }
    const result = companionRef.current?.poke();
    if (result?.report) void handlePetActionRef.current?.('pet');
    // 摸头音跟着连击走：第一下、第三下音调递进，第六下（傲娇拒绝）换成下滑音。
    // scene 比 comboCount 更适合作输入 —— 引擎已经把分档算好了，这里不重复一遍阈值。
    if (soundOnRef.current && result) {
      if (result.scene === 'pet6') playPet('reject');
      else if (result.scene === 'pet3') playPet(3);
      else playPet(1);
    }
  };
  finishPressRef.current = handlePointerUp;

  const spawnHearts = useCallback(() => {
    setHearts([Date.now(), Date.now() + 100, Date.now() + 200]);
    setTimeout(() => setHearts([]), 2000);
  }, []);
  // ref 转发：让早于本函数声明的闭包（handlePetAction）能调到最新实现
  spawnHeartsRef.current = spawnHearts;

  /** 滚轮缩放立绘：手势比菜单快，且不打断任何正在播的动画（只改 .char-look 的 scale） */
  const handleWheel = (e: React.WheelEvent) => {
    if (contextMenu.show) return;
    const next = clampScale(petScaleRef.current - e.deltaY * 0.0012);
    if (next === petScaleRef.current) return;
    setPetScale(next);
    localStorage.setItem(SCALE_KEY, String(next));
  };

  const focusMinutesOf = () => companionRef.current?.getConfig().focusMinutes ?? DEFAULT_CFG.focusMinutes;

  const startFocus = (minutes?: number) => {
    companionRef.current?.startFocus(minutes ?? focusMinutesOf());
    setContextMenu((prev) => ({ ...prev, show: false }));
    flashHint(`专注 ${minutes ?? focusMinutesOf()} 分钟 · 期间不打扰`, 3000);
  };

  const endFocus = () => {
    companionRef.current?.stopFocus('user');
    setContextMenu((prev) => ({ ...prev, show: false }));
  };

  /** 陪伴开关落盘在 localStorage（与场景设置同一套约定），不进 config.json */
  const patchCompanionCfg = (patch: Partial<typeof DEFAULT_CFG>) => {
    const next = companionRef.current?.updateConfig(patch) ?? { ...companionCfg, ...patch };
    setCompanionCfg(next);
  };

  // 宠物互动动作：调用养成 IPC 后刷新状态与情绪
  const handlePetAction = useCallback(async (action: string) => {
    const api = window.electronAPI;
    if (!api) return;
    const call: Record<string, () => Promise<any>> = {
      feed: () => api.petFeed(),
      play: () => api.petPlay(),
      wash: () => api.petWash(),
      sleep: () => api.petSleep(),
      medicine: () => api.petMedicine(),
      pet: () => api.petPet(),
    };
    const fn = call[action];
    if (!fn) {
      log('[Pet] 未知养成动作: ' + action);
      return;
    }
    try {
      const stats = await fn();
      if (stats) {
        setPetStats(stats as PetCoreStats);
        // 抚摸的情绪由陪伴层按连击档位接管（害羞/傲娇），这里再覆盖一次会把它冲掉
        if (action !== 'pet') setCurrentEmotion(resolveEmotion(stats as PetCoreStats));
      }
      if (action === 'play' || action === 'pet') spawnHeartsRef.current?.();
    } catch (error) {
      log('[Pet] 养成动作失败 (' + action + '): ' + errorMessage(error, '未知错误'));
      // 摸头是最轻、最高频的互动：失败时如果每次都弹一条大字号 toast，
      // 点十下就弹十次，陪伴感立刻变成故障感。只留日志 + 半分钟最多一句轻提示。
      if (action === 'pet') {
        const now = Date.now();
        if (now - petErrorHintRef.current > 30_000) {
          petErrorHintRef.current = now;
          flashHint('摸到了，但养成系统没响应', 2200);
        }
        return;
      }
      flashHint('互动失败：' + errorMessage(error, '主进程无响应'));
    }
  }, [flashHint]);
  handlePetActionRef.current = handlePetAction;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    companionRef.current?.noteInteraction();
    // 268×512 的窗放不下从点击点向下展开的整份菜单：先按菜单尺寸夹进视口。
    // 菜单加了专注/照顾/陪伴设置三组后本来就接近满高，所以样式里配了滚动兜底。
    const { x, y } = clampMenuPosition(
      e.clientX,
      e.clientY,
      { width: window.innerWidth, height: window.innerHeight },
      { width: 196, height: 500 }
    );
    setContextMenu({ x, y, show: true });
  };

  const handleClickOutside = () => {
    setContextMenu((prev) => ({ ...prev, show: false }));
    setAnimMenuOpen(false);
    setSkinMenuOpen(false);
    setCareMenuOpen(false);
    setCompanionMenuOpen(false);
  };

  const handleAnimSelect = (anim: AnimationType) => {
    if (anim === 'chase') {
      // 位置取自主进程推送的最新鼠标偏移，不再同步拉取 IPC
      const { dx, dy } = cursorDeltaRef.current;
      triggerAnimation('chase', 'user');
      window.electronAPI?.movePetWindow(dx, dy);
    } else {
      triggerAnimation(anim, 'user');
    }
    setContextMenu({ ...contextMenu, show: false });
    setAnimMenuOpen(false);
  };

  const handleSkinSelect = (skin: PetSkin) => {
    selectCharacter(skin.id);
    setContextMenu({ ...contextMenu, show: false });
    setSkinMenuOpen(false);
  };

  // ---------- 拖拽移动 ----------
  // 拖拽不是「搬运一个窗口」，是她被拎起来了：飘一下、扭两下，再被放下。
  // 反应要节流到 4 秒一次 —— 否则一路拖过去她会像触电一样抖个不停。
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragStateRef.current.dragging) return;
    const dx = e.screenX - dragStateRef.current.startX;
    const dy = e.screenY - dragStateRef.current.startY;
    dragStateRef.current.startX = e.screenX;
    dragStateRef.current.startY = e.screenY;

    const p = pressRef.current;
    if (!p.moved && Math.abs(e.screenX - p.x) + Math.abs(e.screenY - p.y) > DRAG_SLOP) {
      p.moved = true;
      // 已经确定是拖拽，就别再等长按说话了
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
      const now = Date.now();
      if (now - lastStruggleAtRef.current > 4000) {
        lastStruggleAtRef.current = now;
        triggerAnimationRef.current?.('wiggle', 'user');
        setCurrentEmotion('tsundere');
        companionRef.current?.noteInteraction();
      }
    }

    // 采样指针位置，供松手时估算「甩出去」的速度。
    // 只保留最近 RELEASE_WINDOW_MS 毫秒的点：更早的采样反映的是上一段拖拽，
    // 混进来会把速度平均得过低，导致明明甩了却不抛。
    const samples = dragStateRef.current.samples;
    samples.push({ x: e.screenX, y: e.screenY, t: performance.now() });
    const cutoff = performance.now() - RELEASE_WINDOW_MS;
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift();

    window.electronAPI?.movePetWindow(dx, dy);
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!dragStateRef.current.dragging) return;
    dragStateRef.current.dragging = false;
    // 只有真的拖动过才处理松手。单击现在是「摸头」，如果每次摸头都走一遍贴边判断，
    // 站在左边缘但悬在半空中的她会被一下一下地拽到屏幕底部。
    if (!pressRef.current.moved) {
      dragStateRef.current.samples = [];
      return;
    }

    const velocity = estimateReleaseVelocity(dragStateRef.current.samples);
    dragStateRef.current.samples = [];

    if (shouldThrow(velocity)) {
      // 甩出去 → 抛掷物理接管，她会真的落下来、弹几下、滑一小段
      void launchPhysics(velocity);
    } else {
      // 轻轻挪一下就放 → 保持旧行为，直接贴边
      window.electronAPI?.stickToEdge?.();
    }
  }, [launchPhysics]);

  // ---------- 陪伴引擎 ----------
  // 引擎不依赖 React：它每秒被 tick 一次，需要什么就通过 getter 现取（读的都是 ref，
  // 天然拿到最新值）。这样它也永远不会因为某次 re-render 而拿到过期闭包。
  useEffect(() => {
    const engine = new CompanionEngine({
      say: handleCompanionSay,
      getStatus: () => statusRef.current,
      getStats: () => petStatsRef.current,
      getCharacter: () => ({ id: currentSkinRef.current.id, name: petNameRef.current }),
      flash: flashHint,
    });
    companionRef.current = engine;
    setCompanionCfg(engine.getConfig());

    // 启动问候：错开一点，别跟入场动画抢同一帧
    engine.greetOnStart();

    const timer = setInterval(() => {
      engine.tick();
      const snap = engine.getSnapshot();
      // 只在「看得见的东西变了」时才 setState：否则每秒一次重渲染会把粒子层也带着跑
      setCompanionSnap((prev) =>
        prev.mode === snap.mode &&
        prev.paused === snap.paused &&
        Math.ceil(prev.remainMs / 1000) === Math.ceil(snap.remainMs / 1000) &&
        prev.stat.pets === snap.stat.pets &&
        prev.stat.focusDone === snap.stat.focusDone &&
        prev.stat.focusMinutes === snap.stat.focusMinutes
          ? prev
          : snap
      );
    }, 1000);

    return () => {
      clearInterval(timer);
      engine.dispose();
      companionRef.current = null;
      if (sayTimerRef.current) {
        clearTimeout(sayTimerRef.current);
        sayTimerRef.current = null;
      }
    };
  }, [handleCompanionSay, flashHint]);

  // ---------- 自主行为导演 ----------
  /**
   * 她「自己演」的出口。和陪伴引擎共用同一个气泡/动画通道，所以不会互相顶掉：
   * 陪伴引擎负责"该提醒了"，导演负责"这段时间她在干嘛"。
   *
   * 空文本是合法输入 —— 脚本里很多步是纯动作（走过去、探头、缩回去），
   * 那些步骤不该让气泡闪一下，但动画必须播。
   */
  const handleAutonomyCue = useCallback(
    (text: string, cue: SayCue) => {
      if (text) {
        handleCompanionSay(text, { anim: cue.anim, emotion: cue.emotion, ms: cue.ms });
        return;
      }
      if (cue.anim) triggerAnimationRef.current?.(cue.anim, 'idle');
      if (cue.emotion) setCurrentEmotion(cue.emotion);
    },
    [handleCompanionSay]
  );

  useEffect(() => {
    const director = new AutonomyDirector(
      {
        say: handleAutonomyCue,
        getStatus: () => statusRef.current,
        getState: () => {
          const snap = companionRef.current?.getSnapshot();
          const s = petStatsRef.current;
          return snapshotForMind({
            idleMs: snap?.idleMs ?? 0,
            mode: snap?.mode ?? 'normal',
            focusMinutes: snap?.stat.focusMinutes ?? 0,
            affection: s.affection,
            energy: s.energy,
          });
        },
        log,
      },
      autonomyCfg
    );
    autonomyRef.current = director;
    setAutonomyCfg(director.getConfig());
    director.start();

    return () => {
      director.stop();
      autonomyRef.current = null;
    };
    // autonomyCfg 只在初始化时读一次：之后由 updateConfig 推给导演，
    // 放进依赖会让每次改设置都重建导演、重置她的节奏
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleAutonomyCue]);

  const patchAutonomyCfg = useCallback((patch: Partial<AutonomyConfig>) => {
    const next = autonomyRef.current?.updateConfig(patch) ?? { ...DEFAULT_AUTONOMY, ...patch };
    setAutonomyCfg(next);
    if (patch.enabled === false) flashHint('她已经安静下来了', 2200);
    if (patch.enabled === true) flashHint('她会自己找点事做了', 2200);
  }, [flashHint]);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    const onUp = () => {
      handleMouseUp();
      finishPressRef.current?.();
    };
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!contextMenu.show) return;
    const handler = () => handleClickOutside();
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu.show]);

  // AI 的回复也要有保质期：不设的话上一轮回答会永远挂在气泡里，
  // 她后来主动说的话就永远没机会出现在同一个位置 —— 看着像她不说话了。
  useEffect(() => {
    if (!lastMessage) return;
    const t = setTimeout(() => setLastMessage(''), 45_000);
    return () => clearTimeout(t);
  }, [lastMessage]);

  // ---------- 气泡文案 ----------
  // 一处收敛「现在在干什么」，优先级从硬到软：
  //   对话状态 > AI 的回复 > 她主动说的话 > 角色问候语
  // 她主动说的话排在 AI 回复之前是因为 handleCompanionSay 会清空 lastMessage ——
  // 新话出口，旧回答就该让位，否则气泡会一直卡在上一轮回答上不再变化。
  const showMessage = status === 'idle' && !!lastMessage;
  // 打字机只吃「她说的话」。状态文案走 STATUS_TEXT 原样瞬间出 —— 那是系统状态，
  // 慢半拍会被当成卡死。
  // spokenText 刻意不跟着 status 走：录音/思考那几秒气泡被 STATUS_TEXT 占着，
  // 但台词本身没变；若在这里一起清空，每次说完话切回 idle 都会把上一条
  // 已经读过的回答重新打一遍。文案真变了（新回答/新台词）自然会触发重打。
  // retrigger 用 companionSay.nonce：同一句话连说两遍，文案没变也要重打一次，
  // 否则第二次出场是凭空整段蹦出来的。
  const spokenText = lastMessage || companionSay?.text || persona.greeting;
  const typedSpoken = useTypewriter(spokenText, companionSay?.nonce ?? 'msg');
  const bubbleText = status !== 'idle' ? STATUS_TEXT[status] : typedSpoken;

  // 属性告急 ⇒ 露出快捷动作（和以前一样的触发条件）
  const needsCare =
    petStats.hunger < 60 ||
    petStats.happiness < 60 ||
    petStats.cleanliness < 60 ||
    petStats.isSick ||
    (!petStats.isSleeping && petStats.energy < 50);

  const stageScale = STAGE_SCALE[petStats.stage] ?? 1;
  const displayName = config.petName?.trim() || persona.name;

  // 专注钟：名牌上的那颗胶囊显示倒计时，点它暂停/继续
  const focusing = companionSnap.mode === 'focus' && companionSnap.remainMs > 0;
  const remainSec = Math.max(0, Math.ceil(companionSnap.remainMs / 1000));
  const focusClock = `${String(Math.floor(remainSec / 60)).padStart(2, '0')}:${String(remainSec % 60).padStart(2, '0')}`;

  // 自定义变量只能按 CSSProperties 断言进 style：TS 的 CSSProperties 不认识 --x
  const rootStyle = {
    ...skinVars,
    '--aura-color': persona.glow,
    '--scene-color': withAlpha(currentScenery.particleColor || '#8aa0c0', 0.22),
  } as React.CSSProperties;

  return (
    <div
      className={`pet-root ${EMOTION_CONFIGS[currentEmotion].cssClass} ${
        petStats.isSick ? 'pet-sick' : ''
      }`}
      style={rootStyle}
      onPointerDown={handlePointerDown}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setShowHUD(true)}
      onMouseLeave={() => setShowHUD(false)}
    >
      {/* 场景氛围光（管理端的场景配色落在这里）+ 角色自己的轮廓光 */}
      <div className="aura ambient" />
      <div className="aura" />
      <div className="ground-shadow" />

      {/* 场景粒子：particleEnabled 关闭时完全不渲染，避免常驻动画占合成开销 */}
      {config.particleEnabled && (
        <div className="particle-layer">
          {particleLayouts.map((layout, idx) => (
            <div key={`${layout.id}-${idx}`} className={`particle ${layout.type}`} style={layout.style}>
              {layout.type === 'mote' ? null : layout.content}
            </div>
          ))}
        </div>
      )}

      {/* 立绘：stage 承接动画系统的 transform，breathe 管呼吸，look 管跟随。
          成长缩放放在 look 上 —— CSS 动画会覆盖同一元素的 transform，
          写在外层 stage 上的 scale 会被 animIdle 顶掉，只在静止时才生效。 */}
      <div className="char-stage" style={{ animation: animationCSS }}>
        <div className="char-breathe">
          <div
            className="char-look"
            style={{
              transform: `translate(${cursorLean.x}px, ${cursorLean.y}px) scale(${(stageScale * petScale).toFixed(3)})`,
            }}
          >
            <img className="char-img" src={currentSkin.portrait} alt={persona.name} draggable={false} />
          </div>

          {status === 'thinking' && <div className="ring ring-thinking" />}
          {status === 'recording' && <div className="ring ring-recording" />}
          {status === 'speaking' && (
            <div className="sound-waves">
              <span />
              <span />
              <span />
            </div>
          )}
          {status === 'interrupted' && <div className="interrupt-flash" />}

          {hearts.map((id, i) => (
            <div key={id} className="heart-particle" style={{ left: 60 + i * 34, animationDelay: `${i * 0.15}s` }}>
              💕
            </div>
          ))}

          {zzzVisible && (
            <div className="zzz-container">
              <span className="zzz" style={{ animationDelay: '0s' }}>Z</span>
              <span className="zzz" style={{ animationDelay: '0.6s', fontSize: 13 }}>z</span>
              <span className="zzz" style={{ animationDelay: '1.2s', fontSize: 11 }}>z</span>
            </div>
          )}
        </div>
      </div>

      {/* 对话气泡 */}
      {bubbleText && (
        <div
          className={`bubble ${showMessage ? 'is-message' : ''} ${
            !showMessage && status === 'idle' && companionSay ? 'is-say' : ''
          } ${status === 'thinking' ? 'is-thinking' : ''}`}
          title={showMessage ? lastMessage : undefined}
          key={showMessage ? 'msg' : companionSay ? `say-${companionSay.nonce}` : status}
        >
          {bubbleText}
          {status === 'thinking' && (
            <span className="dots">
              <i /><i /><i />
            </span>
          )}
        </div>
      )}

      {hint && <div className="toast">{hint}</div>}

      {micGuide && (
        <div className="mic-guide">
          <div>需要麦克风权限才能语音对话</div>
          <div className="sub">系统设置 → 隐私与安全性 → 麦克风 → 允许 zBiz 看板娘</div>
          <div className="row">
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await window.electronAPI?.checkMicrophone();
                if (ok !== false) {
                  setMicGuide(false);
                  startRecording();
                }
              }}
            >
              重试授权
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMicGuide(false);
              }}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {/* 底部：快捷动作 / HUD / 名牌 */}
      <div
        className="dock"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {status === 'idle' && needsCare && (
          <div className="actions">
            {petStats.hunger < 60 && (
              <button className="action-btn" aria-label="喂食" title="喂食" onClick={() => handlePetAction('feed')}>🍖</button>
            )}
            {petStats.happiness < 60 && (
              <button className="action-btn" aria-label="玩耍" title="玩耍" onClick={() => handlePetAction('play')}>🎮</button>
            )}
            {petStats.cleanliness < 60 && (
              <button className="action-btn" aria-label="洗澡" title="洗澡" onClick={() => handlePetAction('wash')}>🛁</button>
            )}
            {!petStats.isSleeping && petStats.energy < 50 && (
              <button className="action-btn" aria-label="睡觉" title="睡觉" onClick={() => handlePetAction('sleep')}>💤</button>
            )}
            {petStats.isSick && (
              <button className="action-btn" aria-label="治疗" title="治疗" onClick={() => handlePetAction('medicine')}>💊</button>
            )}
          </div>
        )}

        {showHUD && !contextMenu.show && (
          <div className="hud">
            <div className="hud-grid">
              {STAT_BARS.map(({ key, label, icon, color }) => {
                const value = petStats[key] as number;
                return (
                  <div key={key} className="hud-row">
                    <span className="hud-icon">{icon}</span>
                    <span className="hud-label">{label}</span>
                    <div className="hud-bar-bg">
                      <div className="hud-bar-fill" style={{ width: `${value}%`, background: color }} />
                    </div>
                    <span className="hud-value">{Math.round(value)}</span>
                  </div>
                );
              })}
            </div>
            <div className="hud-foot">
              <span>好感 <b>{Math.round(petStats.affection)}</b></span>
              <span>阶段 <b>{STAGE_LABEL[petStats.stage] ?? petStats.stage}</b></span>
              <span><b>{petStats.age}</b> 天</span>
            </div>
          </div>
        )}

        <div
          className="plate"
          onClick={toggleMode}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          title="打开管理端"
        >
          {currentSkin.face ? (
            <img className="plate-face" src={currentSkin.face} alt={persona.name} draggable={false} />
          ) : (
            <span className="skin-dot" style={{ background: currentSkin.colors.bodyLight, width: 32, height: 32 }} />
          )}
          <div className="plate-meta">
            <span className="plate-name">{displayName}</span>
            <span className="plate-role">{focusing ? `专注中 · ${focusClock}` : persona.role}</span>
          </div>
          {focusing ? (
            <button
              className={`focus-pill ${companionSnap.paused ? 'is-paused' : ''}`}
              aria-label={companionSnap.paused ? '继续专注' : '暂停专注'}
              title={companionSnap.paused ? '继续专注' : '暂停专注'}
              onClick={(e) => {
                e.stopPropagation();
                companionRef.current?.toggleFocusPause();
              }}
            >
              {companionSnap.paused ? '▶' : '❚❚'}
            </button>
          ) : (
            <span className="emotion-chip">{EMOTION_CONFIGS[currentEmotion].toneModifier}</span>
          )}
          <button
            className="plate-gear"
            aria-label="管理端"
            title="管理端"
            onClick={(e) => {
              e.stopPropagation();
              toggleMode();
            }}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu.show && (
        <div
          className="context-menu"
          role="menu"
          aria-label="看板娘右键菜单"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="menu-item" onClick={captureAndAnalyzeScreen}>📸 截图分析</div>
          <div
            className="menu-item"
            onClick={() => {
              companionRef.current?.chat();
              setContextMenu((prev) => ({ ...prev, show: false }));
            }}
          >
            💬 陪我一会儿
          </div>

          <div className="menu-separator" />
          <div className="menu-section-label">专注</div>
          {focusing ? (
            <>
              <div
                className="menu-item"
                onClick={() => {
                  companionRef.current?.toggleFocusPause();
                  setContextMenu((prev) => ({ ...prev, show: false }));
                }}
              >
                {companionSnap.paused ? '▶ 继续专注' : '❚❚ 暂停专注'} · {focusClock}
              </div>
              <div className="menu-item" onClick={endFocus}>⏹ 结束专注</div>
            </>
          ) : (
            <>
              <div className="menu-item" onClick={() => startFocus(25)}>⏱ 专注 25 分钟</div>
              <div className="menu-item" onClick={() => startFocus(50)}>⏱ 专注 50 分钟</div>
            </>
          )}

          <div className="menu-separator" />
          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setCareMenuOpen(true)}
            onMouseLeave={() => setCareMenuOpen(false)}
          >
            <span>🍖 照顾</span>
            {careMenuOpen && (
              <div className="submenu">
                <div className="submenu-item" onClick={() => { handlePetAction('feed'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
                  🍖 喂食 <span className="role">饱食+30</span>
                </div>
                <div className="submenu-item" onClick={() => { handlePetAction('play'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
                  🎮 玩耍 <span className="role">快乐+20</span>
                </div>
                <div className="submenu-item" onClick={() => { handlePetAction('wash'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
                  🛁 洗澡 <span className="role">清洁+40</span>
                </div>
                <div className="submenu-item" onClick={() => { handlePetAction('sleep'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
                  💤 {petStats.isSleeping ? '叫醒' : '睡觉'}
                </div>
                <div className="submenu-item" onClick={() => { handlePetAction('medicine'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
                  💊 治疗 <span className="role">健康+30</span>
                </div>
                <div className="submenu-item" onClick={() => { handlePetAction('pet'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
                  🤚 抚摸 <span className="role">好感+1</span>
                </div>
              </div>
            )}
          </div>

          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setSkinMenuOpen(true)}
            onMouseLeave={() => setSkinMenuOpen(false)}
          >
            <span>🎀 换角色</span>
            {skinMenuOpen && (
              <div className="submenu">
                {CHARACTER_SKINS.map((skin) => (
                  <div
                    key={skin.id}
                    className={`submenu-item ${currentSkin.id === skin.id ? 'active' : ''}`}
                    onClick={() => handleSkinSelect(skin)}
                  >
                    {skin.face && <img className="menu-face" src={skin.face} alt="" draggable={false} />}
                    <span>{skin.name}</span>
                    <span className="role">{skin.role?.split(' · ')[0]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setAnimMenuOpen(true)}
            onMouseLeave={() => setAnimMenuOpen(false)}
          >
            <span>🎭 动作</span>
            {animMenuOpen && (
              <div className="submenu">
                {ANIMATION_MENU_ITEMS.map((item) => (
                  <div key={item.value} className="submenu-item" onClick={() => handleAnimSelect(item.value)}>
                    {item.label}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="menu-item"
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              if (next) {
                // 立刻给一声确认音：否则用户点了「打开声音」却什么都听不到，
                // 会以为开关没生效（AudioContext 还没解锁时第一声可能出不来）
                resumeAudio();
                playPing();
              }
              setContextMenu((prev) => ({ ...prev, show: false }));
            }}
          >
            {soundOn ? '🔊 音效' : '🔇 音效（已关）'}
          </div>

          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setCompanionMenuOpen(true)}
            onMouseLeave={() => setCompanionMenuOpen(false)}
          >
            <span>🔔 陪伴设置</span>
            {companionMenuOpen && (
              <div className="submenu">
                <div
                  className={`submenu-item ${companionCfg.idleChat ? 'active' : ''}`}
                  onClick={() => patchCompanionCfg({ idleChat: !companionCfg.idleChat })}
                >
                  {companionCfg.idleChat ? '✓' : '　'} 自言自语
                </div>
                <div
                  className={`submenu-item ${companionCfg.care ? 'active' : ''}`}
                  onClick={() => patchCompanionCfg({ care: !companionCfg.care })}
                >
                  {companionCfg.care ? '✓' : '　'} 健康提醒
                </div>
                <div
                  className={`submenu-item ${companionCfg.focusMinutes === 25 ? 'active' : ''}`}
                  onClick={() => patchCompanionCfg({ focusMinutes: 25 })}
                >
                  {companionCfg.focusMinutes === 25 ? '✓' : '　'} 默认专注 25 分钟
                </div>
                <div
                  className={`submenu-item ${companionCfg.focusMinutes === 50 ? 'active' : ''}`}
                  onClick={() => patchCompanionCfg({ focusMinutes: 50 })}
                >
                  {companionCfg.focusMinutes === 50 ? '✓' : '　'} 默认专注 50 分钟
                </div>
                <div
                  className={`submenu-item ${autonomyCfg.enabled ? 'active' : ''}`}
                  onClick={() => patchAutonomyCfg({ enabled: !autonomyCfg.enabled })}
                >
                  {autonomyCfg.enabled ? '✓' : '　'} 自己活动（会想事情）
                </div>
                <div
                  className="submenu-item"
                  onClick={() => {
                    setPetScale(1);
                    localStorage.setItem(SCALE_KEY, '1');
                    flashHint('立绘已恢复原大小', 2200);
                  }}
                >
                  ⤢ 重置缩放 ({Math.round(petScale * 100)}%)
                </div>
              </div>
            )}
          </div>

          <div className="menu-separator" />
          <div className="menu-item" onClick={() => { triggerAnimation('idle', 'user'); setContextMenu((prev) => ({ ...prev, show: false })); }}>
            🏠 回到待机
          </div>
          <div className="menu-item" onClick={() => { toggleMode(); setContextMenu((prev) => ({ ...prev, show: false })); }}>
            ⚙ 打开管理端
          </div>

          {/* 今日互动小结：让「陪伴」有积累感，而不是每次都是全新的一天 */}
          <div className="menu-foot">
            今天 · 摸头 {companionSnap.stat.pets} 次 · 专注 {companionSnap.stat.focusMinutes} 分钟
            {companionSnap.stat.focusDone > 0 ? `（${companionSnap.stat.focusDone} 次）` : ''}
          </div>
        </div>
      )}

      <style>{ANIMATION_KEYFRAMES}</style>
    </div>
  );
}

export default App;

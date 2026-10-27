import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AnimationType,
  ANIMATION_KEYFRAMES,
  ANIMATIONS,
  ANIMATION_MENU_ITEMS,
  getRandomIdleAnimation,
  getRandomIdleInterval,
  canInterruptAnimation,
  getAnimationCSS,
} from './animations';
import { PetSkin, getSkinCSSVariables } from '../shared/skins';
import {
  CHARACTERS,
  CHARACTER_SKINS,
  PERSONA_PROMPTS,
  characterOf,
  getSkinById,
} from './characters';
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
  const dragStateRef = useRef<{ dragging: boolean; startX: number; startY: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
  });
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
    idleTimerRef.current = setTimeout(() => {
      if (statusRef.current === 'idle' && currentAnimRef.current === 'idle') {
        const randomAnim = getRandomIdleAnimation();
        triggerAnimationRef.current?.(randomAnim, 'idle');
      }
    }, getRandomIdleInterval());
  }, []);
  // ref 转发：让早于本函数声明的闭包（triggerAnimation 内部）能调到最新实现
  startIdleSchedulerRef.current = startIdleScheduler;

  // 鼠标追踪改为消费主进程推送（T3.2）：渲染端不再有 100ms 轮询定时器
  const applyCursorDelta = useCallback((delta: { dx: number; dy: number }) => {
    cursorDeltaRef.current = delta;
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

  const handlePetClick = () => {
    if (status === 'idle') {
      startRecording();
    } else if (status === 'recording') {
      stopRecording();
    } else if (status === 'speaking') {
      handleInterrupt();
    }
  };

  const spawnHearts = useCallback(() => {
    setHearts([Date.now(), Date.now() + 100, Date.now() + 200]);
    setTimeout(() => setHearts([]), 2000);
  }, []);
  // ref 转发：让早于本函数声明的闭包（handlePetAction）能调到最新实现
  spawnHeartsRef.current = spawnHearts;

  const handleDoubleClick = () => {
    if (status !== 'idle') return;
    triggerAnimation('petted', 'user');
    spawnHearts();
    void handlePetAction('pet');
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
        setCurrentEmotion(resolveEmotion(stats as PetCoreStats));
      }
      if (action === 'play' || action === 'pet') spawnHeartsRef.current?.();
    } catch (error) {
      log('[Pet] 养成动作失败 (' + action + '): ' + errorMessage(error, '未知错误'));
      flashHint('互动失败：' + errorMessage(error, '主进程无响应'));
    }
  }, [flashHint]);
  handlePetActionRef.current = handlePetAction;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 268×512 的窗口放不下从点击点向下展开的整份菜单：先按菜单尺寸夹进视口
    const { x, y } = clampMenuPosition(
      e.clientX,
      e.clientY,
      { width: window.innerWidth, height: window.innerHeight },
      { width: 190, height: 470 }
    );
    setContextMenu({ x, y, show: true });
  };

  const handleClickOutside = () => {
    setContextMenu((prev) => ({ ...prev, show: false }));
    setAnimMenuOpen(false);
    setSkinMenuOpen(false);
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
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStateRef.current = { dragging: true, startX: e.screenX, startY: e.screenY };
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragStateRef.current.dragging) return;
    const dx = e.screenX - dragStateRef.current.startX;
    const dy = e.screenY - dragStateRef.current.startY;
    dragStateRef.current.startX = e.screenX;
    dragStateRef.current.startY = e.screenY;
    window.electronAPI?.movePetWindow(dx, dy);
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!dragStateRef.current.dragging) return;
    dragStateRef.current.dragging = false;
    window.electronAPI?.stickToEdge?.();
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!contextMenu.show) return;
    const handler = () => handleClickOutside();
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu.show]);

  // ---------- 气泡文案 ----------
  // 一处收敛所有「现在在干什么」：优先回报 AI 的话，其次回报状态。
  const showMessage = status === 'idle' && !!lastMessage;
  const bubbleText = showMessage
    ? lastMessage
    : status === 'idle'
      ? persona.greeting
      : STATUS_TEXT[status];

  // 属性告急 ⇒ 露出快捷动作（和以前一样的触发条件）
  const needsCare =
    petStats.hunger < 60 ||
    petStats.happiness < 60 ||
    petStats.cleanliness < 60 ||
    petStats.isSick ||
    (!petStats.isSleeping && petStats.energy < 50);

  const stageScale = STAGE_SCALE[petStats.stage] ?? 1;
  const displayName = config.petName?.trim() || persona.name;

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
      onMouseDown={handleMouseDown}
      onClick={handlePetClick}
      onDoubleClick={handleDoubleClick}
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
            style={{ transform: `translate(${cursorLean.x}px, ${cursorLean.y}px) scale(${stageScale})` }}
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
          className={`bubble ${showMessage ? 'is-message' : ''} ${status === 'thinking' ? 'is-thinking' : ''}`}
          title={showMessage ? lastMessage : undefined}
          key={showMessage ? 'msg' : status}
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
      <div className="dock" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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

        {showHUD && (
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

        <div className="plate" onClick={toggleMode} title="打开管理端">
          {currentSkin.face ? (
            <img className="plate-face" src={currentSkin.face} alt={persona.name} draggable={false} />
          ) : (
            <span className="skin-dot" style={{ background: currentSkin.colors.bodyLight, width: 32, height: 32 }} />
          )}
          <div className="plate-meta">
            <span className="plate-name">{displayName}</span>
            <span className="plate-role">{persona.role}</span>
          </div>
          <span className="emotion-chip">{EMOTION_CONFIGS[currentEmotion].toneModifier}</span>
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
        >
          <div className="menu-item" onClick={captureAndAnalyzeScreen}>📸 截图分析</div>
          <div className="menu-separator" />
          <div className="menu-section-label">宠物养成</div>
          <div className="menu-item" onClick={() => { handlePetAction('feed'); setContextMenu({ ...contextMenu, show: false }); }}>🍖 喂食 (饱食+30)</div>
          <div className="menu-item" onClick={() => { handlePetAction('play'); setContextMenu({ ...contextMenu, show: false }); }}>🎮 玩耍 (快乐+20)</div>
          <div className="menu-item" onClick={() => { handlePetAction('wash'); setContextMenu({ ...contextMenu, show: false }); }}>🛁 洗澡 (清洁+40)</div>
          <div className="menu-item" onClick={() => { handlePetAction('sleep'); setContextMenu({ ...contextMenu, show: false }); }}>💤 {petStats.isSleeping ? '起床' : '睡觉'}</div>
          <div className="menu-item" onClick={() => { handlePetAction('medicine'); setContextMenu({ ...contextMenu, show: false }); }}>💊 治疗 (健康+30)</div>
          <div className="menu-item" onClick={() => { handlePetAction('pet'); setContextMenu({ ...contextMenu, show: false }); }}>🤚 抚摸 (好感+1)</div>
          <div className="menu-separator" />
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
          <div className="menu-separator" />
          <div className="menu-item" onClick={() => { triggerAnimation('idle', 'user'); setContextMenu({ ...contextMenu, show: false }); }}>🏠 回到待机</div>
        </div>
      )}

      <style>{ANIMATION_KEYFRAMES}</style>
    </div>
  );
}

export default App;

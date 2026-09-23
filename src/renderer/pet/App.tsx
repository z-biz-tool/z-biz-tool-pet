import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AnimationType,
  ANIMATION_KEYFRAMES,
  ANIMATIONS,
  ANIMATION_MENU_ITEMS,
  getRandomIdleAnimation,
  getRandomIdleInterval,
  getRandomBlinkInterval,
  canInterruptAnimation,
  getAnimationCSS,
} from './animations';
import {
  PetSkin,
  PRESET_SKINS,
  getSkinById,
  getSkinCSSVariables,
} from '../shared/skins';
import {
  Emotion,
  PetStats as PetCoreStats,
  EMOTION_CONFIGS,
  resolveEmotion,
  buildEmotionPromptSuffix,
} from '../shared/emotions';
import './pet.css';

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

type PetStatus = 'idle' | 'recording' | 'thinking' | 'speaking' | 'interrupted';

const STATUS_TEXT: Record<PetStatus, string> = {
  idle: '点击和我说话~',
  recording: '🎤 录音中... 再次点击停止',
  thinking: '🤔 思考中...',
  speaking: '🔊 说话中... (可打断)',
  interrupted: '⚡ 被打断!',
};

const DEFAULT_OLLAMA = 'http://localhost:11434';
const DEFAULT_STT = 'http://localhost:8084';
const DEFAULT_TTS = 'http://localhost:8086';
const DEFAULT_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DEFAULT_PROMPT = '你是一只可爱的桌面萌宠小猫咪，名字叫Z-Bot。性格活泼可爱、温柔体贴，用简短温馨的语言回复。';

// 语音打断阈值（可配置，默认30）
const INTERRUPT_THRESHOLD = 30;

// 录音硬上限：MediaRecorder 的分片全在内存里，按住不放不该无限录（02 §2.4）
const MAX_RECORDING_MS = 30_000;

// 生命周期阶段对应的体型（此前 JSX 直接引用未定义的 STAGE_SIZES）
const STAGE_SIZES: Record<PetCoreStats['stage'], number> = {
  egg: 90,
  baby: 110,
  child: 125,
  adult: 140,
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

function App() {
  const [status, setStatus] = useState<PetStatus>('idle');
  const [lastMessage, setLastMessage] = useState('');
  const [hint, setHint] = useState('');
  const [config, setConfig] = useState({
    ollamaUrl: DEFAULT_OLLAMA,
    sttUrl: DEFAULT_STT,
    ttsUrl: DEFAULT_TTS,
    modelName: DEFAULT_MODEL,
    systemPrompt: DEFAULT_PROMPT,
    petName: 'Z-Bot 小猫咪',
    voiceSpeed: 1.0,
    particleEnabled: true,
    interruptThreshold: 30,
  });

  // 动画状态
  const [currentAnimation, setCurrentAnimation] = useState<AnimationType>('idle');
  const [animationCSS, setAnimationCSS] = useState<string>(getAnimationCSS('idle'));
  const [hearts, setHearts] = useState<number[]>([]);
  const [zzzVisible, setZzzVisible] = useState(false);
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });
  const [isBlinking, setIsBlinking] = useState(false);

  // 养成 / 情绪 / 面板状态
  const [petStats, setPetStats] = useState<PetCoreStats>(DEFAULT_STATS);
  const [currentEmotion, setCurrentEmotion] = useState<Emotion>('happy');
  const [showHUD, setShowHUD] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [micGuide, setMicGuide] = useState(false);
  const cursorDeltaRef = useRef({ dx: 0, dy: 0 });
  // 流式回复缓冲（T3.8）：main 只把 chunk 发给发起窗口，这里按 ref 判定归属
  const streamActiveRef = useRef(false);
  const streamBufRef = useRef('');
  const petStatsRef = useRef<PetCoreStats>(DEFAULT_STATS);
  petStatsRef.current = petStats;
  const handlePetActionRef = useRef<((action: string) => void) | null>(null);

  const refreshStats = useCallback(async () => {
    const stats = await window.electronAPI?.petGetStats();
    if (stats) setPetStats(stats as PetCoreStats);
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
          triggerAnimation(payload.content as AnimationType, 'user');
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

  // 皮肤状态
  const [currentSkin, setCurrentSkin] = useState<PetSkin>(PRESET_SKINS[0]);
  const [skinVars, setSkinVars] = useState<Record<string, string>>(getSkinCSSVariables(PRESET_SKINS[0]));

  // 场景和粒子状态
  const [currentScenery, setCurrentScenery] = useState({
    id: 'day',
    name: '阳光明媚',
    type: 'day',
    backgroundColor: 'linear-gradient(135deg, #87CEEB 0%, #E0F7FA 100%)',
    particleColor: '#FFD700',
  });
  const [particleEffects, setParticleEffects] = useState<{id: string, type: 'heart' | 'star' | 'music' | 'sparkle' | 'bounce' | 'float', content: string, enabled?: boolean}[]>([
    { id: 'heart', type: 'heart', content: '💕' },
    { id: 'star', type: 'star', content: '✨' },
    { id: 'music', type: 'music', content: '🎵' },
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
            left: `${20 + ((i * 37) % 60)}%`,
            animation: `particleFall ${3 + ((i * 13) % 4)}s linear infinite`,
            animationDelay: `${((i * 29) % 20) / 10}s`,
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
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTrackRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentAnimRef = useRef<AnimationType>('idle');
  currentAnimRef.current = currentAnimation;

  useEffect(() => {
    log('[Pet] 组件初始化');

    // 加载配置
    window.electronAPI?.loadConfig().then((cfg) => {
      if (cfg) {
        setConfig({
          ollamaUrl: cfg.ollamaUrl || DEFAULT_OLLAMA,
          sttUrl: cfg.sttUrl || DEFAULT_STT,
          ttsUrl: cfg.ttsUrl || DEFAULT_TTS,
          modelName: cfg.modelName || DEFAULT_MODEL,
          systemPrompt: cfg.systemPrompt || DEFAULT_PROMPT,
          petName: cfg.petName || 'Z-Bot 小猫咪',
          voiceSpeed: cfg.voiceSpeed || 1.0,
          interruptThreshold: cfg.interruptThreshold || 30,
          particleEnabled: cfg.particleEnabled !== false,
        });
        interruptThresholdRef.current = cfg.interruptThreshold || 30;
        // 加载皮肤
        if (cfg.currentSkinId) {
          const skin = getSkinById(cfg.currentSkinId);
          if (skin) {
            setCurrentSkin(skin);
            setSkinVars(getSkinCSSVariables(skin));
          }
        }
      }
    });

    const unsubStart = window.electronAPI?.onVoiceStart(() => startRecording());
    const unsubStop = window.electronAPI?.onVoiceStop(() => stopRecording());

    // 启动眨眼定时器
    startBlinkTimer();
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

    return () => {
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
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (cursorTrackRef.current) clearInterval(cursorTrackRef.current);
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
        startIdleScheduler();
      }, totalDuration + 50);
    }
  }, []);

  const startIdleScheduler = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (statusRef.current === 'idle' && currentAnimRef.current === 'idle') {
        const randomAnim = getRandomIdleAnimation();
        triggerAnimation(randomAnim, 'idle');
      }
    }, getRandomIdleInterval());
  }, [triggerAnimation]);

  const startBlinkTimer = useCallback(() => {
    if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = setTimeout(() => {
      if (statusRef.current === 'idle') {
        setIsBlinking(true);
        setTimeout(() => setIsBlinking(false), 300);
      }
      startBlinkTimer();
    }, getRandomBlinkInterval());
  }, []);

  // 鼠标追踪改为消费主进程推送（T3.2）：渲染端不再有 100ms 轮询定时器
  const applyCursorDelta = useCallback((delta: { dx: number; dy: number }) => {
    cursorDeltaRef.current = delta;
    if (statusRef.current !== 'idle') return;
    if (currentAnimRef.current !== 'idle' && currentAnimRef.current !== 'float') return;
    const maxOffset = 3;
    const dist = Math.sqrt(delta.dx * delta.dx + delta.dy * delta.dy) || 1;
    setEyeOffset({
      x: Math.round((delta.dx / dist) * maxOffset * 10) / 10,
      y: Math.round((delta.dy / dist) * maxOffset * 10) / 10,
    });
  }, []);

  // ---------- 皮肤系统 ----------

  const applySkin = useCallback((skin: PetSkin) => {
    setCurrentSkin(skin);
    setSkinVars(getSkinCSSVariables(skin));
    window.electronAPI?.loadConfig().then((cfg) => {
      if (cfg) {
        window.electronAPI?.saveConfig({ ...cfg, currentSkinId: skin.id });
      }
    });
    log('[Pet] 应用皮肤: ' + skin.name);
  }, []);

  // ---------- 语音打断监听 ----------
  const startInterruptListener = async () => {
    if (isSpeakingRef.current && interruptStreamRef.current) return;

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
      log('[Pet] 启动打断监听失败: ' + error.message);
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
      audioContextRef.current.close().catch(() => {});
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

    // T2.9：录音前预检权限，被拒时给可操作的引导，而不是静默失败
    const granted = await window.electronAPI?.checkMicrophone();
    if (granted === false) {
      log('[Pet] 麦克风未授权，显示引导');
      setMicGuide(true);
      setStatus('idle');
      return;
    }

    log('[Pet] 开始录音...');
    try {
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
      log('[Pet] 录音错误: ' + error.message);
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        setMicGuide(true);
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

  // ---------- 截图 ----------
  const captureAndAnalyzeScreen = async () => {
    log('[Pet] 开始截图分析...');
    setHint('📸 截图完成');
    try {
      const result = await window.electronAPI?.captureScreenshot();
      if (result?.success && result.path) {
        log('[Pet] 截图成功: ' + result.path);
        setHint('截图已保存，可在管理端查看');
      } else {
        setHint('截图失败');
      }
    } catch (error: any) {
      log('[Pet] 截图错误: ' + error.message);
      setHint('截图错误');
    }
    setTimeout(() => setHint(''), 3000);
  };

  // ---------- 语音识别 -> 对话 -> TTS ----------
  const processAudio = async (audioBlob: Blob) => {
    setStatus('thinking');
    const reader = new FileReader();
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
          log('[Pet] 未识别到文本' + (data?.error ? ': ' + data.error : ''));
          setStatus('idle');
        }
      } catch (error: any) {
        log('[Pet] STT 错误: ' + error.message);
        setStatus('idle');
      }
    };
    reader.readAsDataURL(audioBlob);
  };

  const handleVoiceInput = async (text: string) => {
    if (!text.trim()) {
      setStatus('idle');
      return;
    }
    setStatus('thinking');
    setLastMessage('');
    try {
      // 注入情绪到 system prompt
      const emotionSuffix = buildEmotionPromptSuffix(currentEmotion);
      const systemPromptWithEmotion = config.systemPrompt + emotionSuffix;

      log('[Pet] 请求 AI 回复（流式）...');
      // 流式：首字直接落到气泡，工具与确认仍在主进程 ai:streamChat 内完成（T3.7/T3.8）
      streamBufRef.current = '';
      streamActiveRef.current = true;
      const response = await window.electronAPI?.aiStreamChat({
        messages: [
          { role: 'system', content: systemPromptWithEmotion },
          { role: 'user', content: text },
        ],
        model: config.modelName,
        stream: true,
      });
      streamActiveRef.current = false;
      if (!response) {
        log('[Pet] AI 无响应');
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
    } catch (error: any) {
      log('[Pet] Error: ' + error.message);
      setStatus('idle');
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
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          stopInterruptListener();
          setStatus('idle');
        };

        await audio.play();
        startInterruptListener();
      } else {
        isSpeakingRef.current = false;
        setStatus('idle');
      }
    } catch {
      isSpeakingRef.current = false;
      stopInterruptListener();
      setStatus('idle');
    }
  };

  // ---------- 交互 ----------
  const toggleMode = () => window.electronAPI?.toggleWindow('admin');

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
    const stats = await fn();
    if (stats) {
      setPetStats(stats as PetCoreStats);
      setCurrentEmotion(resolveEmotion(stats as PetCoreStats));
    }
    if (action === 'play' || action === 'pet') spawnHearts();
  }, []);
  handlePetActionRef.current = handlePetAction;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 右键菜单：截图 + 所有宠物操作
    setShowActions(!showActions);
  };

  const handleClickOutside = () => {
    setContextMenu({ ...contextMenu, show: false });
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
    applySkin(skin);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu.show]);

  // ---------- 眼睛/嘴巴 根据 status + animation + emotion 变化 ----------
  const getEyeShape = (): string => {
    if (status === 'thinking') return 'thinking';
    if (petStats.isSleeping || currentAnimation === 'sleep') return 'closed';
    if (status === 'interrupted') return 'surprised';
    if (isBlinking) return 'blink';
    if (currentAnimation === 'yawn') return 'sleepy';
    switch (currentEmotion) {
      case 'happy': case 'excited': case 'playful': return 'happy';
      case 'sad': case 'comforting': return 'blink'; // 半闭眼
      case 'angry': case 'tsundere': return 'angry';
      case 'shy': case 'cute': return 'sleepy'; // 害羞半闭
      case 'scared': case 'surprised': return 'surprised';
      case 'sleepy': return 'sleepy';
      case 'loving': return 'happy';
      case 'proud': case 'dominant': return 'happy';
      default: return 'normal';
    }
  };

  const getMouthShape = (): string => {
    if (status === 'speaking') return 'speaking';
    if (status === 'recording') return 'o';
    if (status === 'thinking') return 'flat';
    if (status === 'interrupted') return 'o';
    if (currentAnimation === 'yawn') return 'yawn';
    if (currentAnimation === 'sleep') return 'sleep';
    switch (currentEmotion) {
      case 'happy': case 'excited': case 'playful': return 'smile';
      case 'sad': return 'flat';
      case 'angry': case 'tsundere': return 'flat';
      case 'shy': case 'cute': return 'smile';
      case 'scared': return 'o';
      case 'surprised': return 'o';
      case 'sleepy': return 'yawn';
      case 'loving': return 'smile';
      case 'proud': return 'smile';
      default: return 'smile';
    }
  };

  const eyeShape = getEyeShape();
  const mouthShape = getMouthShape();

  return (
    <div
      style={{
        width: 200,
        height: 320,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
        cursor: 'grab',
        background: currentScenery.backgroundColor,
        ...skinVars,
      }}
      onMouseDown={handleMouseDown}
      onClick={handlePetClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setShowHUD(true)}
      onMouseLeave={() => { setShowHUD(false); setShowActions(false); }}
    >
      {/* 场景粒子效果层：particleEnabled 关闭时完全不渲染，避免常驻 infinite 动画占用合成开销 */}
      {config.particleEnabled && (
        <div className="particle-layer">
          {particleLayouts.map((layout, idx) => (
            <div
              key={`${layout.id}-${idx}`}
              className={`particle ${layout.type}`}
              style={layout.style}
            >
              {layout.content}
            </div>
          ))}
        </div>
      )}
      
      {/* CSS 绘制的圆形萌宠角色 */}
      <div
        className={`pet-body ${EMOTION_CONFIGS[currentEmotion].cssClass} ${petStats.isSick ? 'pet-sick' : ''}`}
        style={{ animation: animationCSS, width: STAGE_SIZES[petStats.stage] || 120, height: STAGE_SIZES[petStats.stage] || 120 }}
      >
        {/* 眼睛 */}
        <div className="eyes">
          <div className={`eye eye-${eyeShape}`} style={eyeShape === 'normal' ? { transform: `translate(${eyeOffset.x}px, ${eyeOffset.y}px)` } : undefined}>
            <div className="pupil" style={eyeShape === 'normal' ? { transform: `translate(${eyeOffset.x * 0.5}px, ${eyeOffset.y * 0.5}px)` } : undefined} />
          </div>
          <div className={`eye eye-${eyeShape}`} style={eyeShape === 'normal' ? { transform: `translate(${eyeOffset.x}px, ${eyeOffset.y}px)` } : undefined}>
            <div className="pupil" style={eyeShape === 'normal' ? { transform: `translate(${eyeOffset.x * 0.5}px, ${eyeOffset.y * 0.5}px)` } : undefined} />
          </div>
        </div>
        {/* 嘴巴 */}
        <div className={`mouth mouth-${mouthShape}`} />
        {/* 腮红 */}
        <div className="blush blush-left" />
        <div className="blush blush-right" />

        {/* thinking 时的旋转圈 */}
        {status === 'thinking' && <div className="thinking-ring" />}
        {/* recording 时的脉冲圈 */}
        {status === 'recording' && <div className="recording-ring" />}
        {/* speaking 时的声波 + 可打断提示 */}
        {status === 'speaking' && (
          <>
            <div className="sound-waves">
              <span /><span /><span />
            </div>
            <div className="interrupt-hint">可打断</div>
          </>
        )}
        {/* interrupted 时的闪烁效果 */}
        {status === 'interrupted' && <div className="interrupt-flash" />}

        {/* 爱心动画（petted时） */}
        {hearts.map((id, i) => (
          <div
            key={id}
            className="heart-particle"
            style={{ left: 30 + i * 25, animationDelay: `${i * 0.15}s` }}
          >
            💕
          </div>
        ))}

        {/* Zzz气泡（sleep时） */}
        {zzzVisible && (
          <div className="zzz-container">
            <span className="zzz" style={{ animationDelay: '0s' }}>Z</span>
            <span className="zzz" style={{ animationDelay: '0.5s', fontSize: 14 }}>z</span>
            <span className="zzz" style={{ animationDelay: '1s', fontSize: 11 }}>z</span>
          </div>
        )}
      </div>

      {/* 状态文字 */}
      <div className="status-text">{STATUS_TEXT[status]}</div>

      {/* 最近消息 */}
      {lastMessage && status === 'idle' && (
        <div className="last-message" title={lastMessage}>{lastMessage}</div>
      )}

      {/* 提示 */}
      {micGuide && (
        <div
          className="mic-guide"
          style={{
            position: 'absolute',
            left: 6,
            right: 6,
            bottom: 44,
            padding: '8px 10px',
            borderRadius: 10,
            background: 'rgba(26, 26, 46, 0.94)',
            color: '#fff',
            fontSize: 11,
            lineHeight: 1.5,
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
            zIndex: 20,
          }}
        >
          <div>需要麦克风权限才能语音对话 🎤</div>
          <div style={{ fontSize: 10, opacity: 0.75 }}>
            系统设置 → 隐私与安全性 → 麦克风 → 允许 Z-Bot
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              style={{ flex: 1, fontSize: 11, padding: '2px 6px', borderRadius: 6, cursor: 'pointer' }}
              onClick={async () => {
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
              style={{ flex: 1, fontSize: 11, padding: '2px 6px', borderRadius: 6, cursor: 'pointer' }}
              onClick={() => setMicGuide(false)}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {hint && <div className="hint">{hint}</div>}
      {!hint && status === 'idle' && <div className="hint">右键更多选项 | 双击摸摸我</div>}

      {/* 宠物状态条 HUD - 悬停显示 */}
      {showHUD && (
        <div className="pet-hud">
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
          <div className="hud-row hud-info">
            <span>好感: {Math.round(petStats.affection)}💕</span>
            <span>阶段: {petStats.stage}</span>
            <span>年龄: {petStats.age}天</span>
          </div>
        </div>
      )}

      {/* 交互按钮 - 属性低时自动显示 */}
      {status === 'idle' && (petStats.hunger < 60 || petStats.happiness < 60 || petStats.cleanliness < 60 || petStats.isSick || (!petStats.isSleeping && petStats.energy < 50)) && (
        <div className="action-buttons">
          {petStats.hunger < 60 && <button className="action-btn" onClick={(e) => { e.stopPropagation(); handlePetAction('feed'); }}>🍖</button>}
          {petStats.happiness < 60 && <button className="action-btn" onClick={(e) => { e.stopPropagation(); handlePetAction('play'); }}>🎮</button>}
          {petStats.cleanliness < 60 && <button className="action-btn" onClick={(e) => { e.stopPropagation(); handlePetAction('wash'); }}>🛁</button>}
          {!petStats.isSleeping && petStats.energy < 50 && <button className="action-btn" onClick={(e) => { e.stopPropagation(); handlePetAction('sleep'); }}>💤</button>}
          {petStats.isSick && <button className="action-btn" onClick={(e) => { e.stopPropagation(); handlePetAction('medicine'); }}>💊</button>}
        </div>
      )}

      {/* 管理端按钮 */}
      <button className="admin-btn" onClick={(e) => { e.stopPropagation(); toggleMode(); }}>
        💬 管理端
      </button>

      {/* 右键菜单 */}
      {contextMenu.show && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="menu-item" onClick={captureAndAnalyzeScreen}>
            📸 截图分析
          </div>
          <div className="menu-separator" />
          <div className="menu-section-label">🐾 宠物养成</div>
          <div className="menu-item" onClick={() => { handlePetAction('feed'); setContextMenu({ ...contextMenu, show: false }); }}>
            🍖 喂食 (饱食+30)
          </div>
          <div className="menu-item" onClick={() => { handlePetAction('play'); setContextMenu({ ...contextMenu, show: false }); }}>
            🎮 玩耍 (快乐+20)
          </div>
          <div className="menu-item" onClick={() => { handlePetAction('wash'); setContextMenu({ ...contextMenu, show: false }); }}>
            🛁 洗澡 (清洁+40)
          </div>
          <div className="menu-item" onClick={() => { handlePetAction('sleep'); setContextMenu({ ...contextMenu, show: false }); }}>
            💤 {petStats.isSleeping ? '起床' : '睡觉'}
          </div>
          <div className="menu-item" onClick={() => { handlePetAction('medicine'); setContextMenu({ ...contextMenu, show: false }); }}>
            💊 治疗 (健康+30)
          </div>
          <div className="menu-item" onClick={() => { handlePetAction('pet'); setContextMenu({ ...contextMenu, show: false }); }}>
            🤚 抚摸 (好感+1)
          </div>
          <div className="menu-separator" />
          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setAnimMenuOpen(true)}
            onMouseLeave={() => setAnimMenuOpen(false)}
          >
            🎭 动画 ▸
            {animMenuOpen && (
              <div className="submenu">
                {ANIMATION_MENU_ITEMS.map((item) => (
                  <div
                    key={item.value}
                    className="submenu-item"
                    onClick={() => handleAnimSelect(item.value)}
                  >
                    {item.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setSkinMenuOpen(true)}
            onMouseLeave={() => setSkinMenuOpen(false)}
          >
            🎨 皮肤 ▸
            {skinMenuOpen && (
              <div className="submenu">
                {PRESET_SKINS.map((skin) => (
                  <div
                    key={skin.id}
                    className={`submenu-item ${currentSkin.id === skin.id ? 'active' : ''}`}
                    onClick={() => handleSkinSelect(skin)}
                  >
                    <span className="skin-dot" style={{ background: skin.colors.bodyLight }} />
                    {skin.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="menu-separator" />
          <div className="menu-item" onClick={() => { triggerAnimation('idle', 'user'); setContextMenu({ ...contextMenu, show: false }); }}>
            🏠 回到待机
          </div>
        </div>
      )}

      <style>{ANIMATION_KEYFRAMES}</style>
    </div>
  );
}

export default App;

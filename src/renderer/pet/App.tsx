import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  });

  // 动画状态
  const [currentAnimation, setCurrentAnimation] = useState<AnimationType>('idle');
  const [animationCSS, setAnimationCSS] = useState<string>(getAnimationCSS('idle'));
  const [hearts, setHearts] = useState<number[]>([]);
  const [zzzVisible, setZzzVisible] = useState(false);
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });
  const [isBlinking, setIsBlinking] = useState(false);

  // 皮肤状态
  const [currentSkin, setCurrentSkin] = useState<PetSkin>(PRESET_SKINS[0]);
  const [skinVars, setSkinVars] = useState<Record<string, string>>(getSkinCSSVariables(PRESET_SKINS[0]));

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; show: boolean }>({ x: 0, y: 0, show: false });
  const [skinMenuOpen, setSkinMenuOpen] = useState(false);
  const [animMenuOpen, setAnimMenuOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
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
        });
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
    // 启动鼠标追踪
    startCursorTracking();

    // 监听动画触发IPC
    const unsubAnim = window.electronAPI?.onTriggerAnimation?.((anim: AnimationType) => {
      triggerAnimation(anim, 'user');
    });
    // 监听皮肤应用IPC
    const unsubSkin = window.electronAPI?.onApplySkin?.((skin: PetSkin) => {
      applySkin(skin);
    });

    return () => {
      stopRecording();
      stopInterruptListener();
      unsubStart?.();
      unsubStop?.();
      unsubAnim?.();
      unsubSkin?.();
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

  const startCursorTracking = useCallback(() => {
    if (cursorTrackRef.current) clearInterval(cursorTrackRef.current);
    cursorTrackRef.current = setInterval(async () => {
      if (statusRef.current !== 'idle') return;
      if (currentAnimRef.current !== 'idle' && currentAnimRef.current !== 'float') return;
      try {
        const pos = await window.electronAPI?.getCursorPosition();
        if (pos) {
          const petCenterX = 100;
          const petCenterY = 160;
          const dx = pos.x - petCenterX;
          const dy = pos.y - petCenterY;
          const maxOffset = 3;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          setEyeOffset({
            x: Math.round((dx / dist) * maxOffset * 10) / 10,
            y: Math.round((dy / dist) * maxOffset * 10) / 10,
          });
        }
      } catch {
        // ignore
      }
    }, 100);
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
    } catch (error: any) {
      log('[Pet] 录音错误: ' + error.message);
      setStatus('idle');
    }
  };

  const stopRecording = () => {
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
        const response = await fetch(config.sttUrl + '/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64 }),
        });
        const data = await response.json();
        log('[Pet] STT 响应: ' + JSON.stringify(data));
        if (data.text) {
          await handleVoiceInput(data.text);
        } else {
          log('[Pet] 未识别到文本');
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

      log('[Pet] 调用 ollama...');
      const response = await fetch(config.ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: systemPromptWithEmotion },
            { role: 'user', content: text },
          ],
          stream: false,
        }),
      });
      if (!response.ok) {
        log('[Pet] ollama 错误: ' + response.status);
        setStatus('idle');
        return;
      }
      const data = await response.json();
      const reply = data.message?.content || '抱歉，我无法理解您的问题。';
      log('[Pet] ollama 响应: ' + reply.slice(0, 50));
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
      const ttsResponse = await fetch(config.ttsUrl + '/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, speed: config.voiceSpeed }),
      });
      const ttsData = await ttsResponse.json();
      if (ttsData.audio) {
        const audio = new Audio('data:audio/mp3;base64,' + ttsData.audio);
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

  const handleDoubleClick = () => {
    if (status !== 'idle') return;
    triggerAnimation('petted', 'user');
    const newHearts = [Date.now(), Date.now() + 100, Date.now() + 200];
    setHearts(newHearts);
    setTimeout(() => setHearts([]), 2000);
  };

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
      window.electronAPI?.getCursorPosition().then((pos) => {
        if (pos) {
          triggerAnimation('chase', 'user');
          window.electronAPI?.setPetPosition(pos.x - 100, pos.y - 160);
        }
      });
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
        ...skinVars,
      }}
      onMouseDown={handleMouseDown}
      onClick={handlePetClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setShowHUD(true)}
      onMouseLeave={() => { setShowHUD(false); setShowActions(false); }}
    >
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

      <style>{`
        ${ANIMATION_KEYFRAMES}

        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
          width: 100%; height: 100%;
          background: transparent !important;
          overflow: hidden;
        }

        /* 萌宠主体 */
        .pet-body {
          position: relative;
          width: 120px;
          height: 120px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, var(--pet-body-light) 0%, var(--pet-body) 60%, var(--pet-body-dark) 100%);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), inset -4px -8px 16px rgba(0,0,0,0.15);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          transition: background 0.5s ease;
        }

        /* 眼睛 */
        .eyes {
          display: flex;
          gap: 20px;
          margin-top: -5px;
        }
        .eye {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #fff;
          position: relative;
          transition: all 0.3s ease;
          overflow: hidden;
        }
        .pupil {
          position: absolute;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--pet-eye);
          top: 5px;
          left: 5px;
          transition: transform 0.15s ease-out;
        }
        .eye-thinking {
          height: 6px;
          border-radius: 6px;
          margin-top: 6px;
        }
        .eye-thinking .pupil { display: none; }
        .eye-happy .pupil {
          top: 2px;
          left: 3px;
          width: 12px;
          height: 12px;
        }
        .eye-surprised {
          width: 22px;
          height: 22px;
        }
        .eye-surprised .pupil {
          width: 10px;
          height: 10px;
          top: 6px;
          left: 6px;
        }
        .eye-blink {
          height: 2px;
          border-radius: 2px;
          margin-top: 8px;
        }
        .eye-blink .pupil { display: none; }
        .eye-closed {
          height: 2px;
          border-radius: 2px;
          margin-top: 8px;
          background: var(--pet-eye);
        }
        .eye-closed .pupil { display: none; }
        .eye-sleepy {
          height: 8px;
          border-radius: 8px;
          margin-top: 5px;
        }
        .eye-sleepy .pupil {
          top: 2px;
          width: 6px;
          height: 4px;
        }

        /* 嘴巴 */
        .mouth {
          margin-top: 10px;
          transition: all 0.3s ease;
        }
        .mouth-smile {
          width: 24px;
          height: 12px;
          border-bottom: 3px solid #fff;
          border-radius: 0 0 24px 24px;
        }
        .mouth-o {
          width: 12px;
          height: 14px;
          border-radius: 50%;
          background: var(--pet-body-dark);
          border: 2px solid #fff;
        }
        .mouth-flat {
          width: 20px;
          height: 3px;
          border-radius: 3px;
          background: #fff;
        }
        .mouth-speaking {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--pet-body-dark);
          border: 2px solid #fff;
          animation: mouthTalk 0.2s ease-in-out infinite alternate;
        }
        .mouth-yawn {
          width: 20px;
          height: 22px;
          border-radius: 50%;
          background: var(--pet-body-dark);
          border: 2px solid #fff;
          animation: mouthYawn 1.5s ease-in-out;
        }
        .mouth-sleep {
          width: 16px;
          height: 4px;
          border-radius: 0 0 16px 16px;
          border-bottom: 2px solid rgba(255,255,255,0.6);
          border-left: 2px solid rgba(255,255,255,0.6);
          border-right: 2px solid rgba(255,255,255,0.6);
        }
        @keyframes mouthTalk {
          from { height: 6px; border-radius: 6px; }
          to { height: 18px; border-radius: 50%; }
        }
        @keyframes mouthYawn {
          0%, 100% { transform: scaleY(1); }
          30% { transform: scaleY(1.3); }
          60% { transform: scaleY(0.8); }
        }

        /* 腮红 */
        .blush {
          position: absolute;
          width: 14px;
          height: 8px;
          border-radius: 50%;
          background: var(--pet-blush);
          top: 62px;
          transition: background 0.5s ease;
        }
        .blush-left { left: 18px; }
        .blush-right { right: 18px; }

        /* thinking 旋转圈 */
        .thinking-ring {
          position: absolute;
          top: -12px;
          left: -12px;
          width: 144px;
          height: 144px;
          border-radius: 50%;
          border: 3px solid transparent;
          border-top-color: var(--pet-accent);
          border-right-color: var(--pet-body-light);
          animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* recording 脉冲圈 */
        .recording-ring {
          position: absolute;
          top: 0; left: 0;
          width: 120px; height: 120px;
          border-radius: 50%;
          border: 3px solid #ff4d4f;
          animation: pulseRing 1.2s ease-out infinite;
        }
        @keyframes pulseRing {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.6); opacity: 0; }
        }

        /* speaking 声波 */
        .sound-waves {
          position: absolute;
          display: flex;
          gap: 4px;
          right: -28px;
          top: 50%;
          transform: translateY(-50%);
        }
        .sound-waves span {
          display: block;
          width: 4px;
          background: var(--pet-accent);
          border-radius: 2px;
          animation: soundBar 0.5s ease-in-out infinite alternate;
        }
        .sound-waves span:nth-child(1) { height: 12px; animation-delay: 0s; }
        .sound-waves span:nth-child(2) { height: 20px; animation-delay: 0.15s; }
        .sound-waves span:nth-child(3) { height: 16px; animation-delay: 0.3s; }
        @keyframes soundBar {
          from { transform: scaleY(0.4); }
          to { transform: scaleY(1); }
        }

        /* 可打断提示 */
        .interrupt-hint {
          position: absolute;
          bottom: -22px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 9px;
          color: var(--pet-body-light);
          background: rgba(114, 46, 209, 0.3);
          padding: 1px 6px;
          border-radius: 6px;
          white-space: nowrap;
          animation: hintPulse 1.5s ease-in-out infinite;
        }
        @keyframes hintPulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }

        /* 打断闪烁效果 */
        .interrupt-flash {
          position: absolute;
          top: 0; left: 0;
          width: 120px; height: 120px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.4);
          animation: flashOnce 0.3s ease-out;
        }
        @keyframes flashOnce {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(1.3); }
        }

        /* 爱心粒子 */
        .heart-particle {
          position: absolute;
          top: -10px;
          font-size: 16px;
          animation: animHeartFloat 1.5s ease-out forwards;
          pointer-events: none;
        }

        /* Zzz气泡 */
        .zzz-container {
          position: absolute;
          top: -5px;
          right: -10px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .zzz {
          color: var(--pet-body-light);
          font-weight: bold;
          font-size: 16px;
          animation: animZzz 2s ease-out infinite;
          opacity: 0;
        }

        /* 文字 */
        .status-text {
          margin-top: 18px;
          padding: 4px 14px;
          background: rgba(255,255,255,0.95);
          border-radius: 14px;
          font-size: 12px;
          color: #333;
          font-weight: 500;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
          white-space: nowrap;
        }
        .last-message {
          margin-top: 8px;
          padding: 6px 10px;
          background: rgba(0,0,0,0.65);
          border-radius: 10px;
          font-size: 11px;
          color: #fff;
          max-width: 180px;
          text-align: center;
          line-height: 1.4;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hint {
          margin-top: 6px;
          font-size: 10px;
          color: rgba(255,255,255,0.7);
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        }
        .admin-btn {
          margin-top: 10px;
          padding: 5px 14px;
          background: rgba(255,255,255,0.85);
          border: none;
          border-radius: 12px;
          color: var(--pet-body);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s, color 0.5s;
        }
        .admin-btn:hover { background: #fff; }

        /* 右键菜单 */
        .context-menu {
          position: fixed;
          background: rgba(30, 30, 50, 0.95);
          backdrop-filter: blur(10px);
          border-radius: 10px;
          padding: 6px 0;
          min-width: 160px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          z-index: 9999;
          font-size: 13px;
          color: #eee;
        }
        .menu-item {
          padding: 8px 16px;
          cursor: pointer;
          position: relative;
          white-space: nowrap;
        }
        .menu-item:hover {
          background: rgba(255,255,255,0.1);
        }
        .menu-item.has-submenu::after {
          content: '▸';
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          font-size: 11px;
        }
        .menu-separator {
          height: 1px;
          background: rgba(255,255,255,0.1);
          margin: 4px 8px;
        }
        .submenu {
          position: absolute;
          left: 100%;
          top: 0;
          background: rgba(30, 30, 50, 0.95);
          backdrop-filter: blur(10px);
          border-radius: 10px;
          padding: 6px 0;
          min-width: 140px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        .submenu-item {
          padding: 7px 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
        }
        .submenu-item:hover {
          background: rgba(255,255,255,0.1);
        }
        .submenu-item.active {
          color: var(--pet-body-light);
          font-weight: 600;
        }
        .skin-dot {
          display: inline-block;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.3);
          flex-shrink: 0;
        }

        /* ---- 19种情绪表情CSS ---- */
        .emotion-happy .blush { opacity: 1 !important; }
        .emotion-sad { filter: saturate(0.6) brightness(0.9); }
        .emotion-angry { filter: saturate(1.3) brightness(0.85); }
        .emotion-tsundere .blush { opacity: 0.9 !important; background: rgba(255, 80, 80, 0.6) !important; }
        .emotion-cute .blush { opacity: 1 !important; background: rgba(255, 150, 200, 0.7) !important; }
        .emotion-shy .blush { opacity: 1 !important; background: rgba(255, 100, 100, 0.7) !important; }
        .emotion-sleepy { filter: brightness(0.8); }
        .emotion-scared { animation: petShake 0.3s ease-in-out infinite !important; }
        .emotion-whispering { filter: brightness(0.9); }
        .emotion-confused { animation: petWobble 2s ease-in-out infinite !important; }
        .emotion-dominant { filter: saturate(1.2) brightness(1.1); }
        .emotion-loving { filter: saturate(1.1) brightness(1.05); }
        .emotion-thinking { filter: brightness(0.95); }
        .emotion-excited { animation: petBounce 0.3s ease-in-out infinite !important; }
        .emotion-proud { filter: saturate(1.2) brightness(1.1); }
        .emotion-playful { animation: petBounce 0.5s ease-in-out infinite !important; }
        .emotion-comforting { filter: saturate(0.9) brightness(1.05); }
        .emotion-neutral { }
        .emotion-surprised { }

        /* 生病绿色脸色 */
        .pet-sick {
          filter: saturate(0.5) brightness(0.85) hue-rotate(60deg) !important;
        }

        /* 愤怒眼睛 */
        .eye-angry {
          transform: rotate(-15deg);
        }
        .eye-angry .pupil {
          top: 4px;
          width: 10px;
          height: 10px;
        }

        /* 宠物状态条 HUD */
        .pet-hud {
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0, 0, 0, 0.75);
          border-radius: 12px;
          padding: 8px 10px;
          z-index: 100;
          min-width: 160px;
          backdrop-filter: blur(8px);
        }
        .hud-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 4px;
        }
        .hud-icon {
          font-size: 12px;
          width: 16px;
          text-align: center;
        }
        .hud-bar-bg {
          flex: 1;
          height: 6px;
          background: rgba(255,255,255,0.2);
          border-radius: 3px;
          overflow: hidden;
        }
        .hud-bar-fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.5s ease;
        }
        .hud-value {
          font-size: 10px;
          color: #fff;
          width: 24px;
          text-align: right;
        }
        .hud-info {
          justify-content: space-between;
          font-size: 9px;
          color: rgba(255,255,255,0.8);
          margin-top: 4px;
          margin-bottom: 0;
        }

        /* 交互按钮 */
        .action-buttons {
          display: flex;
          gap: 4px;
          margin-top: 4px;
          flex-wrap: wrap;
          justify-content: center;
        }
        .action-btn {
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 50%;
          background: rgba(255,255,255,0.85);
          font-size: 14px;
          cursor: pointer;
          transition: transform 0.2s, background 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          line-height: 1;
        }
        .action-btn:hover {
          transform: scale(1.2);
          background: #fff;
        }
        .action-btn:active {
          transform: scale(0.95);
        }

        /* 菜单分区标签 */
        .menu-section-label {
          padding: 4px 16px;
          font-size: 11px;
          color: rgba(255,255,255,0.5);
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}

export default App;

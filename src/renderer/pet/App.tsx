import React, { useState, useEffect, useRef, useCallback } from 'react';

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

type PetStatus = 'idle' | 'recording' | 'thinking' | 'speaking';

const STATUS_TEXT: Record<PetStatus, string> = {
  idle: '点击和我说话~',
  recording: '🎤 录音中... 再次点击停止',
  thinking: '🤔 思考中...',
  speaking: '🔊 说话中...',
};

const DEFAULT_OLLAMA = 'http://localhost:11434';
const DEFAULT_STT = 'http://localhost:8084';
const DEFAULT_TTS = 'http://localhost:8086';
const DEFAULT_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DEFAULT_PROMPT = '你是一只可爱的桌面萌宠小猫咪，名字叫Z-Bot。性格活泼可爱、温柔体贴，用简短温馨的语言回复。';

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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const dragStateRef = useRef<{ dragging: boolean; startX: number; startY: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
  });
  const statusRef = useRef<PetStatus>('idle');
  statusRef.current = status;

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
      }
    });

    const unsubStart = window.electronAPI?.onVoiceStart(() => startRecording());
    const unsubStop = window.electronAPI?.onVoiceStop(() => stopRecording());

    return () => {
      stopRecording();
      unsubStart?.();
      unsubStop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 录音 ----------
  const startRecording = async () => {
    if (statusRef.current === 'recording') {
      stopRecording();
      return;
    }
    if (statusRef.current !== 'idle') return;

    log('[Pet] 开始录音...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      log('[Pet] 调用 ollama...');
      const response = await fetch(config.ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: config.systemPrompt },
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

      setStatus('speaking');
      try {
        const ttsResponse = await fetch(config.ttsUrl + '/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: reply, speed: config.voiceSpeed }),
        });
        const ttsData = await ttsResponse.json();
        if (ttsData.audio) {
          const audio = new Audio('data:audio/mp3;base64,' + ttsData.audio);
          audio.onended = () => {
            log('[Pet] TTS 播放完成');
            setStatus('idle');
          };
          audio.play();
        } else {
          setStatus('idle');
        }
      } catch {
        setStatus('idle');
      }
    } catch (error: any) {
      log('[Pet] Error: ' + error.message);
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
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (status === 'idle') captureAndAnalyzeScreen();
  };

  // ---------- 拖拽移动 ----------
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // 只响应左键
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
    dragStateRef.current.dragging = false;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // ---------- 眼睛/嘴巴 根据 status 变化 ----------
  const eyeShape = status === 'thinking' ? 'thinking' : status === 'speaking' ? 'happy' : 'normal';
  const mouthShape = status === 'speaking' ? 'speaking' : status === 'recording' ? 'o' : status === 'thinking' ? 'flat' : 'smile';

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
      }}
      onMouseDown={handleMouseDown}
      onClick={handlePetClick}
      onContextMenu={handleContextMenu}
    >
      {/* CSS 绘制的圆形萌宠角色 */}
      <div className={`pet-body pet-${status}`}>
        {/* 眼睛 */}
        <div className="eyes">
          <div className={`eye eye-${eyeShape}`} />
          <div className={`eye eye-${eyeShape}`} />
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
        {/* speaking 时的声波 */}
        {status === 'speaking' && (
          <div className="sound-waves">
            <span /><span /><span />
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
      {!hint && status === 'idle' && <div className="hint">右键截图分析</div>}

      {/* 管理端按钮 */}
      <button className="admin-btn" onClick={(e) => { e.stopPropagation(); toggleMode(); }}>
        💬 管理端
      </button>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
          width: 100%; height: 100%;
          background: transparent !important;
          overflow: hidden;
        }

        /* 萌宠主体 —— CSS 绘制的圆形角色 */
        .pet-body {
          position: relative;
          width: 120px;
          height: 120px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #b794f6 0%, #722ed1 60%, #531dab 100%);
          box-shadow: 0 8px 24px rgba(114, 46, 209, 0.4), inset -4px -8px 16px rgba(0,0,0,0.15);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          transition: transform 0.4s ease;
        }

        /* 状态动画 */
        .pet-idle { animation: petFloat 3s ease-in-out infinite; }
        .pet-recording { animation: petShake 0.6s ease-in-out infinite; }
        .pet-thinking { animation: petWobble 1.5s ease-in-out infinite; }
        .pet-speaking { animation: petBounce 0.4s ease-in-out infinite; }

        @keyframes petFloat {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-10px) rotate(2deg); }
        }
        @keyframes petShake {
          0%, 100% { transform: translateX(0) scale(1); }
          25% { transform: translateX(-3px) scale(1.02); }
          75% { transform: translateX(3px) scale(1.02); }
        }
        @keyframes petWobble {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(-5deg); }
          75% { transform: rotate(5deg); }
        }
        @keyframes petBounce {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-4px) scale(1.05); }
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
        }
        .eye::after {
          content: '';
          position: absolute;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #1a1a2e;
          top: 5px;
          left: 5px;
          transition: all 0.3s ease;
        }
        .eye-thinking {
          height: 6px;
          border-radius: 6px;
          margin-top: 6px;
        }
        .eye-thinking::after { display: none; }
        .eye-happy::after {
          top: 2px;
          left: 3px;
          width: 12px;
          height: 12px;
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
          background: #2d1b4e;
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
          background: #2d1b4e;
          border: 2px solid #fff;
          animation: mouthTalk 0.2s ease-in-out infinite alternate;
        }
        @keyframes mouthTalk {
          from { height: 6px; border-radius: 6px; }
          to { height: 18px; border-radius: 50%; }
        }

        /* 腮红 */
        .blush {
          position: absolute;
          width: 14px;
          height: 8px;
          border-radius: 50%;
          background: rgba(255, 105, 180, 0.5);
          top: 62px;
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
          border-top-color: #722ed1;
          border-right-color: #b794f6;
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
          background: #722ed1;
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
          color: #722ed1;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }
        .admin-btn:hover { background: #fff; }
      `}</style>
    </div>
  );
}

export default App;

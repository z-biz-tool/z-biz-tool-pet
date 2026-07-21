import React, { useState, useEffect, useRef } from 'react';
import { SYSTEM_PROMPT, MODEL_NAME } from '../shared/prompts';

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

function App() {
  const [status, setStatus] = useState<'idle' | 'recording' | 'thinking' | 'speaking'>('idle');
  const [lastMessage, setLastMessage] = useState('');
  const [showScreenshotHint, setShowScreenshotHint] = useState(false);
  const petRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    log('[Z-Bot Pet] 组件初始化');

    const unsubscribeStart = window.electronAPI?.onVoiceStart(() => {
      log('[Z-Bot Pet] 收到 voice:start 事件');
      startRecording();
    });
    const unsubscribeStop = window.electronAPI?.onVoiceStop(() => {
      stopRecording();
    });
    return () => {
      stopRecording();
      unsubscribeStart?.();
      unsubscribeStop?.();
    };
  }, []);

  const startRecording = async () => {
    if (status === 'recording') {
      stopRecording();
      return;
    }
    if (status !== 'idle') return;

    log('[Z-Bot Pet] 开始录音...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        log('[Z-Bot Pet] 录音结束，开始识别...');
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());
        await processAudio(audioBlob);
      };

      mediaRecorder.start();
      setStatus('recording');
      log('[Z-Bot Pet] 录音中...');
    } catch (error: any) {
      log('[Z-Bot Pet] 录音错误: ' + error.message);
      setStatus('idle');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && status === 'recording') {
      log('[Z-Bot Pet] 停止录音');
      mediaRecorderRef.current.stop();
    }
  };

  const captureAndAnalyzeScreen = async () => {
    log('[Z-Bot Pet] 开始截图分析...');
    try {
      const result = await window.electronAPI?.captureScreenshot();
      if (result?.success && result.path) {
        log('[Z-Bot Pet] 截图成功: ' + result.path);
        setShowScreenshotHint(true);
        setTimeout(() => setShowScreenshotHint(false), 3000);
      } else {
        log('[Z-Bot Pet] 截图失败: ' + result?.error);
      }
    } catch (error: any) {
      log('[Z-Bot Pet] 截图错误: ' + error.message);
    }
  };

  const processAudio = async (audioBlob: Blob) => {
    setStatus('thinking');

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      log('[Z-Bot Pet] 音频 base64 长度: ' + base64.length);
      log('[Z-Bot Pet] 发送音频到 STT 服务...');

      try {
        const response = await fetch('http://localhost:8084/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64 }),
        });

        const data = await response.json();
        log('[Z-Bot Pet] STT 响应: ' + JSON.stringify(data));

        if (data.text) {
          await handleVoiceInput(data.text);
        } else {
          log('[Z-Bot Pet] 未识别到文本');
          setStatus('idle');
        }
      } catch (error: any) {
        log('[Z-Bot Pet] STT 错误: ' + error.message);
        setStatus('idle');
      }
    };
    reader.readAsDataURL(audioBlob);
  };

  const handleVoiceInput = async (text: string) => {
    log('[Z-Bot Pet] 收到语音输入: ' + text);
    if (!text.trim()) {
      setStatus('idle');
      return;
    }

    setStatus('thinking');
    try {
      log('[Z-Bot Pet] 调用 ollama...');
      const startTime = Date.now();
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          stream: false,
        }),
      });
      const elapsed = Date.now() - startTime;
      log('[Z-Bot Pet] ollama 响应时间: ' + elapsed + 'ms');

      if (!response.ok) {
        log('[Z-Bot Pet] ollama 错误: ' + response.status);
        setStatus('idle');
        return;
      }

      const data = await response.json();
      const reply = data.message?.content || '抱歉，我无法理解您的问题。';
      log('[Z-Bot Pet] ollama 响应: ' + reply.slice(0, 50));
      setLastMessage(reply);

      setStatus('speaking');
      try {
        const ttsResponse = await fetch('http://localhost:8086/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: reply }),
        });
        const ttsData = await ttsResponse.json();
        if (ttsData.audio) {
          const audio = new Audio('data:audio/mp3;base64,' + ttsData.audio);
          audio.onended = () => {
            log('[Z-Bot Pet] TTS 播放完成');
            setStatus('idle');
          };
          audio.play();
        } else {
          log('[Z-Bot Pet] TTS 无音频返回');
          setStatus('idle');
        }
      } catch (e: any) {
        log('[Z-Bot Pet] TTS 错误: ' + e.message);
        setStatus('idle');
      }
    } catch (error: any) {
      log('[Z-Bot Pet] Error: ' + error.message);
      setStatus('idle');
    }
  };

  const getPetEmoji = () => {
    switch (status) {
      case 'recording': return '🎙️';
      case 'thinking': return '🤔';
      case 'speaking': return '🔊';
      default: return '🐱';
    }
  };

  const getPetAnimation = () => {
    switch (status) {
      case 'recording': return 'pulse';
      case 'thinking': return 'pulse';
      case 'speaking': return 'wave';
      default: return 'float';
    }
  };

  const toggleMode = () => {
    window.electronAPI?.toggleWindow('admin');
  };

  const handlePetClick = () => {
    if (status === 'idle') {
      startRecording();
    } else if (status === 'recording') {
      stopRecording();
    }
  };

  const handleLongPress = () => {
    if (status === 'idle') {
      captureAndAnalyzeScreen();
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: {
      width: '200px',
      height: '300px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, rgba(138, 43, 226, 0.3) 0%, rgba(70, 130, 180, 0.3) 100%)',
      borderRadius: '24px',
      cursor: 'pointer',
      userSelect: 'none',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
      backdropFilter: 'blur(10px)',
    },
    pet: {
      fontSize: '80px',
      transition: 'transform 0.3s ease',
      animation: `${getPetAnimation()} 1s ease-in-out infinite`,
      filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))',
    },
    status: {
      marginTop: '12px',
      padding: '6px 16px',
      background: 'rgba(255, 255, 255, 0.25)',
      borderRadius: '16px',
      fontSize: '12px',
      color: '#fff',
      fontWeight: '500',
      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    },
    message: {
      marginTop: '8px',
      padding: '6px 12px',
      background: 'rgba(0,0,0,0.3)',
      borderRadius: '12px',
      fontSize: '11px',
      color: '#fff',
      maxWidth: '170px',
      textAlign: 'center',
      lineHeight: '1.4',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    button: {
      marginTop: '12px',
      padding: '8px 16px',
      background: 'rgba(255, 255, 255, 0.2)',
      border: 'none',
      borderRadius: '12px',
      color: '#fff',
      fontSize: '12px',
      cursor: 'pointer',
      transition: 'background 0.3s ease',
    },
    hint: {
      marginTop: '8px',
      fontSize: '10px',
      color: 'rgba(255,255,255,0.7)',
    },
    screenshotHint: {
      position: 'absolute',
      top: '20px',
      right: '20px',
      padding: '4px 8px',
      background: 'rgba(76, 175, 80, 0.9)',
      borderRadius: '8px',
      fontSize: '10px',
      color: '#fff',
      animation: 'fadeIn 0.3s ease',
    },
  };

  return (
    <div ref={petRef} style={styles.container} onClick={handlePetClick} onContextMenu={handleLongPress}>
      <div style={styles.pet}>{getPetEmoji()}</div>
      <div style={styles.status}>
        {status === 'idle' && '点击说话'}
        {status === 'recording' && '🎤 录音中...'}
        {status === 'thinking' && '🤔 思考中...'}
        {status === 'speaking' && '🔊 说话中...'}
      </div>
      {lastMessage && status === 'idle' && (
        <div style={styles.message} title={lastMessage}>{lastMessage}</div>
      )}
      <div style={styles.hint}>右键截图分析</div>
      <button style={styles.button} onClick={(e) => { e.stopPropagation(); toggleMode(); }}>
        管理端
      </button>
      {showScreenshotHint && <div style={styles.screenshotHint}>📸 截图完成</div>}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-8px) rotate(-2deg); }
          50% { transform: translateY(-12px) rotate(0deg); }
          75% { transform: translateY(-8px) rotate(2deg); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
        @keyframes wave {
          0%, 100% { transform: rotate(-10deg); }
          50% { transform: rotate(10deg); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

export default App;

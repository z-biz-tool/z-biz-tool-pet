import React, { useState, useEffect, useRef } from 'react';

declare global {
  interface Window {
    electronAPI: {
      toggleWindow: (mode: 'admin' | 'pet') => Promise<void>;
      getMode: () => Promise<'admin' | 'pet'>;
      onVoiceStart: (callback: () => void) => () => void;
      onVoiceStop: (callback: () => void) => () => void;
      log: (msg: string) => void;
    };
  }
}

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

function App() {
  const [status, setStatus] = useState<'idle' | 'recording' | 'thinking' | 'speaking'>('idle');
  const [lastMessage, setLastMessage] = useState('');
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

  const processAudio = async (audioBlob: Blob) => {
    setStatus('thinking');

    // Convert to base64
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      log('[Z-Bot Pet] 音频 base64 长度: ' + base64.length);
      log('[Z-Bot Pet] 发送音频到 STT 服务...');

      try {
        log('[Z-Bot Pet] 开始 fetch...');
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
          model: 'qwen2.5:7b-instruct-q4_K_M',
          messages: [{ role: 'user', content: text }],
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

      // TTS 播放
      log('[Z-Bot Pet] 开始 TTS 播放');
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

  const styles: Record<string, React.CSSProperties> = {
    container: {
      width: '200px',
      height: '280px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(255, 255, 255, 0.15)',
      borderRadius: '20px',
      cursor: 'pointer',
      userSelect: 'none',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    pet: {
      fontSize: '80px',
      transition: 'transform 0.3s ease',
      animation: `${getPetAnimation()} 1s ease-in-out infinite`,
    },
    status: {
      marginTop: '12px',
      padding: '4px 12px',
      background: 'rgba(255, 255, 255, 0.25)',
      borderRadius: '12px',
      fontSize: '12px',
      color: '#fff',
    },
    button: {
      marginTop: '12px',
      padding: '6px 12px',
      background: 'rgba(255, 255, 255, 0.2)',
      border: 'none',
      borderRadius: '8px',
      color: '#fff',
      fontSize: '11px',
      cursor: 'pointer',
    },
  };

  return (
    <div ref={petRef} style={styles.container} onClick={handlePetClick}>
      <div style={styles.pet}>{getPetEmoji()}</div>
      <div style={styles.status}>
        {status === 'idle' && '点击说话'}
        {status === 'recording' && '正在录音...'}
        {status === 'thinking' && '思考中...'}
        {status === 'speaking' && '说话中...'}
      </div>
      {lastMessage && status === 'idle' && (
        <div style={{ marginTop: '8px', padding: '4px 8px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', fontSize: '10px', color: '#fff', maxWidth: '160px', textAlign: 'center' }}>
          {lastMessage.slice(0, 30)}...
        </div>
      )}
      <button style={styles.button} onClick={(e) => { e.stopPropagation(); toggleMode(); }}>
        打开管理端
      </button>
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-15px) scale(1.1); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        @keyframes wave {
          0%, 100% { transform: rotate(-5deg); }
          50% { transform: rotate(5deg); }
        }
      `}</style>
    </div>
  );
}

export default App;
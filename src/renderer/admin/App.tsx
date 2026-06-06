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
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'zh-CN';

      recognitionRef.current.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join('');
        if (event.results[0].isFinal) {
          sendMessage(transcript);
        }
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }

    const unsubscribeStart = window.electronAPI?.onVoiceStart(() => {
      startListening();
    });
    const unsubscribeStop = window.electronAPI?.onVoiceStop(() => {
      stopListening();
    });
    return () => {
      recognitionRef.current?.stop();
      unsubscribeStart?.();
      unsubscribeStop?.();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const startListening = () => {
    if (recognitionRef.current && !isListening) {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  };

  const sendMessage = async (content: string) => {
    if (!content.trim()) return;

    log('[Z-Bot Admin] 发送消息: ' + content);
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    try {
      log('[Z-Bot Admin] 调用 ollama...');
      const startTime = Date.now();
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:7b-instruct-q4_K_M',
          messages: [...messages, userMessage].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
        }),
      });
      const elapsed = Date.now() - startTime;
      log('[Z-Bot Admin] ollama 响应时间: ' + elapsed + 'ms');

      if (!response.ok) {
        log('[Z-Bot Admin] ollama 错误: ' + response.status);
        return;
      }

      const data = await response.json();
      log('[Z-Bot Admin] ollama 响应: ' + (data.message?.content || '').slice(0, 50));

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.message?.content || '抱歉，我无法理解您的问题。',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // TTS 播放
      await speakText(assistantMessage.content);
    } catch (error: any) {
      log('[Z-Bot Admin] Error: ' + error.message);
    }
  };

  const speakText = async (text: string) => {
    setIsSpeaking(true);
    try {
      const ttsResponse = await fetch('http://localhost:8086/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const ttsData = await ttsResponse.json();
      if (ttsData.audio) {
        const audio = new Audio('data:audio/mp3;base64,' + ttsData.audio);
        audio.onended = () => setIsSpeaking(false);
        audio.play();
      } else {
        setIsSpeaking(false);
      }
    } catch (e) {
      log('[Z-Bot Admin] TTS 错误');
      setIsSpeaking(false);
    }
  };

  const toggleMode = () => {
    window.electronAPI?.toggleWindow('pet');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1a1a2e', color: '#fff' }}>
      <header style={{ padding: '16px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: '20px' }}>Z-Bot 管理端</h1>
        <button onClick={toggleMode} style={{ padding: '8px 16px', background: '#4a4a6a', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer' }}>
          切换到萌宠模式
        </button>
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', marginTop: '40px' }}>
            <p>欢迎使用 Z-Bot 桌面助手</p>
            <p>您可以通过语音或文字与我交流</p>
            <p style={{ fontSize: '12px', marginTop: '20px' }}>💡 点击麦克风按钮开始语音对话</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} style={{ marginBottom: '16px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
              <div style={{ display: 'inline-block', maxWidth: '70%', padding: '12px 16px', borderRadius: '8px', background: msg.role === 'user' ? '#4a4a6a' : '#2a2a3e' }}>
                {msg.content}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ padding: '16px', borderTop: '1px solid #333', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={isListening ? stopListening : startListening}
          style={{ padding: '12px', background: isListening ? '#e74c3c' : '#4a4a6a', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {isListening ? '🎤' : '🎙️'}
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage(input)}
          placeholder="输入消息..."
          style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #333', background: '#2a2a3e', color: '#fff', outline: 'none' }}
        />
        <button onClick={() => sendMessage(input)} style={{ padding: '12px 24px', background: '#4a4a6a', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer' }}>
          发送
        </button>
        {isSpeaking && <span style={{ marginLeft: '8px' }}>🔊 播放中...</span>}
      </div>
    </div>
  );
}

export default App;
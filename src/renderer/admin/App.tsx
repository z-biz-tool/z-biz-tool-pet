import React, { useState, useEffect, useRef } from 'react';
import { SYSTEM_PROMPT, MODEL_NAME } from '../shared/prompts';

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
  const [isCapturing, setIsCapturing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    loadHistory();

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

  const loadHistory = async () => {
    try {
      const history = await window.electronAPI?.getConversationHistory();
      if (history && Array.isArray(history)) {
        setMessages(history);
        log('[Z-Bot Admin] 加载对话历史，共 ' + history.length + ' 条');
      }
    } catch (error) {
      log('[Z-Bot Admin] 加载对话历史失败');
    }
  };

  const saveMessage = async (message: Message) => {
    try {
      await window.electronAPI?.addMessageToHistory(message);
    } catch (error) {
      log('[Z-Bot Admin] 保存消息失败');
    }
  };

  const clearHistory = async () => {
    try {
      await window.electronAPI?.clearConversation();
      setMessages([]);
      log('[Z-Bot Admin] 清空对话历史');
    } catch (error) {
      log('[Z-Bot Admin] 清空对话历史失败');
    }
  };

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

  const captureScreenshot = async () => {
    setIsCapturing(true);
    try {
      const result = await window.electronAPI?.captureScreenshot();
      if (result?.success && result.path) {
        log('[Z-Bot Admin] 截图成功: ' + result.path);
        sendMessage(`我刚截取了屏幕截图，保存路径: ${result.path}。请帮我分析一下屏幕内容。`);
      } else {
        log('[Z-Bot Admin] 截图失败: ' + result?.error);
      }
    } catch (error: any) {
      log('[Z-Bot Admin] 截图错误: ' + error.message);
    } finally {
      setIsCapturing(false);
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
    saveMessage(userMessage);
    setInput('');

    try {
      log('[Z-Bot Admin] 调用 ollama...');
      const startTime = Date.now();
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content },
          ],
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
      saveMessage(assistantMessage);

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
        <h1 style={{ margin: 0, fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          🐱 Z-Bot 桌面伴侣
        </h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          {messages.length > 0 && (
            <button onClick={clearHistory} style={{ padding: '6px 12px', background: '#4a4a6a', border: 'none', borderRadius: '6px', color: '#fff', cursor: 'pointer', fontSize: '12px' }}>
              清空对话
            </button>
          )}
          <button onClick={toggleMode} style={{ padding: '8px 16px', background: '#6a5acd', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '14px' }}>
            切换到萌宠模式
          </button>
        </div>
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', marginTop: '40px' }}>
            <div style={{ fontSize: '64px', marginBottom: '16px' }}>🐱</div>
            <p>欢迎使用 Z-Bot 桌面伴侣</p>
            <p>我是你的专属小猫咪助手，随时陪伴你~</p>
            <p style={{ fontSize: '12px', marginTop: '20px', color: '#aaa' }}>💡 点击麦克风开始语音对话，或点击相机截图分析</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} style={{ marginBottom: '16px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
              <div style={{ display: 'inline-flex', alignItems: 'flex-start', gap: '8px' }}>
                <div style={{ fontSize: '20px', marginTop: '4px' }}>
                  {msg.role === 'user' ? '👤' : '🐱'}
                </div>
                <div style={{ display: 'inline-block', maxWidth: '70%', padding: '12px 16px', borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px', background: msg.role === 'user' ? '#6a5acd' : '#2a2a4e', lineHeight: '1.5' }}>
                  {msg.content}
                </div>
              </div>
              <div style={{ fontSize: '10px', color: '#666', marginTop: '4px', textAlign: msg.role === 'user' ? 'right' : 'left', paddingLeft: msg.role === 'user' ? '0' : '36px', paddingRight: msg.role === 'user' ? '36px' : '0' }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ padding: '16px', borderTop: '1px solid #333', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={isListening ? stopListening : startListening}
          style={{ padding: '12px', background: isListening ? '#e74c3c' : '#6a5acd', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.2s', transform: isListening ? 'scale(1.1)' : 'scale(1)' }}
        >
          {isListening ? '🎤' : '🎙️'}
        </button>
        <button
          onClick={captureScreenshot}
          disabled={isCapturing}
          style={{ padding: '12px', background: isCapturing ? '#555' : '#4a90d9', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {isCapturing ? '⏳' : '📷'}
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage(input)}
          placeholder="和你的小猫咪说点什么吧~"
          style={{ flex: 1, padding: '12px 16px', borderRadius: '16px', border: '1px solid #333', background: '#2a2a3e', color: '#fff', outline: 'none', fontSize: '14px' }}
        />
        <button onClick={() => sendMessage(input)} style={{ padding: '12px 24px', background: '#6a5acd', border: 'none', borderRadius: '16px', color: '#fff', cursor: 'pointer', fontSize: '14px' }}>
          发送
        </button>
        {isSpeaking && <span style={{ marginLeft: '8px', fontSize: '12px', color: '#4a90d9' }}>🔊 播放中...</span>}
      </div>
    </div>
  );
}

export default App;

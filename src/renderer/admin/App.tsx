import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Layout,
  Input,
  Button,
  Avatar,
  Tooltip,
  Tag,
  Card,
  Spin,
  message,
  theme as antdTheme,
  ConfigProvider,
} from 'antd';
import {
  AudioOutlined,
  AudioMutedOutlined,
  CameraOutlined,
  SendOutlined,
  SettingOutlined,
  SwapOutlined,
  DeleteOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import SettingsPanel from './SettingsPanel';
import { DEFAULT_CONFIG, SUGGESTED_QUESTIONS } from '../shared/prompts';

const { Header, Content, Footer } = Layout;
const { TextArea } = Input;

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

/** 简易 Markdown 渲染：代码块 / 行内代码 / 加粗 / 换行 */
function renderMarkdown(text: string): React.ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
      return (
        <pre
          key={idx}
          style={{
            background: 'rgba(0,0,0,0.4)',
            borderRadius: 8,
            padding: '12px',
            margin: '6px 0',
            overflowX: 'auto',
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#e6e6e6',
          }}
        >
          <code>{code}</code>
        </pre>
      );
    }
    // 行内代码 + 加粗 + 换行
    const lines = part.split('\n');
    return (
      <span key={idx}>
        {lines.map((line, li) => (
          <React.Fragment key={li}>
            {renderInline(line)}
            {li < lines.length - 1 && <br />}
          </React.Fragment>
        ))}
      </span>
    );
  });
}

function renderInline(text: string): React.ReactNode {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((t, i) => {
    if (t.startsWith('**') && t.endsWith('**')) {
      return <strong key={i}>{t.slice(2, -2)}</strong>;
    }
    if (t.startsWith('`') && t.endsWith('`')) {
      return (
        <code
          key={i}
          style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: 3, fontFamily: 'ui-monospace, monospace' }}
        >
          {t.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{t}</React.Fragment>;
  });
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<PetConfig>(DEFAULT_CONFIG);
  const [online, setOnline] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  const { token: themeToken } = antdTheme.useToken();
  const accent = config.themeColor || themeToken.colorPrimary;

  // 加载配置 + 历史
  useEffect(() => {
    (async () => {
      try {
        const cfg = await window.electronAPI?.loadConfig();
        if (cfg) setConfig(cfg);
        const history = await window.electronAPI?.loadHistory();
        if (history && Array.isArray(history)) {
          setMessages(history);
          log('[Admin] 加载历史 ' + history.length + ' 条');
        }
      } catch (e) {
        log('[Admin] 初始化失败');
      }
    })();

    // Web Speech API（备用，whisper.cpp 不可用时）
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'zh-CN';
      recognitionRef.current.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((r: any) => r[0].transcript)
          .join('');
        if (event.results[0].isFinal) sendMessage(transcript);
      };
      recognitionRef.current.onend = () => setIsListening(false);
    }

    const unsubStart = window.electronAPI?.onVoiceStart(() => startListening());
    const unsubStop = window.electronAPI?.onVoiceStop(() => stopListening());

    // 检测 ollama 在线状态
    checkOnline();
    const onlineTimer = setInterval(checkOnline, 30000);

    return () => {
      recognitionRef.current?.stop();
      unsubStart?.();
      unsubStop?.();
      clearInterval(onlineTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkOnline = async () => {
    try {
      const res = await fetch(config.ollamaUrl + '/api/tags', { method: 'GET', signal: AbortSignal.timeout(3000) });
      setOnline(res.ok);
    } catch {
      setOnline(false);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 持久化历史（全量覆盖写）
  const persistHistory = useCallback((msgs: ChatMessage[]) => {
    window.electronAPI?.saveHistory(msgs).catch(() => {});
  }, []);

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
        message.success('截图成功');
        sendMessage(`我刚截取了屏幕截图，保存路径: ${result.path}。请帮我分析一下屏幕内容。`);
      } else {
        message.error('截图失败: ' + (result?.error || '未知错误'));
      }
    } catch (e: any) {
      message.error('截图错误: ' + e.message);
    } finally {
      setIsCapturing(false);
    }
  };

  const sendMessage = async (content: string) => {
    if (!content.trim() || isThinking) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    persistHistory(newMsgs);
    setInput('');
    setIsThinking(true);

    try {
      const response = await fetch(config.ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        message.error('模型错误: ' + response.status);
        setIsThinking(false);
        return;
      }

      const data = await response.json();
      const reply = data.message?.content || '抱歉，我无法理解您的问题。';
      const aiMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: reply,
        timestamp: new Date().toISOString(),
      };
      const finalMsgs = [...newMsgs, aiMsg];
      setMessages(finalMsgs);
      persistHistory(finalMsgs);

      speakText(reply);
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setIsThinking(false);
    }
  };

  const speakText = async (text: string) => {
    setIsSpeaking(true);
    try {
      const ttsResponse = await fetch(config.ttsUrl + '/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, speed: config.voiceSpeed }),
      });
      const ttsData = await ttsResponse.json();
      if (ttsData.audio) {
        const audio = new Audio('data:audio/mp3;base64,' + ttsData.audio);
        audio.onended = () => setIsSpeaking(false);
        audio.play();
      } else {
        setIsSpeaking(false);
      }
    } catch {
      setIsSpeaking(false);
    }
  };

  const clearHistory = async () => {
    await window.electronAPI?.clearHistory();
    setMessages([]);
    message.success('已清空对话');
  };

  const toggleMode = () => window.electronAPI?.toggleWindow('pet');

  return (
    <ConfigProvider
      theme={{
        token: { colorPrimary: accent, borderRadius: 10, colorBgBase: '#1a1a2e', colorTextBase: '#ffffff' },
        algorithm: antdTheme.darkAlgorithm,
      }}
    >
      <Layout style={{ height: '100vh', background: '#1a1a2e' }}>
        {/* Header */}
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 20px',
            background: 'linear-gradient(90deg, #16213e 0%, #1a1a2e 100%)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar
              size={40}
              style={{
                background: `linear-gradient(135deg, ${accent}, ${accent}99)`,
                fontSize: 22,
              }}
            >
              🐱
            </Avatar>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{config.petName}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#999' }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: online ? '#52c41a' : '#999',
                    display: 'inline-block',
                    boxShadow: online ? '0 0 6px #52c41a' : 'none',
                  }}
                />
                {online ? '在线' : '离线'}
                {isSpeaking && <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>播放中</Tag>}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Tooltip title="清空对话">
              <Button shape="circle" icon={<DeleteOutlined />} onClick={clearHistory} disabled={messages.length === 0} />
            </Tooltip>
            <Tooltip title="设置">
              <Button shape="circle" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} />
            </Tooltip>
            <Tooltip title="切换到萌宠模式">
              <Button type="primary" icon={<SwapOutlined />} onClick={toggleMode}>
                萌宠
              </Button>
            </Tooltip>
          </div>
        </Header>

        {/* 消息列表 / 空状态 */}
        <Content style={{ overflow: 'auto', padding: 16 }}>
          {messages.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${accent}, ${accent}66)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 52,
                  marginBottom: 20,
                  boxShadow: `0 8px 32px ${accent}55`,
                  animation: 'adminFloat 3s ease-in-out infinite',
                }}
              >
                🐱
              </div>
              <h2 style={{ color: '#fff', marginBottom: 8 }}>欢迎使用 {config.petName}</h2>
              <p style={{ color: '#888', marginBottom: 24 }}>我是你的专属桌面伴侣，随时陪伴你~</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420, width: '100%' }}>
                {SUGGESTED_QUESTIONS.map((q, i) => (
                  <Card
                    key={i}
                    hoverable
                    size="small"
                    onClick={() => sendMessage(q)}
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ color: '#ccc' }}>{q}</span>
                  </Card>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 8 }}
                >
                  {msg.role === 'assistant' && (
                    <Avatar size={32} style={{ background: accent, flexShrink: 0 }}>
                      🐱
                    </Avatar>
                  )}
                  <div style={{ maxWidth: '72%' }}>
                    <div
                      style={{
                        padding: '10px 14px',
                        borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        background: msg.role === 'user' ? accent : 'rgba(255,255,255,0.08)',
                        color: '#fff',
                        lineHeight: 1.6,
                        fontSize: 14,
                        wordBreak: 'break-word',
                      }}
                    >
                      {renderMarkdown(msg.content)}
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 4, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  {msg.role === 'user' && (
                    <Avatar size={32} style={{ background: '#555', flexShrink: 0 }}>
                      我
                    </Avatar>
                  )}
                </div>
              ))}
              {isThinking && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Avatar size={32} style={{ background: accent }}>
                    🐱
                  </Avatar>
                  <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.08)', borderRadius: '16px 16px 16px 4px' }}>
                    <Spin size="small" /> <span style={{ color: '#999', marginLeft: 8 }}>思考中...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </Content>

        {/* 输入区 */}
        <Footer style={{ padding: 12, background: '#16213e', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <Tooltip title={isListening ? '停止录音' : '语音输入'}>
              <Button
                shape="circle"
                size="large"
                danger={isListening}
                icon={isListening ? <AudioMutedOutlined /> : <AudioOutlined />}
                onClick={isListening ? stopListening : startListening}
                style={isListening ? { animation: 'adminPulse 1s infinite' } : undefined}
              />
            </Tooltip>
            <Tooltip title="截图分析">
              <Button
                shape="circle"
                size="large"
                icon={<CameraOutlined />}
                onClick={captureScreenshot}
                loading={isCapturing}
              />
            </Tooltip>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  sendMessage(input);
                }
              }}
              placeholder="和你的小猫咪说点什么吧~ (Enter 发送, Shift+Enter 换行)"
              autoSize={{ minRows: 1, maxRows: 4 }}
              style={{ flex: 1, borderRadius: 20, background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.1)' }}
            />
            <Button
              type="primary"
              shape="circle"
              size="large"
              icon={<SendOutlined />}
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isThinking}
            />
            {isSpeaking && <SoundOutlined style={{ color: accent, fontSize: 18, animation: 'adminPulse 1s infinite' }} />}
          </div>
        </Footer>

        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={setConfig} />

        <style>{`
          @keyframes adminFloat {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-8px); }
          }
          @keyframes adminPulse {
            0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(245,34,45,0.4); }
            50% { transform: scale(1.08); box-shadow: 0 0 0 8px rgba(245,34,45,0); }
          }
        `}</style>
      </Layout>
    </ConfigProvider>
  );
}

export default App;

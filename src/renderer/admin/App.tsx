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
  Modal,
  Collapse,
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
  PushpinOutlined,
  ToolOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import SettingsPanel from './SettingsPanel';
import MeetingPanel from './MeetingPanel';
import { DEFAULT_CONFIG, SUGGESTED_QUESTIONS } from '../shared/prompts';

const { Header, Content, Footer } = Layout;
const { TextArea } = Input;

const log = (msg: string) => {
  console.log(msg);
  window.electronAPI?.log(msg);
};

// 语音打断阈值（可配置，默认30）
const INTERRUPT_THRESHOLD = 30;

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

/** 工具调用状态 */
interface ToolCallState {
  id: string;
  name: string;
  arguments: Record<string, any>;
  status: 'pending' | 'executing' | 'done' | 'error' | 'cancelled';
  result?: string;
}

/** 扩展消息类型，支持工具调用显示 */
interface DisplayMessage extends ChatMessage {
  toolCalls?: ToolCallState[];
}

function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<PetConfig>(DEFAULT_CONFIG);
  const [online, setOnline] = useState(false);
  const [toolDefinitions, setToolDefinitions] = useState<any[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // 语音打断相关 refs
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const isSpeakingRef = useRef(false);
  const interruptStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const interruptAnimFrameRef = useRef<number | null>(null);
  const interruptThresholdRef = useRef(INTERRUPT_THRESHOLD);

  // 工具确认对话框状态
  const [confirmModal, setConfirmModal] = useState<{
    visible: boolean;
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>({ visible: false, id: '', name: '', arguments: {} });

  // 拖放文件状态
  const [isDragOver, setIsDragOver] = useState(false);

  const { token: themeToken } = antdTheme.useToken();
  const accent = config.themeColor || themeToken.colorPrimary;

  // 加载配置 + 历史 + 工具定义
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
        // 加载工具定义
        const tools = await window.electronAPI?.toolsList();
        if (tools) {
          setToolDefinitions(tools);
          log('[Admin] 加载工具定义 ' + tools.length + ' 个');
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

    // 监听语音打断事件
    const unsubInterrupt = window.electronAPI?.onVoiceInterrupt(() => {
      handleVoiceInterrupt();
    });

    // 监听按住快捷键说话
    const unsubPushToTalk = window.electronAPI?.onPushToTalkStart(() => {
      if (isListening) {
        stopListening();
      } else if (isSpeakingRef.current) {
        handleVoiceInterrupt();
      } else {
        startListening();
      }
    });

    // 监听工具确认请求
    const unsubConfirm = window.electronAPI?.onToolsConfirmRequest((data) => {
      setConfirmModal({
        visible: true,
        id: data.id,
        name: data.name,
        arguments: data.arguments,
      });
    });

    // 检测 ollama 在线状态
    checkOnline();
    const onlineTimer = setInterval(checkOnline, 30000);

    return () => {
      recognitionRef.current?.stop();
      stopInterruptListener();
      unsubStart?.();
      unsubStop?.();
      unsubInterrupt?.();
      unsubPushToTalk?.();
      unsubConfirm?.();
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

  // ---------- 语音打断监听 ----------
  const startInterruptListener = async () => {
    if (isSpeakingRef.current && interruptStreamRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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

      const checkVolume = () => {
        if (!isSpeakingRef.current || !analyserRef.current) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;

        if (avg > interruptThresholdRef.current) {
          log('[Admin] 检测到用户说话，音量: ' + avg.toFixed(1));
          handleVoiceInterrupt();
          return;
        }
        interruptAnimFrameRef.current = requestAnimationFrame(checkVolume);
      };
      checkVolume();
    } catch (error: any) {
      log('[Admin] 启动打断监听失败: ' + error.message);
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

  const handleVoiceInterrupt = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    isSpeakingRef.current = false;
    setIsSpeaking(false);
    stopInterruptListener();
    message.info('语音已打断');
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

  // ---------- MCP 工具调用处理 ----------
  const handleToolCalls = async (toolCalls: any[], aiMsgId: string): Promise<string[]> => {
    const results: string[] = [];
    const toolCallStates: ToolCallState[] = toolCalls.map((tc) => ({
      id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.name || tc.function?.name || '',
      arguments: typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function?.arguments || tc.arguments || {},
      status: 'pending' as const,
    }));

    // 更新消息中的工具调用状态
    setMessages((prev) =>
      prev.map((m) => (m.id === aiMsgId ? { ...m, toolCalls: [...toolCallStates] } : m))
    );

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCallStates[i];
      const toolCall: ToolCall = { id: tc.id, name: tc.name, arguments: tc.arguments };

      // 更新状态为执行中
      toolCallStates[i] = { ...tc, status: 'executing' };
      setMessages((prev) =>
        prev.map((m) => (m.id === aiMsgId ? { ...m, toolCalls: [...toolCallStates] } : m))
      );

      try {
        const result = await window.electronAPI?.toolsExecute(toolCall);
        if (result) {
          toolCallStates[i] = {
            ...toolCallStates[i],
            status: result.isError ? 'error' : 'done',
            result: result.result,
          };
          results.push(result.result);
        }
      } catch (e: any) {
        toolCallStates[i] = { ...toolCallStates[i], status: 'error', result: e.message };
        results.push(`工具执行错误: ${e.message}`);
      }

      // 更新状态
      setMessages((prev) =>
        prev.map((m) => (m.id === aiMsgId ? { ...m, toolCalls: [...toolCallStates] } : m))
      );
    }

    return results;
  };

  // ---------- 发送消息（支持MCP工具调用） ----------
  const sendMessage = async (content: string) => {
    if (!content.trim() || isThinking) return;

    const userMsg: DisplayMessage = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    persistHistory(newMsgs.map(({ toolCalls, ...rest }) => rest));
    setInput('');
    setIsThinking(true);

    try {
      // 构建请求体，注入工具定义
      const requestBody: any = {
        model: config.modelName,
        messages: [
          { role: 'system', content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content },
        ],
        stream: false,
      };

      // 如果有工具定义，注入到请求中
      if (toolDefinitions.length > 0) {
        requestBody.tools = toolDefinitions;
      }

      const response = await fetch(config.ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        message.error('模型错误: ' + response.status);
        setIsThinking(false);
        return;
      }

      const data = await response.json();
      let reply = data.message?.content || '抱歉，我无法理解您的问题。';

      // 检查是否有工具调用
      const toolCalls = data.message?.tool_calls || data.tool_calls;
      const aiMsgId = (Date.now() + 1).toString();

      if (toolCalls && toolCalls.length > 0) {
        log('[Admin] 检测到工具调用: ' + toolCalls.length + ' 个');

        // 先显示AI的文本回复（可能为空）
        const aiMsg: DisplayMessage = {
          id: aiMsgId,
          role: 'assistant',
          content: reply || '正在调用工具...',
          timestamp: new Date().toISOString(),
          toolCalls: toolCalls.map((tc: any) => ({
            id: tc.id || `call_${Date.now()}`,
            name: tc.function?.name || tc.name || '',
            arguments: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || tc.arguments || {},
            status: 'pending' as const,
          })),
        };
        const msgsWithAi = [...newMsgs, aiMsg];
        setMessages(msgsWithAi);

        // 执行工具调用
        const toolResults = await handleToolCalls(toolCalls, aiMsgId);

        // 将工具结果发送回AI继续对话
        const toolResultMessages = toolCalls.map((tc: any, idx: number) => ({
          role: 'tool',
          content: toolResults[idx] || '',
          name: tc.function?.name || tc.name || '',
        }));

        const followUpResponse = await fetch(config.ollamaUrl + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.modelName,
            messages: [
              { role: 'system', content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt },
              ...messages.map((m) => ({ role: m.role, content: m.content })),
              { role: 'user', content },
              { role: 'assistant', content: reply },
              ...toolResultMessages,
            ],
            stream: false,
            ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
          }),
        });

        if (followUpResponse.ok) {
          const followUpData = await followUpResponse.json();
          const followUpReply = followUpData.message?.content || '工具调用完成。';

          // 更新AI消息内容
          const finalMsgs = msgsWithAi.map((m) =>
            m.id === aiMsgId ? { ...m, content: followUpReply } : m
          );
          setMessages(finalMsgs);
          persistHistory(finalMsgs.map(({ toolCalls, ...rest }) => rest as ChatMessage));
          speakText(followUpReply);
        }
      } else {
        // 没有工具调用，直接显示回复
        const aiMsg: DisplayMessage = {
          id: aiMsgId,
          role: 'assistant',
          content: reply,
          timestamp: new Date().toISOString(),
        };
        const finalMsgs = [...newMsgs, aiMsg];
        setMessages(finalMsgs);
        persistHistory(finalMsgs.map(({ toolCalls, ...rest }) => rest as ChatMessage));
        speakText(reply);
      }
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setIsThinking(false);
    }
  };

  // ---------- TTS 播放（带打断监听） ----------
  const speakText = async (text: string) => {
    setIsSpeaking(true);
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
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          stopInterruptListener();
        };

        audio.onerror = () => {
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          stopInterruptListener();
        };

        await audio.play();
        // 启动打断监听
        startInterruptListener();
      } else {
        isSpeakingRef.current = false;
        setIsSpeaking(false);
      }
    } catch {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      stopInterruptListener();
    }
  };

  // ---------- 工具确认对话框 ----------
  const handleToolConfirm = (alwaysAllow: boolean) => {
    window.electronAPI?.toolsConfirm(confirmModal.id, alwaysAllow);
    setConfirmModal({ visible: false, id: '', name: '', arguments: {} });
  };

  const handleToolCancel = () => {
    window.electronAPI?.toolsCancel(confirmModal.id);
    setConfirmModal({ visible: false, id: '', name: '', arguments: {} });
  };

  // ---------- 文件拖入处理 ----------
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    for (const file of files) {
      const filePath = (file as any).path || file.name;
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      const textExts = ['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bat'];

      if (imageExts.includes(ext)) {
        // 图片文件: 转base64
        const result = await window.electronAPI?.fileReadAsBase64(filePath);
        if (result?.success && result.base64) {
          sendMessage(`[图片文件: ${file.name}]\n请分析这张图片。`);
        } else {
          message.error(`读取图片失败: ${file.name}`);
        }
      } else if (textExts.includes(ext)) {
        // 文本文件: 读取内容
        const result = await window.electronAPI?.fileRead(filePath);
        if (result?.success && result.content) {
          const content = result.content.slice(0, 3000);
          sendMessage(`[文件: ${file.name}]\n\`\`\`${ext}\n${content}\n\`\`\`\n请帮我分析这个文件。`);
        } else {
          message.error(`读取文件失败: ${file.name}`);
        }
      } else {
        // 其他文件: 只传文件路径
        sendMessage(`[文件: ${file.name}]\n路径: ${filePath}\n请帮我处理这个文件。`);
      }
    }
  };

  // ---------- Pin 卡片 ----------
  const handlePin = async (msg: DisplayMessage) => {
    try {
      await window.electronAPI?.pinCreate(msg.content, msg.id);
      message.success('已钉到桌面');
    } catch (e: any) {
      message.error('Pin失败: ' + e.message);
    }
  };

  const clearHistory = async () => {
    await window.electronAPI?.clearHistory();
    setMessages([]);
    message.success('已清空对话');
  };

  const toggleMode = () => window.electronAPI?.toggleWindow('pet');

  // ---------- 渲染工具调用状态 ----------
  const renderToolCalls = (toolCalls?: ToolCallState[]) => {
    if (!toolCalls || toolCalls.length === 0) return null;

    return (
      <div style={{ marginTop: 8 }}>
        <Collapse
          size="small"
          items={toolCalls.map((tc, idx) => ({
            key: idx,
            label: (
              <span>
                {tc.status === 'done' && <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 6 }} />}
                {tc.status === 'error' && <CloseCircleOutlined style={{ color: '#ff4d4f', marginRight: 6 }} />}
                {tc.status === 'executing' && <Spin size="small" style={{ marginRight: 6 }} />}
                {tc.status === 'pending' && <ToolOutlined style={{ color: '#999', marginRight: 6 }} />}
                {tc.status === 'cancelled' && <ExclamationCircleOutlined style={{ color: '#faad14', marginRight: 6 }} />}
                🔧 {tc.name}
                {tc.status === 'executing' && ' 执行中...'}
                {tc.status === 'done' && ' 完成'}
                {tc.status === 'error' && ' 失败'}
                {tc.status === 'cancelled' && ' 已取消'}
              </span>
            ),
            children: (
              <div>
                <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
                  参数: {JSON.stringify(tc.arguments, null, 2)}
                </div>
                {tc.result && (
                  <div style={{ fontSize: 12, color: tc.status === 'error' ? '#ff4d4f' : '#52c41a' }}>
                    结果: {tc.result.slice(0, 500)}
                  </div>
                )}
              </div>
            ),
          }))}
        />
      </div>
    );
  };

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
                {isSpeaking && <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>播放中(可打断)</Tag>}
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
        <Content
          style={{ overflow: 'auto', padding: 16, position: 'relative' }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* 拖放文件提示 */}
          {isDragOver && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(114, 46, 209, 0.3)',
                border: '2px dashed #722ed1',
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                fontSize: 18,
                color: '#b794f6',
                pointerEvents: 'none',
              }}
            >
              📂 拖放文件到这里
            </div>
          )}

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
                      {/* 工具调用显示 */}
                      {msg.role === 'assistant' && renderToolCalls(msg.toolCalls)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <span style={{ fontSize: 11, color: '#666', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                      {msg.role === 'assistant' && (
                        <Tooltip title="钉到桌面">
                          <PushpinOutlined
                            style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}
                            onClick={() => handlePin(msg)}
                          />
                        </Tooltip>
                      )}
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
              placeholder="和你的小猫咪说点什么吧~ (Enter 发送, Shift+Enter 换行, 支持拖放文件)"
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
            {isSpeaking && (
              <Tooltip title="点击打断">
                <SoundOutlined
                  style={{ color: accent, fontSize: 18, animation: 'adminPulse 1s infinite', cursor: 'pointer' }}
                  onClick={handleVoiceInterrupt}
                />
              </Tooltip>
            )}
          </div>
        </Footer>

        {/* 工具确认对话框 */}
        <Modal
          title={
            <span>
              <ExclamationCircleOutlined style={{ color: '#faad14', marginRight: 8 }} />
              工具调用确认
            </span>
          }
          open={confirmModal.visible}
          onCancel={handleToolCancel}
          footer={[
            <Button key="cancel" onClick={handleToolCancel}>
              拒绝
            </Button>,
            <Button key="allow" type="primary" onClick={() => handleToolConfirm(false)}>
              允许
            </Button>,
            <Button key="always" type="primary" danger onClick={() => handleToolConfirm(true)}>
              始终允许
            </Button>,
          ]}
        >
          <div style={{ marginBottom: 12 }}>
            <strong>工具名称:</strong> {confirmModal.name}
          </div>
          <div>
            <strong>参数:</strong>
            <pre
              style={{
                background: 'rgba(0,0,0,0.4)',
                padding: 8,
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 200,
                overflow: 'auto',
                color: '#e6e6e6',
              }}
            >
              {JSON.stringify(confirmModal.arguments, null, 2)}
            </pre>
          </div>
        </Modal>

        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={setConfig} />

        <div style={{ position: 'absolute', top: 80, right: 16, width: 360, zIndex: 10 }}>
          <MeetingPanel accent={accent} />
        </div>

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

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
  Alert,
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
  StarOutlined,
  SunOutlined,
} from '@ant-design/icons';
import SettingsPanel from './SettingsPanel';
import MeetingPanel from './MeetingPanel';
import QuickCommandPanel from './QuickCommandPanel';
import AchievementPanel from './AchievementPanel';
import SceneryPanel from './SceneryPanel';
import { DEFAULT_CONFIG, SUGGESTED_QUESTIONS } from '../shared/prompts';
import { errorMessage } from '../shared/interaction';

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
  // 历史是异步加载的：先渲染空态会闪一下“欢迎页”，合同四.1 要求加载中与空态分开
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [confirmBusy, setConfirmBusy] = useState(false);
  // 流式回复归属：只把 chunk 写进这条气泡（T3.8）
  const streamMsgIdRef = useRef<string | null>(null);
  const streamBufRef = useRef('');
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
  // 设置面板改了打断阈值后立即生效，无需重开窗口（T4.9）
  useEffect(() => {
    interruptThresholdRef.current = config.interruptThreshold || INTERRUPT_THRESHOLD;
  }, [config.interruptThreshold]);

  // 工具确认对话框状态（字段与 main 的 tools:confirmRequest 契约一致）
  const [confirmModal, setConfirmModal] = useState<{
    visible: boolean;
    id: string;
    name: string;
    arguments: Record<string, any>;
    description: string;
    riskLevel: number;
    allowAlways: boolean;
  }>({ visible: false, id: '', name: '', arguments: {}, description: '', riskLevel: 2, allowAlways: false });

  // 拖放文件状态
  const [isDragOver, setIsDragOver] = useState(false);
  
  // 面板状态
  const [quickCommandOpen, setQuickCommandOpen] = useState(false);
  const [achievementOpen, setAchievementOpen] = useState(false);
  const [sceneryOpen, setSceneryOpen] = useState(false);

  const { token: themeToken } = antdTheme.useToken();
  const accent = config.themeColor || themeToken.colorPrimary;

  const loadHistoryFromMain = async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const history = await window.electronAPI?.loadHistory();
      if (Array.isArray(history)) {
        setMessages(history);
        log('[Admin] 加载历史 ' + history.length + ' 条');
      }
    } catch (error) {
      const reason = errorMessage(error, '主进程无响应');
      setHistoryError('对话历史加载失败：' + reason);
      log('[Admin] 历史加载失败: ' + reason);
    } finally {
      setHistoryLoading(false);
    }
  };

  // 加载配置 + 历史 + 工具定义
  useEffect(() => {
    (async () => {
      try {
        const cfg = await window.electronAPI?.loadConfig();
        if (cfg) setConfig(cfg);
        // 加载工具定义（用于展示，工具执行本身在主进程 ai:chat 内完成）
        const tools = await window.electronAPI?.toolsList();
        if (tools) {
          log('[Admin] 可用工具 ' + tools.length + ' 个');
        }
      } catch (error) {
        log('[Admin] 初始化失败: ' + errorMessage(error, '主进程无响应'));
      }
    })();
    void loadHistoryFromMain();

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

    // 监听工具确认请求：main 发的是 toolCallId，此前误读 data.id 导致确认框永远对不上号（D08）
    const unsubChunk = window.electronAPI?.onAiStreamChunk((chunk) => {
      const msgId = streamMsgIdRef.current;
      if (!msgId || !chunk) return;
      if (chunk.content) {
        streamBufRef.current += chunk.content;
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, content: streamBufRef.current } : m))
        );
      }
    });
    const unsubConfirm = window.electronAPI?.onToolsConfirmRequest((data) => {
      setConfirmModal({
        visible: true,
        id: data.toolCallId,
        name: data.name,
        arguments: data.arguments,
        description: data.description ?? '',
        riskLevel: data.riskLevel ?? 2,
        allowAlways: !!data.allowAlways,
      });
    });

    // 监听快捷键事件（笔记/唤醒/翻译已移除：前两者改为主进程直接落地，翻译取词无跨应用取词能力已下架）
    const unsubShortcutScreenshot = window.electronAPI?.onShortcutScreenshot(() => {
      captureScreenshot();
    });

    // 托盘「设置」= 打开管理端 + 切到设置页（Rust 侧 actions::open_settings 发 open:settings）
    const unsubOpenSettings = window.electronAPI?.onOpenSettings?.(() => setSettingsOpen(true));

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
      unsubShortcutScreenshot?.();
      unsubOpenSettings?.();
      unsubChunk?.();
      clearInterval(onlineTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkOnline = async () => {
    try {
      // 由主进程探测所配置的 AI 提供商，渲染端不再直连 ollama（T3.6 收尾）
      const res = await window.electronAPI?.aiTestConnection();
      setOnline(!!res?.success);
    } catch (error) {
      setOnline(false);
      log('[Admin] 在线探测失败: ' + errorMessage(error, '主进程无响应'));
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 持久化历史（全量覆盖写）
  const persistHistory = useCallback((msgs: ChatMessage[]) => {
    // 后台落盘是 best-effort：失败不回滚气泡，但必须留痕（合同六.1）
    void window.electronAPI?.saveHistory(msgs).catch((error) => {
      log('[Admin] 历史保存失败: ' + errorMessage(error, '主进程无响应'));
    });
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
      // 卸载清理：关不掉也不影响下一次播放，留日志即可
      audioContextRef.current.close().catch((error) => {
        log('[Admin] 关闭打断监听 AudioContext 失败: ' + errorMessage(error, '未知错误'));
      });
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
        message.error('截图失败: ' + (result?.error || '主进程未返回截图'));
      }
    } catch (e) {
      message.error('截图错误: ' + errorMessage(e, '主进程无响应'));
    } finally {
      setIsCapturing(false);
    }
  };

  // ---------- MCP 工具调用处理 ----------
  // 原先这里直接调 electronAPI.toolsExecute() 绕过确认执行工具（D14/04 §2.1）。
  // 现在工具由主进程在 ai:chat 内完成确认与执行，渲染端只负责展示结果。
  const mapToolCallStates = (calls: any[], results: any[]): ToolCallState[] =>
    (calls || []).map((tc: any) => {
      const id = tc.id || `call_${Date.now()}`;
      const result = (results || []).find((tr: any) => tr.toolCallId === id);
      return {
        id,
        name: tc.function?.name || tc.name || '',
        arguments:
          typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || tc.arguments || {},
        status: (result?.isError ? 'error' : 'done') as ToolCallState['status'],
        result: result?.result,
      };
    });

  // ---------- 发送消息（支持MCP工具调用） ----------
  const sendMessage = async (content: string, images?: string[]) => {
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

    const aiMsgId = (Date.now() + 1).toString();
    // 先插入空气泡，流式 chunk 逐字填充（T3.8）
    const placeholder: DisplayMessage = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    };

    try {
      const reqMessages = [
        { role: 'system', content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content, ...(images?.length ? { images } : {}) },
      ];

      setMessages([...newMsgs, placeholder]);
      streamMsgIdRef.current = aiMsgId;
      streamBufRef.current = '';

      // 统一交给主进程：AI 路由、提供商适配、工具注入与确认执行都在 main（T3.6/T3.7）
      const response = await window.electronAPI?.aiStreamChat({
        model: config.modelName,
        messages: reqMessages,
        stream: true,
      });

      const reply =
        response?.content || streamBufRef.current || '抱歉，我无法理解您的问题。';
      const toolCallStates = mapToolCallStates(response?.toolCalls || [], response?.toolResults || []);

      const aiMsg: DisplayMessage = {
        ...placeholder,
        content: reply,
        ...(toolCallStates.length ? { toolCalls: toolCallStates } : {}),
      };
      const finalMsgs = [...newMsgs, aiMsg];
      setMessages(finalMsgs);
      persistHistory(finalMsgs.map(({ toolCalls: _tc, ...rest }) => rest as ChatMessage));
      speakText(reply);
    } catch (error) {
      // 空气泡不能留在界面上冒充“已回复”：把它替换成可见的失败原因
      const reason = errorMessage(error, 'AI 服务无响应');
      message.error('请求失败: ' + reason);
      const failedMsgs: DisplayMessage[] = [
        ...newMsgs,
        { ...placeholder, content: `请求失败：${reason}` },
      ];
      setMessages(failedMsgs);
      persistHistory(failedMsgs.map(({ toolCalls: _tc, ...rest }) => rest as ChatMessage));
    } finally {
      streamMsgIdRef.current = null;
      setIsThinking(false);
    }
  };

  // ---------- TTS 播放（带打断监听） ----------
  const speakText = async (text: string) => {
    setIsSpeaking(true);
    isSpeakingRef.current = true;

    try {
      // 走主进程代理的本地 TTS（T2.5）：渲染端不再直连 8086，也不接触 token
      const ttsData = await window.electronAPI?.voiceSpeak(text);
      if (ttsData?.success && ttsData.audio) {
        const audio = new Audio(`data:audio/${ttsData.format || 'mp3'};base64,${ttsData.audio}`);
        currentAudioRef.current = audio;

        audio.onended = () => {
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          stopInterruptListener();
        };

        audio.onerror = () => {
          log('[Admin] TTS 播放错误，文字回复已保留');
          currentAudioRef.current = null;
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          stopInterruptListener();
        };

        await audio.play();
        // 启动打断监听
        startInterruptListener();
      } else {
        log('[Admin] TTS 失败: ' + (ttsData?.error || '语音合成不可用'));
        isSpeakingRef.current = false;
        setIsSpeaking(false);
      }
    } catch (error) {
      log('[Admin] TTS 异常: ' + errorMessage(error, '未知错误'));
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      stopInterruptListener();
    }
  };

  // ---------- 工具确认对话框 ----------
  const resetConfirmModal = () =>
    setConfirmModal({
      visible: false,
      id: '',
      name: '',
      arguments: {},
      description: '',
      riskLevel: 2,
      allowAlways: false,
    });

  const handleToolConfirm = async (alwaysAllow: boolean) => {
    if (confirmBusy) return;
    setConfirmBusy(true);
    try {
      // approved 与 alwaysAllow 是两个独立字段（04 §3.4）
      await window.electronAPI?.toolsConfirm(
        confirmModal.id,
        true,
        alwaysAllow && confirmModal.allowAlways
      );
      resetConfirmModal();
    } catch (error) {
      // 失败时保留弹窗，用户可以重试或改为拒绝
      message.error('确认失败：' + errorMessage(error, '主进程无响应'));
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleToolCancel = async () => {
    if (confirmBusy) return;
    setConfirmBusy(true);
    try {
      await window.electronAPI?.toolsCancel(confirmModal.id);
      resetConfirmModal();
    } catch (error) {
      message.error('取消失败：' + errorMessage(error, '主进程无响应'));
    } finally {
      setConfirmBusy(false);
    }
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
    if (isThinking) {
      message.warning('上一条回复还在生成，请完成后再拖入文件');
      return;
    }

    for (const file of files) {
      const filePath = (file as any).path || file.name;
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      const textExts = ['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bat'];

      try {
        if (imageExts.includes(ext)) {
          // 图片文件: 读 base64 并真正作为 images 送入 AI（此前读完就丢，只发了一句“请分析图片”）
          const result = await window.electronAPI?.fileReadAsBase64(filePath);
          if (result?.success && result.base64) {
            await sendMessage(`[图片文件: ${file.name}]\n请分析这张图片。`, [result.base64]);
          } else {
            message.error(`读取图片失败: ${file.name}${result?.error ? '（' + result.error + '）' : ''}`);
          }
        } else if (textExts.includes(ext)) {
          // 文本文件: 读取内容
          const result = await window.electronAPI?.fileRead(filePath);
          if (result?.success && result.content) {
            const content = result.content.slice(0, 3000);
            await sendMessage(`[文件: ${file.name}]\n\`\`\`${ext}\n${content}\n\`\`\`\n请帮我分析这个文件。`);
          } else {
            message.error(`读取文件失败: ${file.name}${result?.error ? '（' + result.error + '）' : ''}`);
          }
        } else {
          // 其他文件: 只传文件路径
          await sendMessage(`[文件: ${file.name}]\n路径: ${filePath}\n请帮我处理这个文件。`);
        }
      } catch (error) {
        message.error(`处理文件失败: ${file.name}（${errorMessage(error, '读取失败')}）`);
      }
    }
  };

  // ---------- Pin 卡片 ----------
  const handlePin = async (msg: DisplayMessage) => {
    const api = window.electronAPI;
    if (!api) {
      message.error('Pin 失败：主进程通道不可用');
      return;
    }
    try {
      await api.pinCreate(msg.content);
      message.success('已钉到桌面');
    } catch (e) {
      message.error('Pin失败: ' + errorMessage(e, '主进程无响应'));
    }
  };

  const clearHistory = () => {
    if (messages.length === 0) return;
    // 破坏性操作：确认文案带数量与“不可恢复”，默认焦点在取消（合同三）
    Modal.confirm({
      title: '清空全部对话记录？',
      content: `将删除 ${messages.length} 条对话，不可恢复。`,
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      autoFocusButton: 'cancel',
      centered: true,
      onOk: async () => {
        try {
          await window.electronAPI?.clearHistory();
          setMessages([]);
          setHistoryError('');
          message.success(`已清空 ${messages.length} 条对话`);
        } catch (error) {
          message.error('清空失败：' + errorMessage(error, '主进程无响应'));
        }
      },
    });
  };

  const toggleMode = () => {
    const api = window.electronAPI;
    if (!api) {
      message.error('切换失败：主进程通道不可用');
      return;
    }
    api.toggleWindow('pet').catch((error) => {
      log('[Admin] 切换萌宠模式失败: ' + errorMessage(error, '主进程无响应'));
      message.error('切换失败：' + errorMessage(error, '主进程无响应'));
    });
  };

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
              <Button aria-label="清空对话" shape="circle" icon={<DeleteOutlined />} onClick={clearHistory} disabled={messages.length === 0} />
            </Tooltip>
            <Tooltip title="快捷指令">
              <Button aria-label="快捷指令" shape="circle" icon={<ToolOutlined />} onClick={() => setQuickCommandOpen(true)} />
            </Tooltip>
            <Tooltip title="成就系统">
              <Button aria-label="成就系统" shape="circle" icon={<StarOutlined />} onClick={() => setAchievementOpen(true)} />
            </Tooltip>
            <Tooltip title="场景特效">
              <Button aria-label="场景特效" shape="circle" icon={<SunOutlined />} onClick={() => setSceneryOpen(true)} />
            </Tooltip>
            <Tooltip title="设置">
              <Button aria-label="设置" shape="circle" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} />
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

          {historyLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
              <Spin size="large" />
              <span style={{ color: '#999' }}>加载对话历史...</span>
            </div>
          ) : messages.length === 0 && historyError ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Alert
                type="error"
                showIcon
                message="对话历史加载失败"
                description={historyError}
                action={
                  <Button size="small" onClick={() => void loadHistoryFromMain()}>
                    重试
                  </Button>
                }
              />
            </div>
          ) : messages.length === 0 ? (
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
                            role="button"
                            tabIndex={0}
                            aria-label="钉到桌面"
                            style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}
                            onClick={() => void handlePin(msg)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                void handlePin(msg);
                              }
                            }}
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
                aria-label={isListening ? '停止录音' : '语音输入'}
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
                aria-label="截图分析"
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
              aria-label="发送消息"
              icon={<SendOutlined />}
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isThinking}
            />
            {isSpeaking && (
              <Tooltip title="点击打断">
                <SoundOutlined
                  role="button"
                  tabIndex={0}
                  aria-label="打断语音播放"
                  style={{ color: accent, fontSize: 18, animation: 'adminPulse 1s infinite', cursor: 'pointer' }}
                  onClick={handleVoiceInterrupt}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleVoiceInterrupt();
                    }
                  }}
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
          onCancel={() => { void handleToolCancel(); }}
          closable={!confirmBusy}
          maskClosable={false}
          footer={[
            <Button key="cancel" autoFocus disabled={confirmBusy} onClick={() => { void handleToolCancel(); }}>
              拒绝
            </Button>,
            <Button key="allow" type="primary" loading={confirmBusy} onClick={() => { void handleToolConfirm(false); }}>
              允许
            </Button>,
            confirmModal.allowAlways ? (
              <Button key="always" type="primary" danger disabled={confirmBusy} onClick={() => { void handleToolConfirm(true); }}>
                始终允许
              </Button>
            ) : null,
          ]}
        >
          <div style={{ marginBottom: 12 }}>
            <strong>工具名称:</strong> {confirmModal.name}
            {confirmModal.description && (
              <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{confirmModal.description}</div>
            )}
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

        {/* 三个面板内部只有 Card，没有自己的浮层；不套 Modal 时按钮只改 state、界面无变化 */}
        <Modal open={quickCommandOpen} onCancel={() => setQuickCommandOpen(false)} footer={null} width={900}>
          <QuickCommandPanel open={quickCommandOpen} onClose={() => setQuickCommandOpen(false)} />
        </Modal>
        <Modal open={achievementOpen} onCancel={() => setAchievementOpen(false)} footer={null} width={1000}>
          <AchievementPanel open={achievementOpen} onClose={() => setAchievementOpen(false)} />
        </Modal>
        <Modal open={sceneryOpen} onCancel={() => setSceneryOpen(false)} footer={null} width={900}>
          <SceneryPanel open={sceneryOpen} onClose={() => setSceneryOpen(false)} />
        </Modal>

        <div style={{ position: 'absolute', top: 80, right: 16, width: 360, zIndex: 10 }}>
          <MeetingPanel accent={accent} />
        </div>

        <style>{`
          /* 默认 body 有 8px 外边距，会让 100vh 布局多出 16px 并冒出滚动条 */
          html, body, #root { height: 100%; margin: 0; }
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

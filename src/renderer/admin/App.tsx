import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Input,
  Button,
  Tooltip,
  Spin,
  message,
  theme as antdTheme,
  ConfigProvider,
  Modal,
  Collapse,
} from 'antd';
import {
  AudioOutlined,
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
  CloseOutlined,
  CustomerServiceOutlined,
  ArrowRightOutlined,
  LoadingOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import SettingsPanel from './SettingsPanel';
import MeetingPanel from './MeetingPanel';
import QuickCommandPanel from './QuickCommandPanel';
import AchievementPanel from './AchievementPanel';
import SceneryPanel from './SceneryPanel';
import MemoryPanel from './MemoryPanel';
import { DEFAULT_CONFIG, SUGGESTED_QUESTIONS } from '../shared/prompts';
import { errorMessage } from '../shared/interaction';
import { characterOf } from '../pet/characters';
import './admin.css';

/** 旧版猫咪名，出现即视为「用户没改过名」 */
const LEGACY_PET_NAME = 'Z-Bot 小猫咪';

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
        <pre key={idx} className="md-pre">
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
        <code key={i} className="md-code">
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
  const [memoryOpen, setMemoryOpen] = useState(false);

  /**
   * 右侧栏同一时刻只放一块内容：设置优先于会议。
   * 旧实现里会议面板是 `position:absolute; top:80; right:16` 的死浮层，
   * 不管用不用都压在消息流右上角；现在它和设置共用同一列。
   */
  const [meetingOpen, setMeetingOpen] = useState(false);

  // 此前用 useToken() 兜底，但它跑在 ConfigProvider 之外，拿到的是浅色默认主题的
  // token（colorPrimary = #1677ff），配暗色界面很突兀；直接用配置里的主题色。
  const accent = config.themeColor || DEFAULT_CONFIG.themeColor;
  const providerLabel =
    config.providers?.find((p) => p.id === config.aiProvider)?.name || config.aiProvider || 'ollama';
  const activeModel = config.aiModel || config.modelName;

  /**
   * 显示名与宠物窗口同一套规则：配置里没改名、或还留着旧版猫咪名，就用当前角色的名字。
   * 否则管理端写「Z-Bot 小猫咪」、桌面上写「茉白」，同一个她有两个名字。
   */
  const persona = characterOf(config.currentSkinId || '');
  const petDisplayName =
    !config.petName?.trim() || config.petName.trim() === LEGACY_PET_NAME
      ? persona.name
      : config.petName.trim();

  const openSettings = () => {
    setMeetingOpen(false);
    setSettingsOpen(true);
  };
  const toggleMeeting = () => {
    setSettingsOpen(false);
    setMeetingOpen((v) => !v);
  };

  // antd 的 Modal 用 portal 挂到 body，DOM 上不在 .adm-root 里，读不到那里的自定义属性。
  // 强调色额外写一份到 :root，弹窗里的 color-mix(… var(--accent) …) 才有值。
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);

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
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: accent,
          colorBgBase: '#0a0c11',
          colorTextBase: '#e9ecf4',
          colorBgContainer: '#12161d',
          colorBgElevated: '#161b24',
          colorBorder: 'rgba(255,255,255,0.10)',
          colorBorderSecondary: 'rgba(255,255,255,0.06)',
          borderRadius: 9,
          fontSize: 13,
          controlHeight: 34,
          controlOutline: 'transparent',
        },
        components: {
          Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
          Modal: { contentBg: '#0f131a', headerBg: '#0f131a' },
          Table: { headerBg: '#131822', rowHoverBg: 'rgba(255,255,255,0.04)' },
        },
      }}
    >
      {/* --accent 注入到令牌层：CSS 里所有 color-mix(in srgb, var(--accent) …) 都跟着设置页的主题色走 */}
      <div className="adm-root" style={{ '--accent': accent } as React.CSSProperties}>
        {/* 顶栏不用 antd Header：它自带 line-height:64px，会被内部两行文本继承，
            整块内容高 82px、居中后顶部溢出 9px，在窗口顶端被裁掉半截（v1.2.0 的实拍现象） */}
        <header className="adm-bar">
          <div className="adm-brand">
            <span className="adm-brand-mark">
              z<em>Biz</em>
            </span>
            <span className="adm-brand-sub">管理端</span>
          </div>

          <div className="adm-pill" title={`${providerLabel} · ${activeModel}`}>
            <i className={`adm-dot ${online ? 'on' : ''}`} />
            <span>{online ? '在线' : '离线'}</span>
            <span className="adm-pill-sep" />
            <span className="adm-pill-meta">
              {providerLabel} · {activeModel}
            </span>
          </div>

          {isSpeaking && (
            <button type="button" className="adm-pill is-live" onClick={handleVoiceInterrupt} title="点击打断播报">
              <SoundOutlined /> 播报中 · 可打断
            </button>
          )}

          <div className="adm-bar-actions">
            <Tooltip title="清空对话">
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="清空对话"
                onClick={clearHistory}
                disabled={messages.length === 0}
              >
                <DeleteOutlined />
              </button>
            </Tooltip>
            <Tooltip title="快捷指令">
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="快捷指令"
                onClick={() => setQuickCommandOpen(true)}
              >
                <ToolOutlined />
              </button>
            </Tooltip>
            <Tooltip title="成就">
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="成就"
                onClick={() => setAchievementOpen(true)}
              >
                <StarOutlined />
              </button>
            </Tooltip>
            <Tooltip title="场景与粒子">
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="场景与粒子"
                onClick={() => setSceneryOpen(true)}
              >
                <SunOutlined />
              </button>
            </Tooltip>
            <Tooltip title="她的记忆">
              <button
                type="button"
                className={`adm-iconbtn ${memoryOpen ? 'is-active' : ''}`}
                aria-label="她的记忆"
                aria-pressed={memoryOpen}
                onClick={() => setMemoryOpen((v) => !v)}
              >
                <BulbOutlined />
              </button>
            </Tooltip>
            <Tooltip title="会议实时转录">
              <button
                type="button"
                className={`adm-iconbtn ${meetingOpen ? 'is-active' : ''}`}
                aria-label="会议实时转录"
                aria-pressed={meetingOpen}
                onClick={toggleMeeting}
              >
                <CustomerServiceOutlined />
              </button>
            </Tooltip>
            <Tooltip title="设置">
              <button
                type="button"
                className={`adm-iconbtn ${settingsOpen ? 'is-active' : ''}`}
                aria-label="设置"
                aria-pressed={settingsOpen}
                onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
              >
                <SettingOutlined />
              </button>
            </Tooltip>
            <span className="adm-bar-sep" />
            <Tooltip title="收起管理端，回到桌面">
              <Button type="primary" size="small" icon={<SwapOutlined />} onClick={toggleMode}>
                回桌面
              </Button>
            </Tooltip>
          </div>
        </header>

        <div className={`adm-body ${settingsOpen || meetingOpen ? 'has-side' : ''}`}>
          <main
            className="adm-main"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {isDragOver && (
              <div className="adm-drop">
                <span>📂 松开即可发送文件</span>
              </div>
            )}

            <div className="adm-scroll">
              {historyLoading ? (
                <div className="adm-state">
                  <Spin size="large" />
                  <span>正在载入对话…</span>
                </div>
              ) : messages.length === 0 && historyError ? (
                <div className="adm-state">
                  <div className="adm-callout err" style={{ maxWidth: 520, textAlign: 'left' }}>
                    <strong>对话历史加载失败</strong>
                    <div style={{ marginTop: 4 }}>{historyError}</div>
                  </div>
                  <Button size="small" onClick={() => void loadHistoryFromMain()}>
                    重试
                  </Button>
                </div>
              ) : messages.length === 0 ? (
                <div className="adm-hero">
                  {/* 空态放她的头像：这是「她」的对话窗口，不是通用聊天框 */}
                  <img className="adm-hero-face" src={persona.face} alt="" draggable={false} />
                  <span className="adm-hero-eyebrow">zBiz · 桌面伴侣</span>
                  <h1 className="adm-hero-title">今天想聊点什么？</h1>
                  <p className="adm-hero-sub">{petDisplayName} 在线 · 长按桌面上的她也能直接说话</p>
                  <div className="adm-sug">
                    {SUGGESTED_QUESTIONS.map((q, i) => (
                      <button key={i} type="button" className="adm-sug-item" onClick={() => sendMessage(q)}>
                        <span className="adm-sug-text">{q}</span>
                        <ArrowRightOutlined className="adm-sug-arrow" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="adm-col adm-msgs">
                  {messages.map((msg) => (
                    <div key={msg.id} className={`adm-row ${msg.role === 'user' ? 'me' : 'ai'}`}>
                      <div className="adm-bubble">
                        {renderMarkdown(msg.content)}
                        {msg.role === 'assistant' && renderToolCalls(msg.toolCalls)}
                      </div>
                      <div className="adm-meta">
                        <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        {msg.role === 'assistant' && (
                          <Tooltip title="钉到桌面">
                            <PushpinOutlined
                              className="adm-meta-btn"
                              role="button"
                              tabIndex={0}
                              aria-label="钉到桌面"
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
                  ))}

                  {isThinking && (
                    <div className="adm-thinking">
                      <span className="adm-thinking-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>正在生成回复…</span>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            <div className="adm-composer">
              <div className="adm-composer-in">
                <div className="adm-input">
                  <div className="adm-tools">
                    <Tooltip title={isListening ? '停止录音' : '语音输入'}>
                      <button
                        type="button"
                        className={`adm-iconbtn ${isListening ? 'is-live' : ''}`}
                        aria-label={isListening ? '停止录音' : '语音输入'}
                        aria-pressed={isListening}
                        onClick={isListening ? stopListening : startListening}
                      >
                        <AudioOutlined />
                      </button>
                    </Tooltip>
                    <Tooltip title="截图分析">
                      <button
                        type="button"
                        className="adm-iconbtn"
                        aria-label="截图分析"
                        onClick={captureScreenshot}
                        disabled={isCapturing}
                      >
                        {isCapturing ? <LoadingOutlined /> : <CameraOutlined />}
                      </button>
                    </Tooltip>
                  </div>

                  <TextArea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onPressEnter={(e) => {
                      if (!e.shiftKey) {
                        e.preventDefault();
                        void sendMessage(input);
                      }
                    }}
                    placeholder={`和 ${petDisplayName} 说点什么…`}
                    autoSize={{ minRows: 1, maxRows: 5 }}
                    variant="borderless"
                  />

                  <button
                    type="button"
                    className="adm-send"
                    aria-label="发送消息"
                    onClick={() => void sendMessage(input)}
                    disabled={!input.trim() || isThinking}
                  >
                    <SendOutlined />
                  </button>
                </div>

                <div className="adm-hint">
                  <span>
                    <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · 可拖入文件或图片
                  </span>
                  <span>{activeModel}</span>
                </div>
              </div>
            </div>
          </main>

          <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={setConfig} />

          <aside
            className={`adm-side ${meetingOpen ? 'is-open' : ''}`}
            aria-label="会议实时转录"
            inert={!meetingOpen}
          >
            <div className="adm-side-head">
              <span className="adm-side-head-ico">
                <CustomerServiceOutlined />
              </span>
              <span className="adm-side-title">会议实时转录</span>
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="关闭会议面板"
                onClick={() => setMeetingOpen(false)}
              >
                <CloseOutlined />
              </button>
            </div>
            <div className="adm-side-body">
              <MeetingPanel />
            </div>
          </aside>
        </div>

        {/* 工具确认对话框 */}
        <Modal
          title={
            <span>
              <ExclamationCircleOutlined style={{ color: '#faad14', marginRight: 8 }} />
              工具调用确认
            </span>
          }
          open={confirmModal.visible}
          onCancel={() => {
            void handleToolCancel();
          }}
          closable={!confirmBusy}
          maskClosable={false}
          centered
          footer={[
            <Button key="cancel" autoFocus disabled={confirmBusy} onClick={() => void handleToolCancel()}>
              拒绝
            </Button>,
            <Button key="allow" type="primary" loading={confirmBusy} onClick={() => void handleToolConfirm(false)}>
              允许
            </Button>,
            confirmModal.allowAlways ? (
              <Button key="always" type="primary" danger disabled={confirmBusy} onClick={() => void handleToolConfirm(true)}>
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
            <pre className="md-pre" style={{ maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(confirmModal.arguments, null, 2)}
            </pre>
          </div>
        </Modal>

        {/* 三个面板此前都没有 Modal 标题，只有浮在角落的关闭按钮；也没有卡片外的边距约束 */}
        <Modal
          title="快捷指令"
          open={quickCommandOpen}
          onCancel={() => setQuickCommandOpen(false)}
          footer={null}
          centered
          width="min(920px, 92vw)"
          destroyOnHidden
        >
          <QuickCommandPanel open={quickCommandOpen} onClose={() => setQuickCommandOpen(false)} />
        </Modal>
        <Modal
          title="成就"
          open={achievementOpen}
          onCancel={() => setAchievementOpen(false)}
          footer={null}
          centered
          width="min(980px, 94vw)"
          destroyOnHidden
        >
          <AchievementPanel open={achievementOpen} onClose={() => setAchievementOpen(false)} />
        </Modal>
        <Modal
          title="场景与粒子"
          open={sceneryOpen}
          onCancel={() => setSceneryOpen(false)}
          footer={null}
          centered
          width="min(900px, 92vw)"
          destroyOnHidden
        >
          <SceneryPanel open={sceneryOpen} onClose={() => setSceneryOpen(false)} />
          <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />
        </Modal>
      </div>
    </ConfigProvider>
  );
}

export default App;

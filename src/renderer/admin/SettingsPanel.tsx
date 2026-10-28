import React, { useState, useEffect, useRef } from 'react';
import { Form, Input, InputNumber, Button, Divider, Select, message, Tag, Popconfirm, Switch } from 'antd';
import {
  SaveOutlined,
  ReloadOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  LoadingOutlined,
  EyeOutlined,
  SettingOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { DEFAULT_CONFIG, SCENE_PROMPTS } from '../shared/prompts';
import { errorMessage } from '../shared/interaction';
import './admin.css';

const { TextArea } = Input;

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: PetConfig) => void;
}

const THEME_COLORS = [
  { label: 'zBiz 薄荷（默认）', value: '#4ecdc4' },
  { label: '魅影紫', value: '#722ed1' },
  { label: '极客蓝', value: '#1677ff' },
  { label: '薄荷绿', value: '#52c41a' },
  { label: '热情红', value: '#f5222d' },
  { label: '暖阳橙', value: '#fa8c16' },
  { label: '青碧色', value: '#13c2c2' },
  { label: '樱花粉', value: '#eb2f96' },
  { label: '石墨灰', value: '#595959' },
];

const PROVIDER_TYPE_OPTIONS = [
  { label: '🦙 Ollama (本地)', value: 'ollama' },
  { label: '🤖 OpenAI', value: 'openai' },
  { label: '🧠 Claude', value: 'claude' },
  { label: '💎 Gemini', value: 'gemini' },
  { label: '🔍 DeepSeek', value: 'deepseek' },
  { label: '☁️ 通义千问', value: 'qwen' },
  { label: '🔧 自定义 (OpenAI兼容)', value: 'custom' },
];

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; models: string[]; supportsVision: boolean }> = {
  ollama: { baseUrl: 'http://localhost:11434', models: ['qwen2.5:7b-instruct-q4_K_M', 'llama3.2-vision'], supportsVision: true },
  openai: { baseUrl: 'https://api.openai.com', models: ['gpt-4o', 'gpt-4o-mini'], supportsVision: true },
  claude: { baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'], supportsVision: true },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-2.0-flash', 'gemini-1.5-pro'], supportsVision: true },
  deepseek: { baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'], supportsVision: false },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', models: ['qwen-plus', 'qwen-turbo', 'qwen-vl-plus'], supportsVision: true },
  custom: { baseUrl: '', models: [], supportsVision: false },
};

interface SttModelInfo {
  current: string;
  modelsDir: string;
  models: { id: string; path: string; installed: boolean }[];
}

interface ShortcutRow {
  key: string;
  label: string;
  accelerator: string;
  defaultAccelerator: string;
  registered: boolean;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ open, onClose, onSave }) => {
  const [form] = Form.useForm<PetConfig>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [currentProviderId, setCurrentProviderId] = useState<string>('ollama');
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [sttInfo, setSttInfo] = useState<SttModelInfo | null>(null);
  const [shortcutRows, setShortcutRows] = useState<ShortcutRow[]>([]);
  const [updateText, setUpdateText] = useState<string>('尚未检查');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // 未保存提示：468px 的侧栏里「保存」在底部，滚动到中间时完全看不见，
  // 得让用户知道自己改过东西（此前改完直接关掉窗口 = 白改）
  const [dirty, setDirty] = useState(false);
  // 心智层探活结果：延迟是这里唯一真正重要的数字 ——
  // 20 秒才回一句的模型，做内心活动会让桌宠看起来像卡住了
  const [mindProbe, setMindProbe] = useState<{
    ok: boolean;
    latencyMs?: number;
    reply?: string;
    verdict?: string;
    error?: string;
    protocol?: string;
    switched?: boolean;
  } | null>(null);
  const [probingMind, setProbingMind] = useState(false);

  // 2026-10-21：ref 转发层，修 ESLint 报的 "useEffect has a missing dependency: 'loadConfig'"。
  // 原来 `loadConfig` 是本文件里**普通函数**（不是 useCallback），且定义在调用它的
  // effect **之后**（effect 在 76 行，定义在 154 行）⇒ effect 闭包捕获的是**首次渲染**的
  // 那份函数实例。今天它只依赖稳定的 `form` 与 setter，行为上等价；
  // 但一旦它内部用上随渲染变化的 state/props，闭包就会**静默过期**。
  // 修法与 App.tsx 同款：闭包里读 ref.current（永远是最新实现），依赖数组不动。
  const loadConfigRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (open) {
      loadConfigRef.current?.();
    }
  }, [open]);

  // 主进程检查到结果会推过来（启动时自动检查一次）
  useEffect(() => {
    const off = window.electronAPI?.onUpdateStatus?.((payload: any) => {
      setUpdateText(describeUpdate(payload));
      setUpdateAvailable(payload?.status === 'available' || payload?.status === 'downloaded');
    });
    return () => {
      off?.();
    };
  }, []);

  const describeUpdate = (r: any): string => {
    if (!r) return '尚未检查';
    switch (r.status) {
      case 'available':
        return '发现新版本 ' + (r.version || '');
      case 'not-available':
        return '已是最新版本';
      case 'downloaded':
        return '更新已下载，重启后生效';
      case 'dev-mode':
        return '开发模式下不检查更新';
      case 'no-feed':
        return '未配置发布源：设置 ZBOT_UPDATE_FEED_URL 或 ~/.z-bot/update-feed.json';
      default:
        return r.reason || '检查失败';
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const r: any = await window.electronAPI?.updateCheck();
      setUpdateText(describeUpdate(r));
      setUpdateAvailable(r?.status === 'available' || r?.status === 'downloaded');
    } catch (e) {
      const reason = errorMessage(e, '主进程无响应');
      setUpdateText('检查失败: ' + reason);
      message.error('检查更新失败: ' + reason);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    setInstalling(true);
    try {
      const r: any = await window.electronAPI?.updateInstall();
      if (!r?.ok) message.error('安装失败: ' + (r?.reason || '未知错误'));
    } catch (e) {
      message.error('安装失败: ' + errorMessage(e, '主进程无响应'));
    } finally {
      setInstalling(false);
    }
  };

  const loadRuntimeOptions = async () => {
    try {
      const info = await window.electronAPI?.sttModels();
      if (info) setSttInfo(info as SttModelInfo);
      const rows = await window.electronAPI?.shortcutsList();
      if (rows) setShortcutRows(rows as ShortcutRow[]);
    } catch (e) {
      // 设置面板仍可用；运行时能力（STT 模型/快捷键）读不到就保持空列表并留痕
      console.warn('[Admin] 运行时选项读取失败:', errorMessage(e, '主进程无响应'));
    }
  };

  const applyShortcuts = async () => {
    const overrides: Record<string, string> = {};
    shortcutRows.forEach((r) => {
      overrides[r.key] = r.accelerator;
    });
    try {
      const res: any = await window.electronAPI?.shortcutsUpdate(overrides);
      if (res?.ok) {
        message.success('快捷键已更新');
      } else {
        const bad = [...(res?.failed || []), ...(res?.rejected || [])];
        message.warning('部分快捷键未生效: ' + (bad.join('、') || '主进程未返回详情'));
      }
      await loadRuntimeOptions();
    } catch (e) {
      message.error('快捷键更新失败: ' + errorMessage(e, '主进程无响应'));
    }
  };

  const reportApplied = (applied?: { sttModel?: boolean; shortcuts?: boolean }) => {
    if (applied?.sttModel) message.success('语音识别服务已按新模型重启');
    if (applied && applied.shortcuts === false) message.warning('部分快捷键注册失败，可能已被其他应用占用');
    message.success('设置已保存');
  };

  const loadConfig = async () => {
    setLoading(true);
    try {
      const config = await window.electronAPI?.loadConfig();
      void loadRuntimeOptions();
      if (config) {
        // 用默认值垫底：后端每加一个配置项，老用户磁盘上的 config.json 就少一个键，
        // 直接 setFieldsValue 会让那个下拉框显示成空白（既不是"未设置"也不是某个选项）。
        // 这里垫一次底，以后新增字段不用再改这个文件。
        form.setFieldsValue({ ...DEFAULT_CONFIG, ...config });
        setProviders(config.providers || []);
        setCurrentProviderId(config.aiProvider || 'ollama');
        // 加载当前提供商的模型列表
        if (config.aiProvider) {
          const provider = (config.providers || []).find((p: AIProvider) => p.id === config.aiProvider);
          if (provider) {
            setAvailableModels(provider.models || []);
          }
        }
      } else {
        form.setFieldsValue(DEFAULT_CONFIG);
        // 加载内置提供商
        const builtins = await window.electronAPI?.aiGetBuiltinProviders();
        if (builtins) {
          setProviders(builtins);
        }
      }
    } catch (e) {
      form.setFieldsValue(DEFAULT_CONFIG);
      message.warning('配置读取失败，已载入默认值：' + errorMessage(e, '主进程无响应'));
    } finally {
      setLoading(false);
      // setFieldsValue 不会触发 onValuesChange，但要显式清一次：从磁盘读回来的值就是「已保存」状态
      setDirty(false);
    }
  };
  // ref 转发：让 76 行的 effect 能调到最新实现
  loadConfigRef.current = loadConfig;

  const handleSave = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      const configToSave = {
        ...values,
        providers,
      };
      const saved: any = await window.electronAPI?.saveConfig(configToSave);
      onSave(configToSave);
      reportApplied(saved?.applied);
      await loadRuntimeOptions();
      setDirty(false);
      onClose();
    } catch (e: any) {
      // validateFields 的 reject 是表单校验结果，不是“保存失败”，不能混为一谈
      if (e && typeof e === 'object' && 'errorFields' in e) {
        message.warning('请先修正表单中的必填项');
      } else {
        message.error('保存失败: ' + errorMessage(e, '主进程无响应'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    form.setFieldsValue(DEFAULT_CONFIG);
    message.info('已重置为默认设置（需点击保存生效）');
  };

  const handleSceneChange = (key: string) => {
    const scene = SCENE_PROMPTS.find((s) => s.key === key);
    if (scene) {
      form.setFieldValue('systemPrompt', scene.prompt);
      message.success(`已切换到「${scene.label}」提示词`);
    }
  };

  // ---------- AI 提供商管理 ----------

  const handleProviderChange = (providerId: string) => {
    setCurrentProviderId(providerId);
    setConnectionResult(null);
    const provider = providers.find((p) => p.id === providerId);
    if (provider) {
      form.setFieldsValue({
        aiProvider: providerId,
        aiBaseUrl: provider.baseUrl,
        aiApiKey: provider.apiKey || '',
        aiModel: provider.models[0] || '',
      });
      setAvailableModels(provider.models);
    }
  };

  const handleProviderTypeChange = (type: string) => {
    const defaults = PROVIDER_DEFAULTS[type] || PROVIDER_DEFAULTS.custom;
    const newProvider: AIProvider = {
      id: `custom_${Date.now()}`,
      name: PROVIDER_TYPE_OPTIONS.find((o) => o.value === type)?.label || type,
      type: type as AIProvider['type'],
      baseUrl: defaults.baseUrl,
      apiKey: '',
      models: defaults.models,
      supportsVision: defaults.supportsVision,
      supportsStreaming: true,
      supportsTools: type !== 'gemini',
    };
    setProviders((prev) => [...prev, newProvider]);
    setCurrentProviderId(newProvider.id);
    form.setFieldsValue({
      aiProvider: newProvider.id,
      aiBaseUrl: newProvider.baseUrl,
      aiApiKey: '',
      aiModel: newProvider.models[0] || '',
    });
    setAvailableModels(newProvider.models);
    setConnectionResult(null);
  };

  const handleDeleteProvider = (providerId: string) => {
    // 不允许删除 ollama
    if (providerId === 'ollama') {
      message.warning('Ollama 为默认提供商，不可删除');
      return;
    }
    const newProviders = providers.filter((p) => p.id !== providerId);
    setProviders(newProviders);
    if (currentProviderId === providerId) {
      const firstProvider = newProviders[0];
      if (firstProvider) {
        setCurrentProviderId(firstProvider.id);
        form.setFieldsValue({
          aiProvider: firstProvider.id,
          aiBaseUrl: firstProvider.baseUrl,
          aiApiKey: firstProvider.apiKey || '',
          aiModel: firstProvider.models[0] || '',
        });
        setAvailableModels(firstProvider.models);
      }
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const provider = providers.find((p) => p.id === currentProviderId);
      if (!provider) {
        setConnectionResult({ success: false, error: '未选择提供商' });
        return;
      }
      // 使用表单中的最新值
      const updatedProvider: AIProvider = {
        ...provider,
        baseUrl: form.getFieldValue('aiBaseUrl') || provider.baseUrl,
        apiKey: form.getFieldValue('aiApiKey') || provider.apiKey,
      };
      const result = await window.electronAPI?.aiTestConnection(updatedProvider);
      setConnectionResult(result || { success: false, error: '测试失败' });
      if (result?.success) {
        message.success('连接成功！');
      } else {
        message.error('连接失败: ' + (result?.error || '未知错误'));
      }
    } catch (e) {
      const reason = errorMessage(e, '未知错误');
      setConnectionResult({ success: false, error: reason });
      message.error('连接测试异常: ' + reason);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    try {
      const provider = providers.find((p) => p.id === currentProviderId);
      if (!provider) return;
      const updatedProvider: AIProvider = {
        ...provider,
        baseUrl: form.getFieldValue('aiBaseUrl') || provider.baseUrl,
        apiKey: form.getFieldValue('aiApiKey') || provider.apiKey,
      };
      const result = await window.electronAPI?.aiGetModels(updatedProvider);
      if (result?.success && result.models) {
        setAvailableModels(result.models);
        // 更新 providers 中的模型列表
        setProviders((prev) =>
          prev.map((p) => (p.id === currentProviderId ? { ...p, models: result.models } : p))
        );
        if (result.models.length > 0 && !form.getFieldValue('aiModel')) {
          form.setFieldValue('aiModel', result.models[0]);
        }
        message.success(`获取到 ${result.models.length} 个模型`);
      } else {
        message.warning('获取模型列表失败，使用默认列表');
      }
    } catch (e) {
      message.error('获取模型列表异常: ' + errorMessage(e, '未知错误'));
    } finally {
      setFetchingModels(false);
    }
  };

  const handleProbeMind = async () => {
    setProbingMind(true);
    setMindProbe(null);
    try {
      // 先把表单里的地址/模型落盘，探活读的是已保存的配置
      const values = form.getFieldsValue();
      onSave({ ...(DEFAULT_CONFIG as PetConfig), ...values } as PetConfig);
      const res = await window.electronAPI?.mindPing();
      setMindProbe(res ?? { ok: false, error: '没有回应' });
      if (res?.ok) message.success(`可用 · ${res.latencyMs}ms`);
      else message.warning(`连不上：${res?.error ?? '未知原因'}`);
    } catch (e) {
      setMindProbe({ ok: false, error: errorMessage(e, '未知错误') });
    } finally {
      setProbingMind(false);
    }
  };

  // 同步表单值到 providers
  const syncProviderFromForm = () => {
    const baseUrl = form.getFieldValue('aiBaseUrl');
    const apiKey = form.getFieldValue('aiApiKey');
    const aiModel = form.getFieldValue('aiModel');
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== currentProviderId) return p;
        return {
          ...p,
          baseUrl: baseUrl || p.baseUrl,
          apiKey: apiKey !== undefined ? apiKey : p.apiKey,
          models: aiModel && !p.models.includes(aiModel) ? [aiModel, ...p.models] : p.models,
        };
      })
    );
  };

  const currentProvider = providers.find((p) => p.id === currentProviderId);

  return (
    <aside className={`adm-side ${open ? 'is-open' : ''}`} aria-label="设置面板" inert={!open}>
      <div className="adm-side-head">
        <span className="adm-side-head-ico">
          <SettingOutlined />
        </span>
        <span className="adm-side-title">设置</span>
        {dirty && <span className="adm-dirty">未保存</span>}
        <button type="button" className="adm-iconbtn" aria-label="关闭设置" onClick={onClose}>
          <CloseOutlined />
        </button>
      </div>

      <div className="adm-side-body">
        <Form form={form} layout="vertical" initialValues={DEFAULT_CONFIG} onValuesChange={() => setDirty(true)}>
          {/* ===== AI 提供商 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">AI 提供商</div>
                <div className="adm-sec-desc">她由谁驱动：本地 Ollama，或任意 OpenAI 兼容接口</div>
              </div>
            </div>
            <div className="adm-sec-body">
              <Form.Item label="当前提供商" name="aiProvider">
                <Select
                  onChange={handleProviderChange}
                  options={providers.map((p) => ({
                    label: p.name,
                    value: p.id,
                  }))}
                  optionRender={(option) => {
                    const p = providers.find((x) => x.id === option.value);
                    return (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0 }}>{option.label}</span>
                        {p?.supportsVision && <Tag color="green" style={{ margin: 0, fontSize: 10 }}>视觉</Tag>}
                      </span>
                    );
                  }}
                />
              </Form.Item>

              {currentProvider && (
                <div className="adm-tagrow">
                  <Tag style={{ margin: 0 }}>{currentProvider.type.toUpperCase()}</Tag>
                  {currentProvider.supportsVision && (
                    <Tag color="green" icon={<EyeOutlined />} style={{ margin: 0 }}>
                      视觉理解
                    </Tag>
                  )}
                  {currentProvider.supportsStreaming && (
                    <Tag color="blue" style={{ margin: 0 }}>
                      流式
                    </Tag>
                  )}
                  {currentProvider.supportsTools && (
                    <Tag color="orange" style={{ margin: 0 }}>
                      工具调用
                    </Tag>
                  )}
                  {currentProvider.id !== 'ollama' && (
                    <Popconfirm
                      title={`删除提供商「${currentProvider.name}」？`}
                      description="保存设置后生效，已写入的 API Key 会一并移除。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDeleteProvider(currentProvider.id)}
                    >
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        aria-label={`删除提供商 ${currentProvider.name}`}
                        style={{ marginLeft: 'auto' }}
                      />
                    </Popconfirm>
                  )}
                </div>
              )}

              <Form.Item label="Base URL" name="aiBaseUrl">
                <Input
                  placeholder="https://api.openai.com"
                  onChange={() => {
                    syncProviderFromForm();
                    setConnectionResult(null);
                  }}
                />
              </Form.Item>

              <Form.Item label="API Key" name="aiApiKey" extra={currentProvider?.type === 'ollama' ? '本地服务通常不需要，留空即可' : undefined}>
                <Input.Password
                  placeholder="sk-..."
                  onChange={() => {
                    syncProviderFromForm();
                    setConnectionResult(null);
                  }}
                />
              </Form.Item>

              <Form.Item label="模型" name="aiModel">
                <Select
                  showSearch
                  placeholder="选择或输入模型名称"
                  options={availableModels.map((m) => ({ label: m, value: m }))}
                  onChange={() => syncProviderFromForm()}
                  dropdownRender={(menu) => (
                    <>
                      {menu}
                      <Divider style={{ margin: '6px 0' }} />
                      <Button
                        type="text"
                        size="small"
                        icon={fetchingModels ? <LoadingOutlined /> : <ReloadOutlined />}
                        onClick={handleFetchModels}
                        loading={fetchingModels}
                        style={{ margin: 4, width: 'calc(100% - 8px)' }}
                      >
                        {fetchingModels ? '获取中…' : '刷新模型列表'}
                      </Button>
                    </>
                  )}
                />
              </Form.Item>

              <div className="adm-grid2">
                <Button
                  icon={
                    testingConnection ? (
                      <LoadingOutlined />
                    ) : connectionResult?.success ? (
                      <CheckCircleOutlined />
                    ) : connectionResult?.success === false ? (
                      <CloseCircleOutlined />
                    ) : (
                      <ApiOutlined />
                    )
                  }
                  onClick={handleTestConnection}
                  loading={testingConnection}
                  type={connectionResult?.success ? 'primary' : 'default'}
                  danger={connectionResult?.success === false}
                  block
                >
                  测试连接
                </Button>
                <Select
                  placeholder="添加提供商"
                  suffixIcon={<PlusOutlined />}
                  style={{ width: '100%' }}
                  onChange={handleProviderTypeChange}
                  value={undefined}
                  options={PROVIDER_TYPE_OPTIONS}
                />
              </div>

              {connectionResult && (
                <div className={`adm-callout ${connectionResult.success ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
                  {connectionResult.success ? '连接成功，模型可用' : `连接失败：${connectionResult.error}`}
                </div>
              )}
            </div>
          </section>

          {/* ===== 对话 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">对话</div>
                <div className="adm-sec-desc">人设与行为边界都写在这里</div>
              </div>
            </div>
            <div className="adm-sec-body">
              <Form.Item label="场景模板">
                <Select
                  placeholder="选一个现成的人设快速填充"
                  onChange={handleSceneChange}
                  options={SCENE_PROMPTS.map((s) => ({
                    label: `${s.icon} ${s.label} · ${s.description}`,
                    value: s.key,
                  }))}
                  allowClear
                />
              </Form.Item>
              <Form.Item
                label="系统提示词"
                name="systemPrompt"
                rules={[{ required: true, message: '请输入系统提示词' }]}
              >
                <TextArea rows={5} placeholder="定义她的身份、语气与边界…" />
              </Form.Item>
            </div>
          </section>

          {/* ===== 语音 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">语音</div>
                <div className="adm-sec-desc">本地 STT / TTS 端点与打断灵敏度</div>
              </div>
            </div>
            <div className="adm-sec-body">
              <Form.Item label="STT 服务地址" name="sttUrl">
                <Input placeholder="http://localhost:8084" />
              </Form.Item>
              <Form.Item label="TTS 服务地址" name="ttsUrl">
                <Input placeholder="http://localhost:8086" />
              </Form.Item>
              <div className="adm-grid2">
                <Form.Item label="语速" name="voiceSpeed">
                  <InputNumber min={0.5} max={2.0} step={0.1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  label="打断阈值"
                  name="interruptThreshold"
                  tooltip="播放语音时判定你插话的音量阈值（默认 30）。嘈杂环境调高，总被误打断就调低。"
                >
                  <InputNumber min={5} max={100} step={5} style={{ width: '100%' }} addonAfter="/100" />
                </Form.Item>
              </div>
              <Form.Item label="识别模型" name="sttModel" extra="保存后语音识别子进程会自动重启生效">
                <Select
                  options={(sttInfo?.models || []).map((m) => ({
                    value: m.id,
                    disabled: !m.installed,
                    label: `${m.id}${m.installed ? '' : ' · 未下载'}`,
                  }))}
                />
              </Form.Item>
              {sttInfo && !sttInfo.models.some((m) => m.installed) && (
                <div className="adm-callout warn" style={{ marginBottom: 12 }}>
                  {sttInfo.modelsDir} 下没有模型，可执行 scripts/fetch-whisper-model.sh base 下载
                </div>
              )}
            </div>
          </section>

          {/* ===== 外观 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">外观</div>
                <div className="adm-sec-desc">名字与强调色；立绘与场景看板娘右键菜单</div>
              </div>
            </div>
            <div className="adm-sec-body">
              <Form.Item label="萌宠名称" name="petName" extra="留空则跟随当前角色（茉白 / 夜汐 / 星璃 …）">
                <Input placeholder="给起个专属称呼" />
              </Form.Item>
              <Form.Item label="主题色" name="themeColor">
                <Select
                  options={THEME_COLORS.map((c) => ({
                    label: (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            background: c.value,
                            flex: '0 0 auto',
                          }}
                        />
                        {c.label}
                      </span>
                    ),
                    value: c.value,
                  }))}
                />
              </Form.Item>
            </div>
          </section>

          {/* ===== 心智 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">心智</div>
                <div className="adm-sec-desc">
                  她记得住事、也会自己找事做。这两件事都要一个能跑小模型的地址。
                </div>
              </div>
            </div>
            <div className="adm-sec-body">
              <Form.Item
                label="自己活动"
                name="mindEnabled"
                valuePropName="checked"
                extra="关掉后她只在被叫到时说话，不会自己走动、发呆、想事情"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="活动间隔"
                name="mindIntervalSec"
                extra="两次自主行为之间的基准间隔，实际会在 ±35% 上下浮动"
              >
                <Select
                  options={[
                    { value: 60, label: '1 分钟（活泼）' },
                    { value: 120, label: '2 分钟（默认）' },
                    { value: 180, label: '3 分钟（安静）' },
                    { value: 300, label: '5 分钟（很安静）' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label="自动记忆"
                name="autoExtractMemory"
                valuePropName="checked"
                extra="聊天时顺手把关于你的事记下来；关掉后只保留手动教的"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="心智模型地址"
                name="mindUrl"
                extra="留空就用上面选中的提供商。填 Ollama，或任何 OpenAI 兼容端点（llama.cpp / vLLM / LM Studio）都行，不用自己判断是哪一家"
              >
                <Input placeholder="http://192.168.31.249:52741/v1" allowClear />
              </Form.Item>
              <Form.Item
                label="协议"
                name="mindProtocol"
                extra="自动识别第一次请求会多试一条路，之后就记住了。只有识别错了才需要手动指定"
              >
                <Select
                  options={[
                    { value: '', label: '自动识别（推荐）' },
                    { value: 'ollama', label: 'Ollama（/api/chat）' },
                    { value: 'openai', label: 'OpenAI 兼容（/v1/chat/completions）' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label="心智模型"
                name="mindModel"
                extra="填模型名即可；llama.cpp 这类单模型服务端可以留空。强烈建议让心智用一个常驻模型：每换一次模型就要重新加载权重，慢起来几十秒"
              >
                <Input placeholder="qwen3:8b（llama.cpp 单模型可留空）" allowClear />
              </Form.Item>
              {mindProbe && (
                <div
                  className="adm-sec-note"
                  style={{
                    borderLeftColor: mindProbe.ok ? 'var(--accent)' : '#ff7875',
                    color: mindProbe.ok ? 'var(--text-2)' : '#ff9c9c',
                  }}
                >
                  {mindProbe.ok
                    ? `${mindProbe.verdict ?? '可用'} · ${mindProbe.latencyMs}ms · ${
                        mindProbe.protocol === 'openai' ? 'OpenAI 兼容' : 'Ollama'
                      }${mindProbe.switched ? '（自动识别）' : ''} · 回了「${mindProbe.reply ?? ''}」`
                    : `连不上：${mindProbe.error ?? '未知原因'}`}
                </div>
              )}
              <Button
                block
                icon={<ThunderboltOutlined />}
                loading={probingMind}
                onClick={handleProbeMind}
                style={{ marginTop: 4 }}
              >
                存下并测一下她能不能想事情
              </Button>
            </div>
          </section>

          {/* ===== 快捷键 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">全局快捷键</div>
                <div className="adm-sec-desc">形如 CommandOrControl+Shift+Z，保存配置时一并重新注册</div>
              </div>
            </div>
            <div className="adm-sec-body">
              {shortcutRows.length === 0 ? (
                <div className="pnl-hint" style={{ marginBottom: 12 }}>
                  尚未读到快捷键清单
                </div>
              ) : (
                shortcutRows.map((row) => (
                  <div className="adm-keyrow" key={row.key}>
                    <span className="adm-keyrow-label">{row.label}</span>
                    <Input
                      size="small"
                      style={{ fontSize: 11 }}
                      value={row.accelerator}
                      onChange={(e) =>
                        setShortcutRows((prev) =>
                          prev.map((r) => (r.key === row.key ? { ...r, accelerator: e.target.value } : r))
                        )
                      }
                    />
                    <span className={`adm-keyrow-state ${row.registered ? 'on' : ''}`}>
                      {row.registered ? '已注册' : '未注册'}
                    </span>
                  </div>
                ))
              )}
              <Button size="small" onClick={applyShortcuts} style={{ marginBottom: 12 }}>
                应用快捷键
              </Button>
            </div>
          </section>

          {/* ===== 更新 ===== */}
          <section className="adm-sec">
            <div className="adm-sec-h">
              <div>
                <div className="adm-sec-name">更新</div>
                <div className="adm-sec-desc">检查并安装新版本</div>
              </div>
            </div>
            <div className="adm-sec-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <Button size="small" loading={checkingUpdate} onClick={handleCheckUpdate}>
                  检查更新
                </Button>
                {updateAvailable && (
                  <Button size="small" type="primary" onClick={handleInstallUpdate} loading={installing}>
                    下载并安装
                  </Button>
                )}
                <span className="pnl-hint">{updateText}</span>
              </div>
            </div>
          </section>

          {/* 兼容旧配置：字段保留但不展示，否则保存时会被清空 */}
          <Form.Item name="ollamaUrl" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="modelName" hidden>
            <Input />
          </Form.Item>
        </Form>
      </div>

      <div className="adm-side-foot">
        <Button icon={<ReloadOutlined />} onClick={handleReset} disabled={loading}>
          重置
        </Button>
        <div style={{ flex: 1 }} />
        <Button onClick={onClose}>取消</Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={handleSave}
          loading={saving}
          disabled={loading}
        >
          保存
        </Button>
      </div>
    </aside>
  );
};

export default SettingsPanel;

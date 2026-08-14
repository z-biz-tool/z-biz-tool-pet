import React, { useState, useEffect } from 'react';
import { Drawer, Form, Input, InputNumber, Button, Divider, Select, message, Space, Typography, Switch, Card, Tag, Popconfirm } from 'antd';
import { SaveOutlined, ReloadOutlined, PlusOutlined, DeleteOutlined, ApiOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, EyeOutlined } from '@ant-design/icons';
import { DEFAULT_CONFIG, SCENE_PROMPTS } from '../shared/prompts';

const { TextArea } = Input;
const { Text } = Typography;

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: PetConfig) => void;
}

const THEME_COLORS = [
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

const SettingsPanel: React.FC<SettingsPanelProps> = ({ open, onClose, onSave }) => {
  const [form] = Form.useForm<PetConfig>();
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [currentProviderId, setCurrentProviderId] = useState<string>('ollama');
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      loadConfig();
    }
  }, [open]);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const config = await window.electronAPI?.loadConfig();
      if (config) {
        form.setFieldsValue(config);
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
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const configToSave = {
        ...values,
        providers,
      };
      await window.electronAPI?.saveConfig(configToSave);
      onSave(configToSave);
      message.success('设置已保存');
      onClose();
    } catch (e: any) {
      message.error('保存失败: ' + (e.message || '请检查表单'));
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
    } catch (e: any) {
      setConnectionResult({ success: false, error: e.message });
      message.error('连接测试异常: ' + e.message);
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
    } catch (e: any) {
      message.error('获取模型列表异常: ' + e.message);
    } finally {
      setFetchingModels(false);
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
    <Drawer
      title="⚙️ 设置"
      placement="right"
      width={520}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={handleReset} size="small">
            重置
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} size="small">
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={DEFAULT_CONFIG}>
        {/* ===== AI 提供商设置 ===== */}
        <Divider titlePlacement="left" plain>
          🤖 AI 提供商
        </Divider>

        <Form.Item label="当前提供商" name="aiProvider">
          <Select
            onChange={handleProviderChange}
            options={providers.map((p) => ({
              label: (
                <span>
                  {p.name}
                  {p.supportsVision && <Tag color="green" style={{ marginLeft: 6, fontSize: 10 }}>Vision</Tag>}
                </span>
              ),
              value: p.id,
            }))}
          />
        </Form.Item>

        {/* 当前提供商信息卡片 */}
        {currentProvider && (
          <Card
            size="small"
            style={{ marginBottom: 16, background: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.1)' }}
            extra={
              currentProvider.id !== 'ollama' ? (
                <Popconfirm title="确定删除此提供商？" onConfirm={() => handleDeleteProvider(currentProvider.id)}>
                  <Button type="text" danger size="small" icon={<DeleteOutlined />} />
                </Popconfirm>
              ) : null
            }
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <Tag>{currentProvider.type.toUpperCase()}</Tag>
              {currentProvider.supportsVision && <Tag color="green" icon={<EyeOutlined />}>视觉理解</Tag>}
              {currentProvider.supportsStreaming && <Tag color="blue">流式</Tag>}
              {currentProvider.supportsTools && <Tag color="orange">工具调用</Tag>}
            </div>
          </Card>
        )}

        <Form.Item label="Base URL" name="aiBaseUrl">
          <Input
            placeholder="https://api.openai.com"
            onChange={() => { syncProviderFromForm(); setConnectionResult(null); }}
          />
        </Form.Item>

        <Form.Item label="API Key" name="aiApiKey">
          <Input.Password
            placeholder="sk-..."
            onChange={() => { syncProviderFromForm(); setConnectionResult(null); }}
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
                <Divider style={{ margin: '8px 0' }} />
                <Button
                  type="link"
                  icon={fetchingModels ? <LoadingOutlined /> : <ReloadOutlined />}
                  onClick={handleFetchModels}
                  loading={fetchingModels}
                  style={{ padding: '4px 8px', width: '100%' }}
                >
                  {fetchingModels ? '获取中...' : '刷新模型列表'}
                </Button>
              </>
            )}
          />
        </Form.Item>

        <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'center' }}>
          <Button
            icon={testingConnection ? <LoadingOutlined /> : connectionResult?.success ? <CheckCircleOutlined /> : connectionResult?.success === false ? <CloseCircleOutlined /> : <ApiOutlined />}
            onClick={handleTestConnection}
            loading={testingConnection}
            type={connectionResult?.success ? 'primary' : 'default'}
            danger={connectionResult?.success === false}
          >
            测试连接
          </Button>
          <Select
            placeholder="添加新提供商"
            style={{ width: 180 }}
            onChange={handleProviderTypeChange}
            value={undefined}
            options={PROVIDER_TYPE_OPTIONS}
          />
        </Space>

        {connectionResult && (
          <div style={{
            marginBottom: 16,
            padding: '8px 12px',
            borderRadius: 8,
            background: connectionResult.success ? 'rgba(82,196,26,0.1)' : 'rgba(245,34,45,0.1)',
            border: `1px solid ${connectionResult.success ? 'rgba(82,196,26,0.3)' : 'rgba(245,34,45,0.3)'}`,
          }}>
            <Text type={connectionResult.success ? 'success' : 'danger'} style={{ fontSize: 12 }}>
              {connectionResult.success ? '✅ 连接成功' : `❌ 连接失败: ${connectionResult.error}`}
            </Text>
          </div>
        )}

        {/* ===== 系统提示词 ===== */}
        <Divider titlePlacement="left" plain>
          💬 对话设置
        </Divider>
        <Form.Item label="系统提示词模板">
          <Select
            placeholder="选择场景模板快速填充"
            onChange={handleSceneChange}
            options={SCENE_PROMPTS.map((s) => ({
              label: `${s.icon} ${s.label} - ${s.description}`,
              value: s.key,
            }))}
            allowClear
          />
        </Form.Item>
        <Form.Item
          label="系统提示词内容"
          name="systemPrompt"
          rules={[{ required: true, message: '请输入系统提示词' }]}
        >
          <TextArea rows={4} placeholder="输入系统提示词，定义 AI 的角色和行为..." />
        </Form.Item>

        {/* ===== 兼容旧配置 ===== */}
        <Form.Item name="ollamaUrl" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="modelName" hidden>
          <Input />
        </Form.Item>

        {/* ===== 语音设置 ===== */}
        <Divider titlePlacement="left" plain>
          🎙️ 语音设置
        </Divider>
        <Form.Item label="STT 服务地址" name="sttUrl">
          <Input placeholder="http://localhost:8084" />
        </Form.Item>
        <Form.Item label="TTS 服务地址" name="ttsUrl">
          <Input placeholder="http://localhost:8086" />
        </Form.Item>
        <Form.Item label="语音速度" name="voiceSpeed">
          <InputNumber min={0.5} max={2.0} step={0.1} style={{ width: '100%' }} />
        </Form.Item>

        {/* ===== 外观设置 ===== */}
        <Divider titlePlacement="left" plain>
          🎨 外观设置
        </Divider>
        <Form.Item label="萌宠名称" name="petName">
          <Input placeholder="Z-Bot 小猫咪" />
        </Form.Item>
        <Form.Item label="主题色" name="themeColor">
          <Select
            options={THEME_COLORS.map((c) => ({
              label: (
                <span>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: c.value,
                      marginRight: 8,
                      verticalAlign: 'middle',
                      border: '1px solid #d9d9d9',
                    }}
                  />
                  {c.label}
                </span>
              ),
              value: c.value,
            }))}
          />
        </Form.Item>

        <Divider plain />
        <Text type="secondary" style={{ fontSize: 12 }}>
          设置保存到 ~/.z-bot/config.json (权限600)，重启应用后生效。
        </Text>
      </Form>
    </Drawer>
  );
};

export default SettingsPanel;

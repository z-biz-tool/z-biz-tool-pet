import React, { useState, useEffect } from 'react';
import { Drawer, Form, Input, InputNumber, Button, Divider, Select, message, Space, Typography } from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';
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

const SettingsPanel: React.FC<SettingsPanelProps> = ({ open, onClose, onSave }) => {
  const [form] = Form.useForm<PetConfig>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      loadConfig();
    }
  }, [open]);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const config = await window.electronAPI?.loadConfig();
      form.setFieldsValue(config || DEFAULT_CONFIG);
    } catch (e) {
      form.setFieldsValue(DEFAULT_CONFIG);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      await window.electronAPI?.saveConfig(values);
      onSave(values);
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

  return (
    <Drawer
      title="⚙️ 设置"
      placement="right"
      width={460}
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
        <Divider titlePlacement="left" plain>
          🤖 模型设置
        </Divider>
        <Form.Item
          label="Ollama 服务地址"
          name="ollamaUrl"
          rules={[{ required: true, message: '请输入 Ollama 地址' }]}
        >
          <Input placeholder="http://localhost:11434" />
        </Form.Item>
        <Form.Item
          label="模型名称"
          name="modelName"
          rules={[{ required: true, message: '请输入模型名称' }]}
        >
          <Input placeholder="qwen2.5:7b-instruct-q4_K_M" />
        </Form.Item>
        <Form.Item label="系统提示词">
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
          <TextArea rows={6} placeholder="输入系统提示词，定义 AI 的角色和行为..." />
        </Form.Item>

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
          设置保存到 ~/.z-bot/config.json，重启应用后生效。
        </Text>
      </Form>
    </Drawer>
  );
};

export default SettingsPanel;

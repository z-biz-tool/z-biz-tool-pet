import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Button, Typography, ColorPicker, Space, Modal, Form, Input, message } from 'antd';
import { SunOutlined, MoonOutlined, ThunderboltOutlined, CloudOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

interface Scenery {
  id: string;
  name: string;
  description: string;
  type: 'day' | 'night' | 'rain' | 'snow' | 'sunset' | 'custom';
  backgroundColor: string;
  particleColor: string;
  enabled: boolean;
}

interface ParticleConfig {
  id: string;
  type: 'heart' | 'star' | 'music' | 'sparkle' | 'bounce' | 'float';
  content: string;
  enabled: boolean;
}

interface SceneryPanelProps {
  open: boolean;
  onClose: () => void;
}

const PRESET_SCENERIES: Scenery[] = [
  { id: 'day', name: '阳光明媚', description: '晴朗的白天，阳光灿烂', type: 'day', backgroundColor: 'linear-gradient(135deg, #87CEEB 0%, #E0F7FA 100%)', particleColor: '#FFD700', enabled: true },
  { id: 'night', name: '月光静谧', description: '宁静的夜晚，星光闪烁', type: 'night', backgroundColor: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)', particleColor: '#C0C0C0', enabled: true },
  { id: 'rain', name: '雨天 mood', description: '雨天的宁静氛围', type: 'rain', backgroundColor: 'linear-gradient(135deg, #4A4A5A 0%, #2C3E50 100%)', particleColor: '#87CEEB', enabled: true },
  { id: 'sunset', name: '夕阳余晖', description: '温暖的黄昏时光', type: 'sunset', backgroundColor: 'linear-gradient(135deg, #FF6B6B 0%, #FFD93D 50%, #6BCB77 100%)', particleColor: '#FFA500', enabled: true },
];

const PARTICLE_TYPES: ParticleConfig[] = [
  { id: 'heart', type: 'heart', content: '💕', enabled: true },
  { id: 'star', type: 'star', content: '✨', enabled: true },
  { id: 'music', type: 'music', content: '🎵', enabled: true },
  { id: 'sparkle', type: 'sparkle', content: '⭐', enabled: true },
  { id: 'bounce', type: 'bounce', content: '🎈', enabled: true },
  { id: 'float', type: 'float', content: '☁️', enabled: true },
];

const SceneryPanel: React.FC<SceneryPanelProps> = ({ open }) => {
  const [currentScenery, setCurrentScenery] = useState<Scenery>(PRESET_SCENERIES[0]);
  const [customScenery, setCustomScenery] = useState<Scenery>({
    id: 'custom',
    name: '自定义',
    description: '自定义场景',
    type: 'custom',
    backgroundColor: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    particleColor: '#FF6B6B',
    enabled: true,
  });
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) {
      const saved = localStorage.getItem('current_scenery');
      if (saved) {
        const scenery = JSON.parse(saved);
        setCurrentScenery(scenery);
      }
      
      const savedParticles = localStorage.getItem('particle_settings');
      if (savedParticles) {
        // 加载粒子设置
      }
    }
  }, [open]);

  const handleScenerySelect = (scenery: Scenery) => {
    setCurrentScenery(scenery);
    localStorage.setItem('current_scenery', JSON.stringify(scenery));
  };

  const handleCustomSave = () => {
    try {
      const values = form.getFieldsValue();
      const custom: Scenery = {
        id: 'custom',
        name: values.name || '自定义',
        description: values.description || '自定义场景',
        type: 'custom',
        backgroundColor: values.backgroundColor,
        particleColor: values.particleColor || '#FF6B6B',
        enabled: true,
      };
      setCustomScenery(custom);
      setCurrentScenery(custom);
      localStorage.setItem('current_scenery', JSON.stringify(custom));
      setIsCustomModalOpen(false);
      message.success('自定义场景已保存');
    } catch (e: any) {
      message.error('保存失败: ' + e.message);
    }
  };

  const handleParticleToggle = (id: string) => {
    const updated = PARTICLE_TYPES.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p);
    localStorage.setItem('particle_settings', JSON.stringify(updated));
  };

  return (
    <>
      <Card title="场景切换">
        <Title level={5}>预设场景</Title>
        <Row gutter={16}>
          {PRESET_SCENERIES.map((scenery) => (
            <Col span={6} key={scenery.id}>
              <Card
                hoverable
                style={{
                  backgroundColor: scenery.backgroundColor,
                  border: currentScenery.id === scenery.id ? '2px solid #1890ff' : '2px solid transparent',
                }}
                onClick={() => handleScenerySelect(scenery)}
              >
                <Space direction="vertical" align="center">
                  <span style={{ fontSize: 24 }}>
                    {scenery.type === 'day' && <SunOutlined />}
                    {scenery.type === 'night' && <MoonOutlined />}
                    {scenery.type === 'rain' && <ThunderboltOutlined />}
                    {scenery.type === 'sunset' && <CloudOutlined />}
                  </span>
                  <Text strong>{scenery.name}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>{scenery.description}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
        <Button type="link" onClick={() => setIsCustomModalOpen(true)} style={{ marginTop: 16 }}>
          + 自定义场景
        </Button>
      </Card>

      <Card title="粒子特效" style={{ marginTop: 16 }}>
        <Title level={5}>粒子类型</Title>
        <Row gutter={16}>
          {PARTICLE_TYPES.map((particle) => (
            <Col span={4} key={particle.id}>
              <Button
                type={particle.enabled ? 'primary' : 'default'}
                style={{ width: '100%', height: 80, fontSize: 24 }}
                onClick={() => handleParticleToggle(particle.id)}
              >
                {particle.content}
              </Button>
              <div style={{ textAlign: 'center', marginTop: 4, fontSize: 12 }}>
                {particle.type}
              </div>
            </Col>
          ))}
        </Row>
      </Card>

      <Modal
        title="自定义场景"
        open={isCustomModalOpen}
        onOk={handleCustomSave}
        onCancel={() => setIsCustomModalOpen(false)}
        okText="保存"
        width={500}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="场景名称"
            initialValue={customScenery.name}
            rules={[{ required: true }]}
          >
            <Input placeholder="例如：梦幻星空" />
          </Form.Item>
          <Form.Item
            name="description"
            label="描述"
            initialValue={customScenery.description}
          >
            <Input placeholder="场景描述" />
          </Form.Item>
          <Form.Item
            name="backgroundColor"
            label="背景颜色"
            initialValue={customScenery.backgroundColor}
            rules={[{ required: true }]}
          >
            <Input placeholder="例如：linear-gradient(135deg, #667eea 0%, #764ba2 100%)" />
          </Form.Item>
          <Form.Item
            name="particleColor"
            label="粒子颜色"
            initialValue={customScenery.particleColor}
            rules={[{ required: true }]}
          >
            <ColorPicker />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default SceneryPanel;

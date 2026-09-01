import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Tag, Typography, Space, Modal, Form, Input, Switch, message, Select } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface QuickCommand {
  id: string;
  name: string;
  trigger: string;
  response: string;
  enabled: boolean;
  createdAt: string;
}

interface QuickCommandManager {
  commands: QuickCommand[];
  load(): QuickCommand[];
  save(commands: QuickCommand[]): void;
  add(command: QuickCommand): void;
  remove(id: string): void;
  update(id: string, updates: Partial<QuickCommand>): void;
  find(trigger: string): QuickCommand | undefined;
}

interface QuickCommandPanelProps {
  open: boolean;
  onClose: () => void;
}

const QuickCommandPanel: React.FC<QuickCommandPanelProps> = ({ open, onClose }) => {
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<QuickCommand | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) {
      loadCommands();
    }
  }, [open]);

  const loadCommands = () => {
    // 模拟加载
    const saved = localStorage.getItem('quick_commands');
    if (saved) {
      setCommands(JSON.parse(saved));
    } else {
      // 默认指令
      const defaults = [
        { id: 'cmd_1', name: '查天气', trigger: '今天天气', response: '好的！让我帮你查一下天气~ 🌤️', enabled: true, createdAt: new Date().toISOString() },
        { id: 'cmd_2', name: '定番茄钟', trigger: '番茄钟', response: '好的！开始25分钟专注时间~ 🍅', enabled: true, createdAt: new Date().toISOString() },
        { id: 'cmd_3', name: '讲笑话', trigger: '讲个笑话', response: '为什么程序员分不清万圣节和圣诞节？因为 Oct 31 == Dec 25！😂', enabled: true, createdAt: new Date().toISOString() },
      ];
      setCommands(defaults);
      localStorage.setItem('quick_commands', JSON.stringify(defaults));
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const command: QuickCommand = {
        id: editingCommand ? editingCommand.id : `cmd_${Date.now()}`,
        name: values.name,
        trigger: values.trigger,
        response: values.response,
        enabled: values.enabled !== undefined ? values.enabled : true,
        createdAt: editingCommand ? editingCommand.createdAt : new Date().toISOString(),
      };

      if (editingCommand) {
        const updated = commands.map(c => c.id === editingCommand.id ? command : c);
        setCommands(updated);
      } else {
        setCommands([...commands, command]);
      }

      localStorage.setItem('quick_commands', JSON.stringify(commands));
      message.success(editingCommand ? '指令已更新' : '指令已添加');
      setIsModalOpen(false);
      setEditingCommand(null);
      form.resetFields();
    } catch (e: any) {
      message.error('保存失败: ' + e.message);
    }
  };

  const handleEdit = (command: QuickCommand) => {
    setEditingCommand(command);
    form.setFieldsValue(command);
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    Modal.confirm({
      title: '确定删除吗？',
      content: '删除后无法恢复',
      onOk: () => {
        setCommands(commands.filter(c => c.id !== id));
        localStorage.setItem('quick_commands', JSON.stringify(commands.filter(c => c.id !== id)));
        message.success('指令已删除');
      },
    });
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '触发关键词',
      dataIndex: 'trigger',
      key: 'trigger',
      render: (trigger: string) => <Tag color="blue">{trigger}</Tag>,
    },
    {
      title: '回复内容',
      dataIndex: 'response',
      key: 'response',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'red'}>{enabled ? '启用' : '禁用'}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: QuickCommand) => (
        <Space size="middle">
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Button type="link" icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} danger />
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card title="快捷指令管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>添加指令</Button>}>
        <Table columns={columns} dataSource={commands} rowKey="id" pagination={{ pageSize: 10 }} />
      </Card>

      <Modal
        title={editingCommand ? '编辑指令' : '添加新指令'}
        open={isModalOpen}
        onOk={handleSave}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingCommand(null);
          form.resetFields();
        }}
        okText="保存"
        cancelText="取消"
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="指令名称"
            rules={[{ required: true, message: '请输入指令名称' }]}
          >
            <Input placeholder="例如：查天气、定番茄钟" />
          </Form.Item>
          <Form.Item
            name="trigger"
            label="触发关键词"
            rules={[{ required: true, message: '请输入触发关键词' }]}
          >
            <Input placeholder="例如：今天天气、番茄钟" />
          </Form.Item>
          <Form.Item
            name="response"
            label="回复内容"
            rules={[{ required: true, message: '请输入回复内容' }]}
          >
            <TextArea rows={4} placeholder="例如：好的！让我帮你查一下天气~ 🌤️" />
          </Form.Item>
          <Form.Item
            name="enabled"
            label="启用"
            valuePropName="checked"
            initialValue={true}
          >
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default QuickCommandPanel;

import React, { useState, useEffect } from 'react';
import { Table, Button, Tag, Space, Modal, Form, Input, Switch, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { errorMessage, upsertById } from '../shared/interaction';

interface QuickCommand {
  id: string;
  name: string;
  trigger: string;
  response: string;
  enabled: boolean;
  createdAt: string;
}

interface QuickCommandPanelProps {
  open: boolean;
  onClose: () => void;
}

const QuickCommandPanel: React.FC<QuickCommandPanelProps> = ({ open }) => {
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
    const saved = localStorage.getItem('quick_commands');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setCommands(parsed);
          return;
        }
        throw new Error('不是数组');
      } catch (error) {
        // 本地数据损坏不能让整个面板白屏：恢复默认并在界面上说明
        message.error('本地快捷指令数据损坏，已恢复默认：' + errorMessage(error, '格式非法'));
      }
    }
    // 默认指令
    const defaults = [
      { id: 'cmd_1', name: '查天气', trigger: '今天天气', response: '好的！让我帮你查一下天气~ 🌤️', enabled: true, createdAt: new Date().toISOString() },
      { id: 'cmd_2', name: '定番茄钟', trigger: '番茄钟', response: '好的！开始25分钟专注时间~ 🍅', enabled: true, createdAt: new Date().toISOString() },
      { id: 'cmd_3', name: '讲笑话', trigger: '讲个笑话', response: '为什么程序员分不清万圣节和圣诞节？因为 Oct 31 == Dec 25！😂', enabled: true, createdAt: new Date().toISOString() },
    ];
    setCommands(defaults);
    try {
      localStorage.setItem('quick_commands', JSON.stringify(defaults));
    } catch (error) {
      message.warning('默认指令无法写入本地存储：' + errorMessage(error, '存储不可用'));
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

      // 必须用“合并后的新数组”落盘：旧实现写的是闭包里的旧 commands，
      // 新增/编辑都只改了界面、没写进去（下次打开即丢）
      const next = upsertById(commands, command);
      localStorage.setItem('quick_commands', JSON.stringify(next));
      setCommands(next);
      message.success(editingCommand ? '指令已更新' : '指令已添加');
      setIsModalOpen(false);
      setEditingCommand(null);
      form.resetFields();
    } catch (e) {
      // validateFields 的 reject 是校验错误，不是保存失败
      if (e && typeof e === 'object' && 'errorFields' in e) return;
      message.error('保存失败: ' + errorMessage(e, '本地存储不可用'));
    }
  };

  const handleEdit = (command: QuickCommand) => {
    setEditingCommand(command);
    form.setFieldsValue(command);
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    const target = commands.find((c) => c.id === id);
    Modal.confirm({
      title: `删除指令「${target?.name || id}」？`,
      content: '删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      autoFocusButton: 'cancel',
      onOk: () => {
        const next = commands.filter((c) => c.id !== id);
        try {
          localStorage.setItem('quick_commands', JSON.stringify(next));
          setCommands(next);
          message.success('指令已删除');
        } catch (error) {
          message.error('删除失败: ' + errorMessage(error, '本地存储不可用'));
        }
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
          <Button type="link" icon={<EditOutlined />} aria-label={`编辑指令 ${record.name}`} onClick={() => handleEdit(record)} />
          <Button type="link" icon={<DeleteOutlined />} aria-label={`删除指令 ${record.name}`} onClick={() => handleDelete(record.id)} danger />
        </Space>
      ),
    },
  ];

  return (
    <>
      <div className="pnl-toolbar">
        <span className="pnl-hint">命中触发词的句子会直接回预设内容，不经过模型</span>
        <div className="pnl-actions">
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>
            添加指令
          </Button>
        </div>
      </div>
      <Table
        columns={columns}
        dataSource={commands}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
      />

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
            <Input.TextArea rows={4} placeholder="例如：好的！让我帮你查一下天气~ 🌤️" />
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

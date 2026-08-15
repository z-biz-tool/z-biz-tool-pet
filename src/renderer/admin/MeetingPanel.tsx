import React, { useState, useEffect } from 'react';
import { Button, Input, Card, Tag, Space, Empty, Spin, message } from 'antd';
import {
  AudioOutlined,
  StopOutlined,
  FileTextOutlined,
  SoundOutlined,
} from '@ant-design/icons';

interface Props {
  accent: string;
}

export default function MeetingPanel({ accent }: Props) {
  const [title, setTitle] = useState('');
  const [state, setState] = useState<MeetingState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const cur = await window.electronAPI?.meetingGetState();
      if (cur) setState(cur);
    })();
    const unsubState = window.electronAPI?.onMeetingState((s) => setState(s));
    const unsubSegment = window.electronAPI?.onMeetingSegment(() => {
      // segments come via state update
    });
    const unsubSummary = window.electronAPI?.onMeetingRollingSummary(() => {});
    return () => {
      unsubState?.();
      unsubSegment?.();
      unsubSummary?.();
    };
  }, []);

  const start = async () => {
    if (!title.trim()) {
      message.warning('请输入会议主题');
      return;
    }
    setLoading(true);
    try {
      const res = await window.electronAPI?.meetingStart(title.trim());
      if (res && !res.success) {
        message.error('启动失败: ' + (res.error || '未知错误'));
      } else {
        message.success('会议转录已启动');
      }
    } finally {
      setLoading(false);
    }
  };

  const end = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI?.meetingEnd();
      if (res && res.state) {
        message.success('会议总结已生成');
      }
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    await window.electronAPI?.meetingCancel();
    message.info('已取消会议');
  };

  const isRecording = state?.status === 'recording';
  const isProcessing = state?.status === 'processing';
  const isDone = state?.status === 'done';

  return (
    <Card
      title={
        <Space>
          <SoundOutlined style={{ color: accent }} />
          <span>会议实时转录</span>
        </Space>
      }
      size="small"
      style={{ marginTop: 12 }}
    >
      {!state || state.status === 'idle' ? (
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="输入会议主题（如：Q3 产品评审）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={start}
            disabled={loading}
          />
          <Button type="primary" icon={<AudioOutlined />} loading={loading} onClick={start} style={{ background: accent, borderColor: accent }}>
            开始
          </Button>
        </Space.Compact>
      ) : (
        <div>
          <Space style={{ marginBottom: 8 }}>
            <Tag color={isRecording ? 'red' : isProcessing ? 'orange' : isDone ? 'green' : 'default'}>
              {isRecording ? '录音中' : isProcessing ? '生成总结' : isDone ? '已完成' : state.status}
            </Tag>
            <span style={{ fontWeight: 500 }}>{state.title}</span>
            {isRecording && (
              <Button size="small" icon={<StopOutlined />} onClick={end} type="primary" danger>
                结束会议
              </Button>
            )}
            {isRecording && (
              <Button size="small" onClick={cancel}>取消</Button>
            )}
          </Space>

          {state.error && (
            <div style={{ color: '#ff7875', marginBottom: 8 }}>
              错误: {state.error}
            </div>
          )}

          <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto', background: 'rgba(255,255,255,0.04)', padding: 8, borderRadius: 6 }}>
            {state.segments.length === 0 ? (
              isProcessing ? <Spin tip="生成总结中..." /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待音频输入..." />
            ) : (
              state.segments.map((s) => {
                const m = Math.floor(s.startMs / 60000);
                const sec = Math.floor((s.startMs % 60000) / 1000);
                return (
                  <div key={s.id} style={{ marginBottom: 8, fontSize: 13 }}>
                    <Tag color="blue" style={{ fontFamily: 'monospace' }}>{String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')}</Tag>
                    {s.text}
                  </div>
                );
              })
            )}
          </div>

          {state.rollingSummary && (
            <Card size="small" style={{ marginTop: 8, background: 'rgba(255,255,255,0.03)' }} title={<Space><FileTextOutlined />滚动摘要</Space>}>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{state.rollingSummary}</div>
            </Card>
          )}

          {state.finalSummary && (
            <Card size="small" style={{ marginTop: 8, background: 'rgba(82,196,26,0.08)' }} title={<Space><FileTextOutlined />最终总结</Space>}>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{state.finalSummary}</div>
              {state.transcriptPath && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}>
                  完整转录已保存: {state.transcriptPath}
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </Card>
  );
}

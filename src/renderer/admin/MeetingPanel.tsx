import React, { useState, useEffect } from 'react';
import { Button, Input, Card, Tag, Space, Empty, Spin, message, Modal } from 'antd';
import {
  AudioOutlined,
  StopOutlined,
  FileTextOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import { errorMessage } from '../shared/interaction';

interface Props {
  accent: string;
}

// IPC 边界数据不可全信：缺 segments 会让整个管理端渲染树崩掉（白屏），
// 这里只补数组，其余字段保持后端原值。
function normalizeState(s: MeetingState): MeetingState {
  return { ...s, segments: Array.isArray(s.segments) ? s.segments : [] };
}

export default function MeetingPanel({ accent }: Props) {
  const [title, setTitle] = useState('');
  const [state, setState] = useState<MeetingState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cur = await window.electronAPI?.meetingGetState();
        if (cur) setState(normalizeState(cur));
      } catch (error) {
        // 面板是常驻卡片：读不到状态就保持“未开始”，但必须留痕
        console.warn('[Admin] 会议状态读取失败:', errorMessage(error, '主进程无响应'));
      }
    })();
    const unsubState = window.electronAPI?.onMeetingState((s) => setState(normalizeState(s)));
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
      if (!res || res.success) {
        // 主进程成功时返回 { success: true, state }；undefined 说明通道没接通，不能报成功
        if (res) message.success('会议转录已启动');
        else message.error('启动失败：主进程无响应');
      } else {
        message.error('启动失败: ' + (res.error || '未知错误'));
      }
    } catch (error) {
      message.error('启动失败: ' + errorMessage(error, '主进程无响应'));
    } finally {
      setLoading(false);
    }
  };

  const end = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI?.meetingEnd();
      if (res?.state) {
        message.success('会议总结已生成');
      } else {
        message.error('结束会议失败: ' + (res?.error || '未返回总结状态'));
      }
    } catch (error) {
      message.error('结束会议失败: ' + errorMessage(error, '主进程无响应'));
    } finally {
      setLoading(false);
    }
  };

  const cancel = () => {
    // 取消会丢弃已转录内容：二次确认 + 危险色，默认焦点在“继续录音”
    Modal.confirm({
      title: '取消本次会议转录？',
      content: `将丢弃「${state?.title || '本次会议'}」已转录的 ${state?.segments.length || 0} 段内容，不可恢复。`,
      okText: '取消转录',
      okButtonProps: { danger: true },
      cancelText: '继续录音',
      autoFocusButton: 'cancel',
      centered: true,
      onOk: async () => {
        try {
          await window.electronAPI?.meetingCancel();
          message.info('已取消会议转录');
        } catch (error) {
          message.error('取消失败: ' + errorMessage(error, '主进程无响应'));
        }
      },
    });
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
              <Button size="small" icon={<StopOutlined />} onClick={end} type="primary" danger loading={loading}>
                结束会议
              </Button>
            )}
            {isRecording && (
              <Button size="small" onClick={cancel} disabled={loading}>取消</Button>
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

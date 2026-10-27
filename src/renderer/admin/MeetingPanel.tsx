import React, { useState, useEffect } from 'react';
import { Button, Input, Tag, Space, message, Modal } from 'antd';
import { AudioOutlined, StopOutlined } from '@ant-design/icons';
import { errorMessage } from '../shared/interaction';

// IPC 边界数据不可全信：缺 segments 会让整个管理端渲染树崩掉（白屏），
// 这里只补数组，其余字段保持后端原值。
function normalizeState(s: MeetingState): MeetingState {
  return { ...s, segments: Array.isArray(s.segments) ? s.segments : [] };
}

export default function MeetingPanel() {
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
    <div>
      {!state || state.status === 'idle' ? (
        <>
          <p className="pnl-hint" style={{ marginBottom: 10 }}>
            开始后会把麦克风听到的内容分段转写，结束时生成总结；转录文件保存在本地。
          </p>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="会议主题，如「Q3 产品评审」"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onPressEnter={start}
              disabled={loading}
            />
            <Button type="primary" icon={<AudioOutlined />} loading={loading} onClick={start}>
              开始
            </Button>
          </Space.Compact>
        </>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <Tag
              color={isRecording ? 'red' : isProcessing ? 'orange' : isDone ? 'green' : 'default'}
              style={{ margin: 0 }}
            >
              {isRecording ? '录音中' : isProcessing ? '生成总结' : isDone ? '已完成' : state.status}
            </Tag>
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{state.title}</span>
            <div style={{ flex: 1 }} />
            {isRecording && (
              <Button size="small" icon={<StopOutlined />} onClick={end} type="primary" danger loading={loading}>
                结束会议
              </Button>
            )}
            {isRecording && (
              <Button size="small" onClick={cancel} disabled={loading}>
                取消
              </Button>
            )}
          </div>

          {state.error && <div className="adm-callout err">错误：{state.error}</div>}

          <div className="meet-log">
            {state.segments.length === 0 ? (
              isProcessing ? (
                <div className="pnl-hint">生成总结中…</div>
              ) : (
                <div className="pnl-hint">等待音频输入…</div>
              )
            ) : (
              state.segments.map((s) => {
                const m = Math.floor(s.startMs / 60000);
                const sec = Math.floor((s.startMs % 60000) / 1000);
                return (
                  <div key={s.id} className="meet-seg">
                    <time>
                      {String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')}
                    </time>
                    <span>{s.text}</span>
                  </div>
                );
              })
            )}
          </div>

          {state.rollingSummary && (
            <>
              <div className="pnl-sec-h" style={{ marginTop: 16 }}>
                滚动摘要
              </div>
              <div className="meet-text">{state.rollingSummary}</div>
            </>
          )}

          {state.finalSummary && (
            <>
              <div className="pnl-sec-h" style={{ marginTop: 16 }}>
                最终总结
              </div>
              <div className="meet-text">{state.finalSummary}</div>
              {state.transcriptPath && (
                <p className="pnl-hint" style={{ marginTop: 8, wordBreak: 'break-all' }}>
                  完整转录已保存：{state.transcriptPath}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

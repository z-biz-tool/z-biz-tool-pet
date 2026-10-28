// 「她的记忆」面板：长期记忆 v2 的唯一可视化入口。
//
// 为什么必须给用户看这个：记忆是**看不见**的功能。她答对了一句"你生日是三月七号"，
// 用户没法判断这是记住了还是蒙的。所以这个面板要能回答三个问题：
//   1. 她到底记住了什么？（列表 + 分类 + 来源）
//   2. 这些东西是怎么被用上的？（「她会怎么想起」预览，直接展示注入 prompt 的片段）
//   3. 记错了怎么办？（改、删、置顶、清空）
//
// 布局沿用管理端的设计令牌（--bg/--line/--text/--accent），不引入新颜色。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer, Input, Segmented, Empty, Tooltip, message } from 'antd';
import {
  DeleteOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

interface Props {
  open: boolean;
  onClose: () => void;
}

const KINDS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'fact', label: '事实' },
  { key: 'preference', label: '偏好' },
  { key: 'person', label: '人' },
  { key: 'event', label: '经历' },
  { key: 'plan', label: '打算' },
  { key: 'trait', label: '性格' },
];

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  KINDS.filter((k) => k.key !== 'all').map((k) => [k.key, k.label])
);

const SOURCE_LABEL: Record<string, string> = {
  regex: '从你说的话里认出',
  llm: '她自己记下的',
  manual: '你教她记的',
  episode: '一段经历',
  migration: '旧版带过来的',
};

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

function relTime(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

const MemoryPanel: React.FC<Props> = ({ open, onClose }) => {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [list, setList] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState('fact');
  const [probe, setProbe] = useState('');
  const [probeResult, setProbeResult] = useState<{ context: string; hits: MemoryEntry[] } | null>(null);
  const [busy, setBusy] = useState('');

  const api = window.electronAPI;

  const reload = useCallback(
    async (q = query, k = kind) => {
      if (!api?.memoryList) return;
      setLoading(true);
      try {
        const items = await api.memoryList(q.trim() || undefined, k === 'all' ? undefined : k, 300);
        setList(Array.isArray(items) ? items : []);
      } catch (error) {
        message.error(`读取记忆失败：${String(error)}`);
      } finally {
        setLoading(false);
      }
    },
    [api, query, kind]
  );

  const reloadStats = useCallback(async () => {
    if (!api?.memoryStats) return;
    try {
      setStats(await api.memoryStats());
    } catch {
      /* 统计失败不影响列表 */
    }
  }, [api]);

  useEffect(() => {
    if (!open) return;
    void reload();
    void reloadStats();
    // 只在打开时拉一次；搜索/切换分类由各自的 handler 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeCount = useMemo(() => list.filter((m) => !m.archived).length, [list]);

  const handleAdd = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    if (!api?.memoryAdd) return;
    try {
      await api.memoryAdd(content, draftKind, undefined, 100);
      setDraft('');
      message.success('记下了');
      await reload();
      await reloadStats();
    } catch (error) {
      message.error(`没记住：${String(error)}`);
    }
  }, [api, draft, draftKind, reload, reloadStats]);

  const handleTogglePin = useCallback(
    async (entry: MemoryEntry) => {
      if (!api?.memoryUpdate) return;
      try {
        await api.memoryUpdate(entry.id, { pinned: !entry.pinned });
        await reload();
        await reloadStats();
      } catch (error) {
        message.error(`操作失败：${String(error)}`);
      }
    },
    [api, reload, reloadStats]
  );

  const handleDelete = useCallback(
    async (entry: MemoryEntry) => {
      if (!api?.memoryDelete) return;
      try {
        await api.memoryDelete(entry.id);
        await reload();
        await reloadStats();
      } catch (error) {
        message.error(`删除失败：${String(error)}`);
      }
    },
    [api, reload, reloadStats]
  );

  const handleProbe = useCallback(async () => {
    const q = probe.trim();
    if (!q || !api?.memoryRecallPreview) return;
    setBusy('probe');
    try {
      setProbeResult(await api.memoryRecallPreview(q));
    } catch (error) {
      message.error(`试不出来：${String(error)}`);
    } finally {
      setBusy('');
    }
  }, [api, probe]);

  const handleExtract = useCallback(async () => {
    if (!api?.mindExtractNow) return;
    setBusy('extract');
    try {
      const res = await api.mindExtractNow();
      if (res.ok) {
        message.success(res.added ? `整理出 ${res.added} 条` : '没有新的可记');
        await reload();
        await reloadStats();
      } else {
        message.warning(`整理失败：${res.error ?? '模型没回应'}`);
      }
    } finally {
      setBusy('');
    }
  }, [api, reload, reloadStats]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      closable={false}
      styles={{ body: { padding: 0 } }}
      title={null}
    >
      <div className="mem-root">
        <header className="mem-head">
          <div>
            <h2 className="mem-title">她的记忆</h2>
            <p className="mem-sub">
              {stats
                ? `${stats.total} 件事 · ${stats.pinned} 条置顶 · ${stats.byKind.event ?? 0} 段经历`
                : '正在读取…'}
            </p>
          </div>
          <div className="mem-head-actions">
            <Tooltip title="从最近的对话里再整理一次">
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="现在整理一次"
                disabled={busy === 'extract'}
                onClick={handleExtract}
              >
                <ThunderboltOutlined spin={busy === 'extract'} />
              </button>
            </Tooltip>
            <Tooltip title="刷新">
              <button
                type="button"
                className="adm-iconbtn"
                aria-label="刷新记忆"
                onClick={() => {
                  void reload();
                  void reloadStats();
                }}
              >
                <ReloadOutlined spin={loading} />
              </button>
            </Tooltip>
          </div>
        </header>

        <section className="mem-block">
          <div className="mem-search">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜她记住的事…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onPressEnter={() => void reload()}
            />
          </div>
          <Segmented
            size="small"
            block
            value={kind}
            onChange={(v) => {
              setKind(String(v));
              void reload(query, String(v));
            }}
            options={KINDS.map((k) => ({ label: k.label, value: k.key }))}
          />
        </section>

        <section className="mem-block">
          <div className="mem-block-title">她会怎么想起</div>
          <div className="mem-inline">
            <Input
              placeholder="随便说一句，看她能想起什么"
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              onPressEnter={handleProbe}
            />
            <button
              type="button"
              className="mem-btn"
              disabled={!probe.trim() || busy === 'probe'}
              onClick={handleProbe}
            >
              试试
            </button>
          </div>
          {probeResult && (
            <div className="mem-probe">
              {probeResult.hits.length === 0 ? (
                <p className="mem-probe-empty">这件事她想不起来——她的记忆里没有相关的。</p>
              ) : (
                <>
                  <p className="mem-probe-hint">
                    想到 {probeResult.hits.length} 条，这些会拼进她的系统提示：
                  </p>
                  <ul className="mem-probe-list">
                    {probeResult.hits.map((h) => (
                      <li key={h.id}>
                        <span className={`mem-kind mem-kind-${h.kind}`}>{KIND_LABEL[h.kind] ?? h.kind}</span>
                        {h.content}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>

        <section className="mem-block">
          <div className="mem-block-title">教她记一件事</div>
          <div className="mem-inline">
            <Input
              placeholder="例如：我对花生过敏"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPressEnter={handleAdd}
            />
            <select
              className="mem-select"
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value)}
              aria-label="记忆类型"
            >
              {KINDS.filter((k) => k.key !== 'all').map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
            <button type="button" className="mem-btn" disabled={!draft.trim()} onClick={handleAdd}>
              记住
            </button>
          </div>
          <p className="mem-tip">你教的记忆置信度是满的，她不会怀疑；也不会被自动整理覆盖。</p>
        </section>

        <section className="mem-block mem-list-block">
          <div className="mem-block-title">
            记住的事
            <span className="mem-count">{activeCount}</span>
          </div>
          {list.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={loading ? '正在读…' : '还是空的。多聊几句，她自己会记。'}
            />
          ) : (
            <ul className="mem-list">
              {list.map((m) => (
                <li key={m.id} className={`mem-item ${m.pinned ? 'is-pinned' : ''} ${m.archived ? 'is-archived' : ''}`}>
                  <div className="mem-item-main">
                    <div className="mem-item-head">
                      <span className={`mem-kind mem-kind-${m.kind}`}>{KIND_LABEL[m.kind] ?? m.kind}</span>
                      <span className="mem-item-content">{m.content}</span>
                    </div>
                    <div className="mem-item-meta">
                      <span>{sourceLabel(m.source)}</span>
                      <span>·</span>
                      <span>{relTime(m.updatedAt)}</span>
                      {m.hits > 0 && (
                        <>
                          <span>·</span>
                          <span>被想起 {m.hits} 次</span>
                        </>
                      )}
                      {m.confidence < 100 && (
                        <>
                          <span>·</span>
                          <span>把握 {m.confidence}%</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="mem-item-actions">
                    <Tooltip title={m.pinned ? '取消置顶' : '置顶（永远进上下文）'}>
                      <button
                        type="button"
                        className={`mem-act ${m.pinned ? 'is-on' : ''}`}
                        aria-label={m.pinned ? '取消置顶' : '置顶'}
                        onClick={() => void handleTogglePin(m)}
                      >
                        {m.pinned ? <PushpinFilled /> : <PushpinOutlined />}
                      </button>
                    </Tooltip>
                    <Tooltip title="忘掉这条">
                      <button
                        type="button"
                        className="mem-act mem-act-danger"
                        aria-label="删除这条记忆"
                        onClick={() => void handleDelete(m)}
                      >
                        <DeleteOutlined />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {stats && (
          <footer className="mem-foot">
            <span>存在 {stats.file}</span>
          </footer>
        )}
      </div>
    </Drawer>
  );
};

export default MemoryPanel;

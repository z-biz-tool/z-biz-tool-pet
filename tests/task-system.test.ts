import { describe, it, expect, vi } from 'vitest';
import { TaskExecutor, setTaskDispatcher } from '../src/main/task-system';

// 这组测试是本轮安全优化的核心回归：
// 原实现里 command 动作会直接 execAsync(action.content) 且动作通过 process.send 投递（在 main 中恒为 undefined）。

describe('TaskExecutor：dispatcher 未注入时必须安全静默', () => {
  it('command 动作不会去执行 shell', async () => {
    await expect(TaskExecutor.execute({ type: 'command', content: 'echo pwned' }, { name: 't' } as any)).resolves.toBeUndefined();
  });

  it('speak 动作不会抛异常', async () => {
    await expect(TaskExecutor.execute({ type: 'speak', content: 'hi' }, { name: 't' } as any)).resolves.toBeUndefined();
  });
});

describe('TaskExecutor：注入 dispatcher 后的投递契约', () => {
  it('非命令动作走 dispatch，并带上任务名', async () => {
    const dispatch = vi.fn();
    const requestCommandRun = vi.fn();
    setTaskDispatcher({ dispatch, requestCommandRun });

    for (const type of ['speak', 'animation', 'changeScenery', 'petAction']) {
      dispatch.mockClear();
      requestCommandRun.mockClear();
      await TaskExecutor.execute({ type, content: 'x' }, { name: '早安任务' } as any);

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({ type, content: 'x', taskName: '早安任务' });
      expect(requestCommandRun).not.toHaveBeenCalled();
    }
  });

  it('command 动作必须经 requestCommandRun（而非自己 exec）', async () => {
    const dispatch = vi.fn();
    const requestCommandRun = vi.fn().mockResolvedValue({ ok: true, output: 'done' });
    setTaskDispatcher({ dispatch, requestCommandRun });

    await TaskExecutor.execute({ type: 'command', content: 'ls -la' }, { name: '清理' } as any);

    expect(requestCommandRun).toHaveBeenCalledTimes(1);
    expect(requestCommandRun).toHaveBeenCalledWith('清理', 'ls -la');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('用户拒绝命令时执行器不抛异常，只记日志', async () => {
    const requestCommandRun = vi.fn().mockResolvedValue({ ok: false, error: '用户拒绝执行任务命令' });
    setTaskDispatcher({ dispatch: vi.fn(), requestCommandRun });

    await expect(
      TaskExecutor.execute({ type: 'command', content: 'rm -rf /' }, { name: '危险任务' } as any)
    ).resolves.toBeUndefined();
    expect(requestCommandRun).toHaveBeenCalledTimes(1);
  });

  it('requestCommandRun 抛异常时不会冒泡打断调度器', async () => {
    setTaskDispatcher({
      dispatch: vi.fn(),
      requestCommandRun: vi.fn().mockRejectedValue(new Error('boom')),
    });

    // 调度器 setInterval 触发且不 await，这里必须吞掉异常而不是变成 unhandled rejection
    await expect(
      TaskExecutor.execute({ type: 'command', content: 'ls' }, { name: 't' } as any)
    ).resolves.toBeUndefined();
  });

  it('未知动作类型不投递也不执行', async () => {
    const dispatch = vi.fn();
    const requestCommandRun = vi.fn();
    setTaskDispatcher({ dispatch, requestCommandRun });

    await TaskExecutor.execute({ type: 'launch_missiles', content: 'x' }, { name: 't' } as any);

    expect(dispatch).not.toHaveBeenCalled();
    expect(requestCommandRun).not.toHaveBeenCalled();
  });
});

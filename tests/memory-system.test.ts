import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initMemory,
  addLongTermMemory,
  getLongTermMemory,
  removeLongTermMemory,
  addShortTermMemory,
  getShortTermMemory,
  resetMemory,
} from '../src/main/memory-system';

let dir: string;

describe('memory-system 持久化（修复 D11：dataDir 未定义导致保存必失败）', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-memory-'));
  });

  it('未 initMemory 时保存不得抛异常', () => {
    expect(() => addLongTermMemory('未初始化', '不应崩溃', 90)).not.toThrow();
  });

  it('initMemory 之后长期记忆要真正落盘', () => {
    initMemory(dir);
    addLongTermMemory('用户生日', '3月5日', 95);

    const file = path.join(dir, 'long_term_memory.json');
    expect(fs.existsSync(file)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Array.isArray(saved)).toBe(true);
    const hit = saved.find((m: any) => m.key === '用户生日');
    expect(hit).toBeTruthy();
    expect(hit.content).toBe('3月5日');
    expect(hit.confidence).toBe(95);
  });

  it('原子写不留 .tmp 残留', () => {
    initMemory(dir);
    addLongTermMemory('常用语言', '中文', 80);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('重新 init 能从磁盘读回', () => {
    initMemory(dir);
    const all = getLongTermMemory() as any[];
    expect(all.map((m) => m.key)).toContain('用户生日');
  });

  it('removeLongTermMemory 会同步更新磁盘', () => {
    initMemory(dir);
    expect(removeLongTermMemory('用户生日')).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'long_term_memory.json'), 'utf-8'));
    expect(saved.find((m: any) => m.key === '用户生日')).toBeUndefined();
  });

  it('getLongTermMemory(key) 未命中返回 null 而不是 undefined', () => {
    initMemory(dir);
    expect(getLongTermMemory('不存在记忆')).toBeNull();
  });

  it('短期记忆上限 50 条且与长期互不影响', () => {
    initMemory(dir);
    resetMemory();
    for (let i = 0; i < 60; i++) {
      addShortTermMemory({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const short = getShortTermMemory();
    expect(short.length).toBeLessThanOrEqual(50);
    expect(short[short.length - 1].content).toBe('msg 59');
  });

  it('损坏的长期记忆文件不会让 init 抛异常', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-memory-broken-'));
    fs.writeFileSync(path.join(broken, 'long_term_memory.json'), '{ this is not json', 'utf-8');
    expect(() => initMemory(broken)).not.toThrow();
    expect(getLongTermMemory()).toEqual([]);
  });
});

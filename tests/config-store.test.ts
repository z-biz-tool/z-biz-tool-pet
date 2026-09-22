import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// config-store 在 import 期就用 app.getPath 拼出 dataDir，因此必须先定好假 home。
// vi.hoisted 在 import 之前执行，里面不能用 fs/path，只能靠 process.env 拼路径。
const { home } = vi.hoisted(() => {
  const base = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  return { home: `${base}/zbot-home-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
});

// 可逆的假加密：做一次字符序变换，让"密文读不出明文"这一断言真正有意义
let encryptionAvailable = true;
const FAKE_PREFIX = 'ENC::';
const scramble = (s: string) => [...s].reverse().join('');

vi.mock('electron', () => ({
  app: { getPath: (k: string) => (k === 'home' ? home : path.join(home, '.config-zbot')) },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plain: string) => Buffer.from(FAKE_PREFIX + scramble(plain), 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (!s.startsWith(FAKE_PREFIX)) throw new Error('bad ciphertext');
      return scramble(s.slice(FAKE_PREFIX.length));
    },
  },
}));

const cs = await import('../src/main/config-store');

let dir: string;

beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  dir = path.join(home, '.z-bot');
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  encryptionAvailable = true;
});

describe('JsonStore：内存缓存（修复 D22 每次调用都读盘）', () => {
  it('第二次 read 不再触碰磁盘', () => {
    const file = path.join(dir, 'cache-a.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ a: 1 }), 'utf8');
    const store = new cs.JsonStore<{ a: number; b?: number }>(file, { a: 0 });

    expect(store.read()).toEqual({ a: 1 });

    // 绕过 store 直接改盘：若仍走缓存说明命中了内存
    fs.writeFileSync(file, JSON.stringify({ a: 999 }), 'utf8');
    expect(store.read()).toEqual({ a: 1 });
  });

  it('write 后读回新值并落盘', async () => {
    const file = path.join(dir, 'cache-b.json');
    const store = new cs.JsonStore<{ n: number }>(file, { n: 0 });
    await store.write({ n: 42 });
    expect(store.read()).toEqual({ n: 42 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ n: 42 });
  });

  it('patch 只合并给定字段', async () => {
    const file = path.join(dir, 'cache-c.json');
    const store = new cs.JsonStore<{ x: number; y: number }>(file, { x: 1, y: 2 });
    await store.write({ x: 10, y: 20 });
    await store.patch({ y: 99 });
    expect(store.read()).toEqual({ x: 10, y: 99 });
  });

  it('原子写不留 .tmp 残留，且并发写串行后为最后一次的值', async () => {
    const file = path.join(dir, 'cache-d.json');
    const store = new cs.JsonStore<{ v: number }>(file, { v: 0 });
    await Promise.all([store.write({ v: 1 }), store.write({ v: 2 }), store.write({ v: 3 })]);
    await store.flush();
    const left = fs.readdirSync(dir).filter((f) => f.startsWith('cache-d.json.') && f.endsWith('.tmp'));
    expect(left).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 3 });
  });

  it('数组型 store 可正常读写（历史列表用）', async () => {
    const file = path.join(dir, 'cache-list.json');
    const store = new cs.JsonStore<Array<{ id: string }>>(file, []);
    expect(store.read()).toEqual([]);
    await store.write([{ id: 'a' }, { id: 'b' }]);
    expect(Array.isArray(store.read())).toBe(true);
    expect(store.read()).toHaveLength(2);
  });

  it('损坏的 JSON 不抛异常，回落默认值并留下 .corrupt 备份', () => {
    const file = path.join(dir, 'cache-broken.json');
    fs.writeFileSync(file, '{ 这不是 json', 'utf8');
    const store = new cs.JsonStore<{ k: string }>(file, { k: 'default' });
    expect(() => store.read()).not.toThrow();
    expect(store.read()).toEqual({ k: 'default' });
    expect(fs.readdirSync(dir).some((f) => f.startsWith('cache-broken.json.corrupt.'))).toBe(true);
  });
});

describe('密钥加密存储（T4.10 / 修复 H01 明文存储）', () => {
  it('可用系统加密时，落盘文件不含明文且能解密', () => {
    const r = cs.saveApiKey('sk-super-secret-123');
    expect(r.encrypted).toBe(true);
    const raw = fs.readFileSync(path.join(dir, 'api_key.enc'));
    expect(raw.toString('utf8')).not.toContain('sk-super-secret-123');
    expect(cs.loadApiKey()).toBe('sk-super-secret-123');
  });

  it('系统加密不可用时降级为明文文件但仍可读回', () => {
    encryptionAvailable = false;
    const r = cs.saveApiKey('sk-fallback-456');
    expect(r.encrypted).toBe(false);
    expect(cs.loadApiKey()).toBe('sk-fallback-456');
  });

  it('无密钥文件时返回 null', () => {
    cs.clearApiKey();
    expect(cs.loadApiKey()).toBeNull();
  });

  it('明文 config 会被迁移：store 内不再保留 aiApiKey，且能从加密存储读回', async () => {
    const file = path.join(dir, 'migrate.json');
    fs.writeFileSync(file, JSON.stringify({ aiApiKey: 'sk-legacy-789', petName: 'Z' }), 'utf8');
    const store = new cs.JsonStore<any>(file, {});
    cs.clearApiKey();

    expect(cs.migratePlaintextApiKey(store)).toBe(true);
    expect(store.read().aiApiKey).toBeUndefined(); // 迁移后配置里彻底不留该字段
    expect(cs.loadApiKey()).toBe('sk-legacy-789');

    await store.flush();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-legacy-789');
    // 幂等：再次迁移应为 false
    expect(cs.migratePlaintextApiKey(store)).toBe(false);
  });

  it('resolveApiKey 优先取加密存储，回退 config 字段', () => {
    cs.clearApiKey();
    expect(cs.resolveApiKey({ aiApiKey: 'from-config' })).toBe('from-config');
    cs.saveApiKey('from-vault');
    expect(cs.resolveApiKey({ aiApiKey: 'from-config' })).toBe('from-vault');
    cs.clearApiKey();
  });
});

describe('子进程日志收集（04 §7.1）', () => {
  it('appendServerLog 落到 ~/.z-bot/logs 且带时间戳', () => {
    cs.appendServerLog('stt', 'hello-line');
    const file = path.join(dir, 'logs', 'stt.log');
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('hello-line');
    expect(/\[\d{4}-\d{2}-\d{2}T/.test(content)).toBe(true);
  });
});

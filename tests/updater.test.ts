import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { home } = vi.hoisted(() => {
  const base = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  return { home: `${base}/zbot-upd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
});

let packaged = false;

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'home' ? home : path.join(home, 'cfg')),
    get isPackaged() {
      return packaged;
    },
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => ({ version: '9.9.9' })),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
  },
}));

const up = await import('../src/main/updater');

beforeEach(() => {
  fs.mkdirSync(path.join(home, '.z-bot'), { recursive: true });
});

afterEach(() => {
  delete process.env.ZBOT_UPDATE_FEED_URL;
  try {
    fs.unlinkSync(path.join(home, '.z-bot', 'update-feed.json'));
  } catch {}
});

describe('发布源解析（T5.6）', () => {
  it('环境变量优先，且只接受 http(s)', () => {
    process.env.ZBOT_UPDATE_FEED_URL = 'https://example.com/zbot';
    expect(up.readFeed()?.url).toBe('https://example.com/zbot');
    process.env.ZBOT_UPDATE_FEED_URL = 'file:///etc';
    expect(up.readFeed()).toBeNull();
  });

  it('本地 feed 文件可用并带 channel', () => {
    fs.writeFileSync(
      path.join(home, '.z-bot', 'update-feed.json'),
      JSON.stringify({ url: 'https://mirror.example/zbot', channel: 'beta' }),
      'utf-8'
    );
    expect(up.readFeed()).toEqual({ url: 'https://mirror.example/zbot', channel: 'beta' });
  });

  it('坏 JSON / 缺 url / 非法协议都返回 null 而不抛异常', () => {
    const f = path.join(home, '.z-bot', 'update-feed.json');
    for (const bad of ['{ nope', '{}', JSON.stringify({ url: 'javascript:alert(1)' })]) {
      fs.writeFileSync(f, bad, 'utf-8');
      expect(up.readFeed()).toBeNull();
    }
  });
});

describe('未打包时必须优雅返回而不是去发请求', () => {
  it('dev 模式下 checkForUpdates 返回 dev-mode', async () => {
    packaged = false;
    up.initUpdater(() => {});
    const r = await up.checkForUpdates();
    expect(r.status).toBe('dev-mode');
    expect(r.ok).toBe(false);
    const dl = await up.downloadAndInstall();
    expect(dl.ok).toBe(false);
  });

  it('getUpdateStatus 会回报上一次检查的结果', async () => {
    packaged = false;
    const before = up.getUpdateStatus();
    expect(['no-feed', 'dev-mode']).toContain(before.status);
    const checked = await up.checkForUpdates();
    expect(up.getUpdateStatus()).toEqual(checked);
  });
});

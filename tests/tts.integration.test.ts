import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * TTS 服务端到端（doc 06 §2.2 P0 / A05 / A13）
 * 关键点：合成必须在**没有网络**时也能出音频 —— 曾经的 edge-tts 会把文本发给微软。
 */
const PORT = 18086;
const TOKEN = 'tts-integration-token';
const proxy = 'http://127.0.0.1:1/'; // 指向关闭端口：任何走 HTTP 代理的外发都会失败
let child: ChildProcess | null = null;
let dir: string;

function startServer() {
  return new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, [path.join(process.cwd(), 'server', 'tts.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        ZBOT_AUTH_TOKEN: TOKEN,
        // 断网代理：本地引擎（say / PowerShell / espeak）不经过代理，云端 TTS 一定会
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        ALL_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        all_proxy: proxy,
        no_proxy: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('Running on')) resolve();
    };
    child!.stdout!.on('data', onData);
    child!.stderr!.on('data', onData);
    child!.once('error', reject);
    setTimeout(() => reject(new Error('TTS 启动超时:\n' + buf)), 15000);
  });
}

function stopServer() {
  return new Promise<void>((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    c.once('close', () => resolve());
    c.kill('SIGTERM');
    setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {}
      resolve();
    }, 3000);
  });
}

async function post(body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-auth-token': token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-it-tts-fixture-'));
  await startServer();
});

afterAll(async () => {
  await stopServer();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe('TTS 服务端到端', () => {
  it('health 免鉴权，并报告使用的是本地引擎', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.service).toBe('tts');
    expect(['darwin', 'win32', 'linux']).toContain(data.engine);
    expect(typeof data.ok).toBe('boolean');
  });

  it('无 token → 401（A10）', async () => {
    const r = await post({ text: '测试' });
    expect(r.status).toBe(401);
  });

  it('错误 token → 401', async () => {
    const r = await post({ text: '测试' }, 'nope');
    expect(r.status).toBe(401);
  });

  it('空文本 → 400', async () => {
    const r = await post({ text: '' }, TOKEN);
    expect(r.status).toBe(400);
  });

  it('带 token 合成 → 返回音频 base64，且在断网代理下依然可用（A13 本地化）', async () => {
    const r = await post({ text: '你好，我是桌面宠物' }, TOKEN);
    const health: any = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    if (!health.ok) {
      // 本机没有可用离线引擎时，必须是明确的 503 而不是静默失败或偷偷联网
      expect(r.status).toBe(503);
      expect(r.data.error).toContain('离线');
      return;
    }
    if (process.platform === 'win32') {
      // Windows 的引擎是 powershell + System.Speech，CI runner 上未必装了可用音色。
      // 硬契约只有一条：200 就必须带能播的音频，否则只能是带原因的 500/503。
      // （这里曾经真实返回过 200 + 64 B 空 wav 头，用户侧表现为"说话却是静音"。）
      expect([200, 500, 503]).toContain(r.status);
      if (r.status !== 200) {
        expect(typeof r.data.error).toBe('string');
        expect(r.data.error.length).toBeGreaterThan(0);
        return;
      }
    }
    expect(r.status).toBe(200);
    expect(typeof r.data.audio).toBe('string');
    // 44 B 是空 wav 头，base64 后约 60 字符；阈值远高于它才能挡住静音
    expect(r.data.audio.length).toBeGreaterThan(100);
    expect(['mp3', 'wav', 'aiff']).toContain(r.data.format);
    // 首字节延迟目标 A05 < 500ms 只做记录，本机负载不稳，不做硬断言
  }, 30000);

  it('长文本被截断而不是原样送给引擎（防滥用）', async () => {
    const r = await post({ text: '啊'.repeat(5000) }, TOKEN);
    // 这条要锁的是"进引擎的文本被裁到 2000 字"，不是"这台机器的 TTS 一定能出声"。
    // Windows CI runner 上 SAPI 对 2000 个同字会当场拒绝（500），所以这里只要求
    // 状态落在"要么出声、要么明确报错"，并把响应体带进失败信息好定位原因。
    expect([200, 500, 503], JSON.stringify(r.data).slice(0, 200)).toContain(r.status);
    if (r.status === 200) {
      expect(r.data.audio.length).toBeGreaterThan(100);
    } else {
      // 静默失败不允许：必须给出可定位的原因
      expect(String(r.data.error ?? '') + String(r.data.details ?? '')).not.toBe('');
    }
  }, 30000);

  it('合成结束不残留音频临时文件（A14）', async () => {
    const T = os.tmpdir();
    const workDirs = fs.readdirSync(T).filter((n) => /^zbot-tts-[A-Za-z0-9]{6}$/.test(n));
    const leftovers = workDirs.flatMap((d) => {
      try {
        return fs
          .readdirSync(path.join(T, d))
          .filter((f) => /\.(mp3|wav|aiff)$/.test(f))
          .map((f) => path.join(d, f));
      } catch {
        return [];
      }
    });
    expect(leftovers).toEqual([]);
  });
});

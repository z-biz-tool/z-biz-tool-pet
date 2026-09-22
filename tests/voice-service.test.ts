import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// voice-service → config-store → electron，node 环境下必须打桩
vi.mock('electron', () => ({
  app: { getPath: (k: string) => (k === 'home' ? '/tmp/zbot-fake-home' : `/tmp/zbot-fake-${k}`) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
}));

const { VoiceService } = await import('../src/main/voice-service');

/**
 * A15 / doc 06 §2.4「STT 服务崩溃 → main 检测退出 → 自动重启」
 * 用一份"第一次运行故意崩溃"的 stub 服务来驱动真实的 VoiceService 重启逻辑，
 * 断言端口在 5 秒内重新可响应。
 */
const STT_PORT = 18094;
const TTS_PORT = 18095;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-vs-'));

// 第一次启动：报"已就绪"后 200ms 自杀，模拟 dyld 崩溃 / OOM
// 之后每次启动：正常挂着并响应 /health
fs.writeFileSync(
  path.join(dir, 'stt.js'),
  `const http = require('http');
const marker = process.env.__CRASH_ONCE;
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ ok: true, service: 'stt' })); }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => {
  console.log('[STT Server] Running on http://127.0.0.1:' + port);
  if (marker && !require('fs').existsSync(marker)) {
    require('fs').writeFileSync(marker, 'crashed');
    setTimeout(() => process.exit(1), 200);
  }
});
`
);

fs.writeFileSync(
  path.join(dir, 'tts.js'),
  `const http = require('http');
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ ok: true, service: 'tts' })); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log('[TTS Server] Running on http://127.0.0.1:' + port));
`
);

const marker = path.join(dir, 'crashed.flag');
process.env.__CRASH_ONCE = marker;

const svc = new VoiceService({ sttPort: STT_PORT, ttsPort: TTS_PORT, serverDir: dir });

async function portAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

afterAll(() => {
  svc.stop();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe('语音子进程崩溃恢复（A15）', () => {
  it('崩溃后 5 秒内自动重启并重新可服务（A15）', async () => {
    svc.start();

    // 等 stub 第一次起来并写下"我要崩了"的标记
    let sawFirst = false;
    const t0 = Date.now();
    while (!sawFirst && Date.now() - t0 < 8000) {
      sawFirst = fs.existsSync(marker);
      if (!sawFirst) await new Promise((r) => setTimeout(r, 50));
    }
    expect(sawFirst).toBe(true);

    // 必须等到端口真的掉下来（第一个实例已死），否则测的是旧实例
    let wentDown = false;
    const tDown = Date.now();
    while (!wentDown && Date.now() - tDown < 8000) {
      wentDown = !(await portAlive(STT_PORT));
      if (!wentDown) await new Promise((r) => setTimeout(r, 50));
    }
    expect(wentDown).toBe(true);

    const tRecover = Date.now();
    let recovered = false;
    while (!recovered && Date.now() - tRecover < 8000) {
      recovered = await portAlive(STT_PORT);
      if (!recovered) await new Promise((r) => setTimeout(r, 150));
    }
    const elapsed = Date.now() - tRecover;

    expect(recovered).toBe(true);
    expect(elapsed).toBeLessThan(5000); // A15 目标：崩溃恢复 < 5s
    expect(svc.status().find((x) => x.name === 'stt')?.restarts).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('stop() 之后端口不再可访问', async () => {
    svc.stop();
    await new Promise((r) => setTimeout(r, 1200));
    expect(await portAlive(STT_PORT)).toBe(false);
    expect(await portAlive(TTS_PORT)).toBe(false);
  });

  it('脚本目录不存在时 start 不抛异常（只跳过）', () => {
    const empty = new VoiceService({ sttPort: 18096, ttsPort: 18097, serverDir: path.join(dir, 'nope') });
    expect(() => empty.start()).not.toThrow();
    expect(() => empty.stop()).not.toThrow();
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * STT 服务端到端（doc 06 §2.2 P0 / A10 / A14）
 * 用 stub whisper-cli 顶掉真实模型，验证鉴权、识别链路、模型缺失与临时文件清理。
 */
const PORT = 18084;
const TOKEN = 'integration-token';
let child: ChildProcess | null = null;
let dir: string;
let modelPath: string;
let sampleWav: string;

function makeWav(frames: number): Buffer {
  const rate = 16000;
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 4000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function post(body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-auth-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

async function get(pathname: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

function startServer(env: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, [path.join(process.cwd(), 'server', 'stt.js')], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ZBOT_AUTH_TOKEN: TOKEN, ...env },
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
    setTimeout(() => reject(new Error('STT 服务启动超时:\n' + buf)), 15000);
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-it-stt-fixture-'));
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  modelPath = path.join(dir, 'models', 'ggml-base.bin');
  fs.writeFileSync(modelPath, 'fake-model');

  const stub = path.join(dir, 'whisper-cli');
  fs.writeFileSync(
    stub,
    '#!/bin/sh\n' +
      'm=""; f=""\n' +
      'while [ $# -gt 0 ]; do case "$1" in -m) m="$2"; shift 2;; -f) f="$2"; shift 2;; *) shift;; esac; done\n' +
      '[ -f "$m" ] || { echo "no model" >&2; exit 2; }\n' +
      '[ -f "$f" ] || { echo "no wav" >&2; exit 2; }\n' +
      'printf "stub-ok %s\\n" "$f"\n'
  );
  fs.chmodSync(stub, 0o755);
  process.env.__STT_STUB = stub;

  sampleWav = path.join(dir, 'sample.wav');
  fs.writeFileSync(sampleWav, makeWav(8000));

  await startServer({
    ZBOT_DATA_DIR: dir,
    ZBOT_WHISPER_BIN: stub,
  });
});

afterAll(async () => {
  await stopServer();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe('STT 服务端到端', () => {
  it('health 免鉴权可读，且报告就绪', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.data.service).toBe('stt');
    expect(r.data.ok).toBe(true);
  });

  it('无 token 提交音频 → 401（A10）', async () => {
    const audio = fs.readFileSync(sampleWav).toString('base64');
    const r = await post({ audio });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe('Unauthorized');
  });

  it('错误 token → 401', async () => {
    const audio = fs.readFileSync(sampleWav).toString('base64');
    const r = await post({ audio }, 'wrong-token');
    expect(r.status).toBe(401);
  });

  // stub 是一个 #!/bin/sh 脚本，Windows 上 CreateProcess 跑不了 POSIX 脚本，
  // 这条 happy path 只能在 POSIX 侧验证。Windows 侧同一入口由下面"不可执行文件"
  // 那组用例覆盖（500 + 服务不能被一次失败请求打死），别把这里的跳过当成
  // "Windows 不需要测"。
  it.skipIf(process.platform === 'win32')('带 token 提交 wav → 返回识别文本（wav 直通，不需 ffmpeg）', async () => {
    const audio = fs.readFileSync(sampleWav).toString('base64');
    const r = await post({ audio }, TOKEN);
    expect(r.status).toBe(200);
    expect(typeof r.data.text).toBe('string');
    expect(r.data.text).toContain('stub-ok');
    expect(r.data.via).toBe('wav-passthrough');
  });

  it('空音频 → 400', async () => {
    const r = await post({ audio: '' }, TOKEN);
    expect(r.status).toBe(400);
  });

  it('处理完不残留用户音频（A14）', async () => {
    const T = os.tmpdir();
    // 只看服务自己的私有工作目录，且只关心音频文件本身是否残留
    const workDirs = fs.readdirSync(T).filter((n) => /^zbot-stt-[A-Za-z0-9]{6}$/.test(n));
    expect(workDirs.length).toBeGreaterThan(0);
    const audioLeft = workDirs.flatMap((d) => {
      try {
        return fs
          .readdirSync(path.join(T, d))
          .filter((f) => f.endsWith('.wav') || f.endsWith('.webm'))
          .map((f) => path.join(d, f));
      } catch {
        return [];
      }
    });
    expect(audioLeft).toEqual([]);
  });
});

describe('模型缺失时明确报错（doc 06 §2.4 故障注入）', () => {
  it('删除模型 → 503 且带可操作提示', async () => {
    await stopServer();
    fs.rmSync(modelPath, { force: true });
    await startServer({
      ZBOT_DATA_DIR: dir,
      ZBOT_WHISPER_BIN: path.join(dir, 'whisper-cli'),
    });
    const r = await post({ audio: 'AAAA' }, TOKEN);
    expect(r.status).toBe(503);
    expect(r.data.error).toContain('whisper 模型未找到');
    expect(r.data.error).toContain('README');
  });

  it('whisper-cli 不存在 → 503 且提示 ZBOT_WHISPER_BIN', async () => {
    await stopServer();
    await startServer({
      ZBOT_DATA_DIR: dir,
      ZBOT_WHISPER_BIN: path.join(dir, 'does-not-exist'),
    });
    const r = await post({ audio: 'AAAA' }, TOKEN);
    expect(r.status).toBe(503);
    expect(r.data.error).toContain('ZBOT_WHISPER_BIN');
  });
});

describe('spawn 失败不得打死服务（Windows CI 实测回归）', () => {
  // Windows 腿曾出现：stub 不可执行 → 'error' 分支已经写过响应，'close' 又写一次，
  // 第二次的 ERR_HTTP_HEADERS_SENT 从 EventEmitter 回调里冒出来没人 catch，进程直接退出，
  // 连 'exit' 钩子把私有工作目录一起删掉 ⇒ 后续请求全成 ECONNRESET。
  // 这里用"存在但不可执行"的二进制触发同一条路径（POSIX 是 EACCES，Windows 是 EINVAL）。
  let badBin: string;

  beforeAll(async () => {
    await stopServer();
    // 上一组用例把模型删掉了，这里要的是"模型与 bin 都在，但 bin 跑不起来"
    fs.writeFileSync(modelPath, 'fake-model');
    badBin = path.join(dir, 'not-executable-cli');
    fs.writeFileSync(badBin, 'this is not a program\n', { mode: 0o644 });
    fs.chmodSync(badBin, 0o644);
    await startServer({ ZBOT_DATA_DIR: dir, ZBOT_WHISPER_BIN: badBin });
  });

  afterAll(async () => {
    await stopServer();
    try {
      fs.rmSync(badBin, { force: true });
    } catch {}
  });

  it('请求返回 500 且带原因，进程仍然存活', async () => {
    const audio = fs.readFileSync(sampleWav).toString('base64');
    const r = await post({ audio }, TOKEN);
    expect(r.status).toBe(500);
    expect(r.data.error).toContain('whisper 启动失败');
    // 关键：失败请求之后服务还必须能应答，否则整条语音链路随一次异常全挂
    const health = await get('/health');
    expect(health.status).toBe(200);
    const again = await post({ audio }, TOKEN);
    expect(again.status).toBe(500);
  });
});

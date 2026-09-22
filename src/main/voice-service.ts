import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { appendServerLog } from './config-store';

/**
 * STT/TTS 子进程生命周期管理（doc/优化方案/04 §7.1 + §5）
 * - 仅绑定 127.0.0.1，进程间共享一次性 token
 * - 健康检查失败或异常退出时指数退避重启（最多 3 次）
 * - 退出时 SIGTERM，5s 后 SIGKILL
 * - stdout/stderr 落入 ~/.z-bot/logs/{stt,tts}.log（5MB 轮转）
 */

export const STT_PORT = 8084;
export const TTS_PORT = 8086;

export interface VoiceServiceOptions {
  sttPort: number;
  ttsPort: number;
  serverDir: string;
  whisperModel?: string;
}

interface Managed {
  name: 'stt' | 'tts';
  script: string;
  port: number;
  proc: ChildProcess | null;
  restarts: number;
  healthy: boolean;
  consecutiveFailures: number;
  stopping: boolean;
}

const MAX_RESTARTS = 3;
const HEALTH_INTERVAL_MS = 30_000;

export class VoiceService {
  readonly authToken = crypto.randomBytes(32).toString('hex');
  private readonly services: Managed[];
  private healthTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: VoiceServiceOptions) {
    this.services = [
      { name: 'stt', script: path.join(opts.serverDir, 'stt.js'), port: opts.sttPort, proc: null, restarts: 0, healthy: false, consecutiveFailures: 0, stopping: false },
      { name: 'tts', script: path.join(opts.serverDir, 'tts.js'), port: opts.ttsPort, proc: null, restarts: 0, healthy: false, consecutiveFailures: 0, stopping: false },
    ];
  }

  sttBaseUrl = () => `http://127.0.0.1:${this.opts.sttPort}`;

  /** 运行期切换 whisper 模型：重启 STT 子进程生效（T4.9） */
  setWhisperModel(modelPath: string): void {
    if (this.opts.whisperModel === modelPath) return;
    this.opts.whisperModel = modelPath;
    const stt = this.services.find((s) => s.name === 'stt');
    if (!stt) return;
    stt.restarts = 0;
    if (stt.proc) {
      stt.stopping = true;
      stt.proc.kill('SIGTERM');
      stt.proc.once('close', () => {
        stt.stopping = false;
        this.spawnService(stt);
      });
    } else {
      this.spawnService(stt);
    }
  }
  ttsBaseUrl = () => `http://127.0.0.1:${this.opts.ttsPort}`;

  start(): void {
    this.stopped = false;
    for (const svc of this.services) this.spawnService(svc);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => this.checkAll(), HEALTH_INTERVAL_MS);
  }

  private spawnService(service: Managed): void {
    if (!fs.existsSync(service.script)) {
      console.warn(`[VoiceService] 脚本不存在，跳过 ${service.name}:`, service.script);
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 打包后 process.execPath 是 Electron 本体；不设这个就会拉起第二个 GUI 实例而不是 node
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(service.port),
      HOST: '127.0.0.1',
      ZBOT_AUTH_TOKEN: this.authToken,
    };
    if (service.name === 'stt' && this.opts.whisperModel) {
      env.ZBOT_WHISPER_MODEL = this.opts.whisperModel;
    }
    console.log(`[VoiceService] 启动 ${service.name} :${service.port}`);
    const proc = spawn(process.execPath, [service.script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    service.proc = proc;

    const pipe = (stream: NodeJS.ReadableStream, level: 'out' | 'err') => {
      stream.on('data', (data) => {
        const line = data.toString().trim();
        if (!line) return;
        appendServerLog(service.name, `[${level}] ${line}`);
        if (level === 'out') console.log(`[${service.name.toUpperCase()} Server]`, line);
        else console.error(`[${service.name.toUpperCase()} Server Error]`, line);
      });
    };
    if (proc.stdout) pipe(proc.stdout, 'out');
    if (proc.stderr) pipe(proc.stderr, 'err');

    proc.on('close', (code) => {
      service.proc = null;
      service.healthy = false;
      if (service.stopping || this.stopped) return;
      console.warn(`[VoiceService] ${service.name} 退出，code=${code}`);
      this.scheduleRestart(service);
    });
    proc.on('error', (e) => {
      console.error(`[VoiceService] ${service.name} 启动失败:`, e.message);
      service.proc = null;
    });
  }

  /** 指数退避：1s / 2s / 4s，超过 MAX_RESTARTS 次后不再重启 */
  private scheduleRestart(service: Managed): void {
    if (service.restarts >= MAX_RESTARTS) {
      console.error(`[VoiceService] ${service.name} 重启次数已达上限，放弃自动恢复`);
      return;
    }
    const delay = 1000 * Math.pow(2, service.restarts);
    service.restarts += 1;
    setTimeout(() => {
      if (this.stopped || service.stopping) return;
      this.spawnService(service);
    }, delay);
  }

  private checkAll(): void {
    for (const svc of this.services) {
      this.probe(svc).then((ok) => {
        if (ok) {
          svc.consecutiveFailures = 0;
          svc.healthy = true;
          svc.restarts = 0; // 恢复健康后重置退避预算
          return;
        }
        svc.healthy = false;
        svc.consecutiveFailures += 1;
        if (svc.consecutiveFailures >= 3 && !svc.proc) {
          svc.consecutiveFailures = 0;
          this.spawnService(svc);
        } else if (svc.consecutiveFailures >= 3 && svc.proc) {
          console.warn(`[VoiceService] ${svc.name} 连续健康检查失败，强制重启`);
          svc.consecutiveFailures = 0;
          svc.restarts = 0;
          svc.proc.kill('SIGTERM'); // close 回调里会自动重启
        }
      });
    }
  }

  private probe(svc: Managed): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: svc.port, path: '/health', timeout: 3000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const svc of this.services) {
      svc.stopping = true;
      const proc = svc.proc;
      if (!proc) continue;
      console.log(`[VoiceService] 关闭 ${svc.name}`);
      proc.kill('SIGTERM');
      const killer = setTimeout(() => {
        if (svc.proc) {
          console.warn(`[VoiceService] ${svc.name} 未响应 SIGTERM，强制结束`);
          svc.proc.kill('SIGKILL');
        }
      }, 5000);
      killer.unref?.();
      proc.once('close', () => clearTimeout(killer));
      svc.proc = null;
    }
  }

  status(): { name: string; port: number; healthy: boolean; restarts: number }[] {
    return this.services.map((s) => ({
      name: s.name,
      port: s.port,
      healthy: s.healthy,
      restarts: s.restarts,
    }));
  }
}

let instance: VoiceService | null = null;

/** 装配方创建后登记，供 IPC 处理器取用 token 与地址 */
export function setVoiceService(v: VoiceService | null): void {
  instance = v;
}

export function getVoiceService(): VoiceService | null {
  return instance;
}

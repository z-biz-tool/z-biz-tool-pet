import { app, safeStorage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 配置与状态的内存缓存 + 异步原子写入（doc/优化方案/04 §7.2，修复 D22/D23）
 * 以及 API 密钥的加密存储（§6.2，修复 H01/T4.10）
 */

// 测试与多实例隔离（doc/优化方案 06 §3.2）：ZBOT_DATA_DIR 覆盖默认的 ~/.z-bot
export const dataDir = process.env.ZBOT_DATA_DIR
  ? path.resolve(process.env.ZBOT_DATA_DIR)
  : path.join(app.getPath('home'), '.z-bot');
export const configFile = path.join(dataDir, 'config.json');
export const historyFile = path.join(dataDir, 'history.json');
export const petStatsFile = path.join(dataDir, 'pet_stats.json');
export const pinsFile = path.join(dataDir, 'pins.json');
const apiKeyFile = path.join(dataDir, 'api_key.enc');
const logDir = path.join(dataDir, 'logs');

export function ensureDataDir(): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

function writeAtomicSync(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, file); // rename 是原子操作，避免断电留下半截 JSON
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data, 'utf-8');
  await fs.promises.rename(tmp, file);
}

/** 每个文件一个实例：read() 命中内存缓存，write() 合并写入并落盘 */
export class JsonStore<T extends object> {
  private cached: T | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly defaults: T,
    private readonly normalize?: (raw: any) => T | null
  ) {}

  read(): T {
    if (this.cached === null) this.cached = this.loadFromDisk();
    return this.cached as T;
  }

  private loadFromDisk(): T {
    try {
      ensureDataDir();
      if (!fs.existsSync(this.file)) return this.cloneDefault();
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (this.normalize) {
        const normalized = this.normalize(parsed);
        if (normalized) return normalized;
      }
      if (Array.isArray(parsed)) return parsed as unknown as T;
      return { ...this.cloneDefault(), ...parsed };
    } catch (e: any) {
      console.error(`[ConfigStore] 读取 ${path.basename(this.file)} 失败:`, e.message);
      this.backupCorruptFile();
      return this.cloneDefault();
    }
  }

  private cloneDefault(): T {
    return (Array.isArray(this.defaults)
      ? [...(this.defaults as unknown as any[])]
      : { ...(this.defaults as any) }) as T;
  }

  private backupCorruptFile(): void {
    try {
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, `${this.file}.corrupt.${Date.now()}`);
      }
    } catch {
      // 备份失败不应阻断启动
    }
  }

  /** 全量替换（合并语义由调用方保证） */
  write(next: T): Promise<void> {
    this.cached = next;
    this.dirty = true;
    return this.flush();
  }

  patch(partial: Partial<T>): Promise<void> {
    return this.write({ ...this.read(), ...partial });
  }

  /** 写回磁盘；串行化避免同一文件并发 rename 竞争 */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const payload = JSON.stringify(this.cached, null, 2);
    this.writing = this.writing.then(() => writeAtomic(this.file, payload)).catch((e) => {
      this.dirty = true;
      console.error(`[ConfigStore] 写入 ${path.basename(this.file)} 失败:`, e.message);
    });
    return this.writing;
  }

  /** 高频变更下合并落盘，减少 IO */
  scheduleFlush(delayMs = 150): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }
}

// ---------- 密钥加密存储（T4.10） ----------

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 保存 API Key。
 * 平台支持时写入加密文件且 config.json 不再保留明文；
 * 不支持时（Linux 无 gnome-keyring）降级为 0600 权限文件，避免直接崩溃。
 */
export function saveApiKey(plain: string): { encrypted: boolean } {
  ensureDataDir();
  if (encryptionAvailable()) {
    fs.writeFileSync(apiKeyFile, safeStorage.encryptString(plain));
    try {
      fs.chmodSync(apiKeyFile, 0o600);
    } catch {}
    return { encrypted: true };
  }
  fs.writeFileSync(apiKeyFile, JSON.stringify({ plain }), 'utf-8');
  try {
    fs.chmodSync(apiKeyFile, 0o600);
  } catch {}
  return { encrypted: false };
}

export function loadApiKey(): string | null {
  try {
    if (!fs.existsSync(apiKeyFile)) return null;
    const buf = fs.readFileSync(apiKeyFile);
    if (encryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf);
      } catch {
        // 文件是降级格式或密钥环已变更
      }
    }
    const parsed = JSON.parse(buf.toString('utf-8'));
    return typeof parsed?.plain === 'string' ? parsed.plain : null;
  } catch (e: any) {
    console.error('[ConfigStore] 读取密钥失败:', e.message);
    return null;
  }
}

export function clearApiKey(): void {
  try {
    if (fs.existsSync(apiKeyFile)) fs.unlinkSync(apiKeyFile);
  } catch {}
}

/**
 * 旧版明文迁移：检测 config.json 里的 aiApiKey，加密落盘后从配置中剔除。
 * 返回是否发生了迁移。
 */
export function migratePlaintextApiKey(store: JsonStore<any>): boolean {
  const cfg = store.read();
  if (!cfg || typeof cfg.aiApiKey !== 'string' || !cfg.aiApiKey) return false;
  const existing = loadApiKey();
  if (!existing) saveApiKey(cfg.aiApiKey);
  const rest: any = { ...cfg };
  delete rest.aiApiKey; // 明文密钥不进新配置
  store.write(rest);
  console.log('[ConfigStore] 已将明文 aiApiKey 迁移到加密存储');
  return true;
}

/** 供运行时取用密钥：加密存储优先，回退到 config 字段 */
export function resolveApiKey(cfg: any): string {
  const stored = loadApiKey();
  if (stored) return stored;
  return typeof cfg?.aiApiKey === 'string' ? cfg.aiApiKey : '';
}

// ---------- 日志收集（04 §7.1） ----------

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function appendServerLog(name: 'stt' | 'tts', line: string): void {
  try {
    ensureDataDir();
    const file = path.join(logDir, `${name}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch {
    // 日志失败不影响主流程
  }
}

export { writeAtomic, writeAtomicSync };

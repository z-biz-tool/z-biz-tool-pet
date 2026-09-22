// 会议实时转录模块
// 通过 macOS 系统音频捕获 + 复用 STT 服务实现实时转录
// 并在会议结束时调用 AI 生成总结（要点 + 行动项）

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserWindow } from 'electron';
import { chat, getProviderFromConfig } from './ai-providers';
import type { ChatRequest } from './ai-providers';

export interface MeetingSegment {
  id: string;
  text: string;
  timestamp: string; // ISO 时间戳
  startMs: number; // 距离会议开始的毫秒数
}

export interface MeetingState {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  segments: MeetingSegment[];
  rollingSummary: string;
  finalSummary?: string;
  transcriptPath?: string;
  status: 'idle' | 'recording' | 'processing' | 'done' | 'error';
  error?: string;
}

let currentState: MeetingState = {
  id: '',
  title: '',
  startedAt: '',
  segments: [],
  rollingSummary: '',
  status: 'idle',
};

let sttProc: ReturnType<typeof spawn> | null = null;
let soxProc: ReturnType<typeof spawn> | null = null;
let chunkTimer: NodeJS.Timeout | null = null;
let sttAuthToken = '';
// 下一段转录的时间轴起点，随增量切块推进
let nextSegmentStartMs = 0;
// 主动结束（endMeeting/cancel）时 kill 捕获进程属正常，不能当成失败
let stoppingCapture = false;

/** 捕获进程在 recording 期间退出：立刻把会议置为 error 并停掉切片定时器 */
function failCapture(reason: string): void {
  if (stoppingCapture || currentState.status !== 'recording') return;
  console.error('[Meeting] 音频捕获失败:', reason);
  if (chunkTimer) {
    clearInterval(chunkTimer);
    chunkTimer = null;
  }
  soxProc = null;
  currentState.status = 'error';
  currentState.error = reason;
  broadcast('meeting:state', currentState);
}

const MEETINGS_DIR = path.join(os.homedir(), '.z-bot', 'meetings');

function ensureDir() {
  if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });
}

function broadcast(event: string, payload: any) {
  const allWindows = BrowserWindow.getAllWindows();
  for (const w of allWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send(event, payload);
    }
  }
}

/** 启动会议转录 */
export async function startMeeting(title: string, sttUrl: string, authToken = ''): Promise<MeetingState> {
  sttAuthToken = authToken;
  if (currentState.status === 'recording') {
    throw new Error('会议已在进行中');
  }

  ensureDir();
  resetChunkOffset();
  nextSegmentStartMs = 0;
  const id = `meeting_${Date.now()}`;
  currentState = {
    id,
    title: title || `会议 ${new Date().toLocaleString('zh-CN')}`,
    startedAt: new Date().toISOString(),
    segments: [],
    rollingSummary: '',
    status: 'recording',
  };

  // 启动系统音频捕获（macOS 用 sox，Windows 用 ffmpeg）
  const tmpWav = path.join(MEETINGS_DIR, `${id}.wav`);
  stoppingCapture = false;
  try {
    soxProc = spawnAudioCapture(tmpWav);
  } catch (e: any) {
    currentState.status = 'error';
    currentState.error = `无法启动音频捕获: ${e.message}。请安装 sox (brew install sox) 或 ffmpeg`;
    broadcast('meeting:state', currentState);
    throw e;
  }

  // spawn 只在同步失败时抛错；ffmpeg 动态库缺失、无录音权限等都是异步退出，
  // 之前没人监听，导致会议永远停在 recording 且 0 段（静默失败）
  let captureErr = '';
  soxProc.stderr?.on('data', (d) => {
    // 只留尾部会截掉 dyld 的标识前缀，因此检测用全文、展示用尾部
    if (captureErr.length < 4000) captureErr += d.toString();
  });
  soxProc.on('error', (e) => failCapture(`音频捕获进程异常: ${e.message}`));
  soxProc.on('close', (code) => {
    if (stoppingCapture || currentState.status !== 'recording') return;
    failCapture(
      `音频捕获进程意外退出 (code=${code})。` +
        (/Library not loaded|dyld/i.test(captureErr)
          ? ' ffmpeg 安装已损坏（动态库缺失），需重装 ffmpeg'
          : captureErr
            ? ' ' + captureErr.slice(-200).replace(/\s+/g, ' ')
            : ' 请检查麦克风/系统音频权限与 ffmpeg 是否可用')
    );
  });

  // 每 10 秒切一段 wav 发送到 STT 服务
  const chunkDurationMs = 10000;
  let currentChunkIndex = 0;
  chunkTimer = setInterval(async () => {
    currentChunkIndex++;
    const chunkPath = path.join(MEETINGS_DIR, `${id}_chunk_${currentChunkIndex}.wav`);
    const cut = await extractAudioChunk(tmpWav, chunkPath);
    if (!cut) return;
    nextSegmentStartMs = cut.startMs;
    if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 1000) {
      try {
        const text = await transcribeChunk(chunkPath, sttUrl, sttAuthToken);
        if (text && text.trim().length > 0) {
          addSegment(text.trim(), nextSegmentStartMs);
          // 触发滚动摘要
          updateRollingSummary().catch(() => {});
        }
      } catch (e: any) {
        console.error('[Meeting] 转录块失败:', e.message);
      }
    }
  }, chunkDurationMs);

  broadcast('meeting:state', currentState);
  return currentState;
}

/** 添加一个转录片段 */
function addSegment(text: string, audioStartMs?: number) {
  const now = Date.now();
  // 增量切块后，段落的起点应落在音频时间轴上；STT 返回有快有慢，用完成时刻会串位
  const startMs =
    typeof audioStartMs === 'number' && audioStartMs >= 0
      ? audioStartMs
      : now - new Date(currentState.startedAt).getTime();
  const segment: MeetingSegment = {
    id: `seg_${now}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    timestamp: new Date().toISOString(),
    startMs,
  };
  currentState.segments.push(segment);
  broadcast('meeting:segment', segment);
}

/** 更新滚动摘要（每分钟/每 5 个片段触发一次） */
async function updateRollingSummary() {
  if (currentState.segments.length === 0) return;
  if (currentState.segments.length % 5 !== 0) return; // 每 5 个片段更新一次

  // 加载 config + 构造 prompt
  const config = loadConfig();
  const provider = getProviderFromConfig(config);

  const recentText = currentState.segments
    .slice(-10)
    .map((s) => s.text)
    .join('\n');

  const prompt = `你是一个会议摘要助手。以下是最近的会议转录片段，请用 3-5 句话总结当前讨论的核心内容。如果之前已有摘要，请在此基础上增量更新。\n\n之前的摘要:\n${currentState.rollingSummary || '（暂无）'}\n\n最近的转录:\n${recentText}\n\n请输出新的累计摘要（中文，简洁）:`;

  try {
    const req: ChatRequest = {
      model: config.aiModel || config.modelName,
      messages: [
        { role: 'system', content: '你是会议摘要助手，输出简洁的中文摘要。' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    };
    const res = await chat(provider, req);
    currentState.rollingSummary = res.content;
    broadcast('meeting:rollingSummary', res.content);
  } catch (e: any) {
    console.error('[Meeting] 滚动摘要失败:', e.message);
  }
}

/** 结束会议并生成最终总结 */
export async function endMeeting(): Promise<MeetingState> {
  if (currentState.status !== 'recording') {
    return currentState;
  }
  currentState.status = 'processing';
  broadcast('meeting:state', currentState);

  // 停止音频捕获
  if (chunkTimer) {
    clearInterval(chunkTimer);
    chunkTimer = null;
  }
  stoppingCapture = true;
  if (soxProc) {
    try { soxProc.kill('SIGTERM'); } catch {}
    soxProc = null;
  }
  if (sttProc) {
    try { sttProc.kill('SIGTERM'); } catch {}
    sttProc = null;
  }

  currentState.endedAt = new Date().toISOString();

  if (currentState.segments.length === 0) {
    // 没有任何片段时总结毫无意义，之前仍会去调用 AI 并把 fetch 失败当"总结"回给用户
    currentState.status = 'error';
    currentState.error =
      currentState.error ||
      '本次会议没有转录到任何内容：音频捕获未取到数据，或 STT 服务不可用（检查 ffmpeg 与 whisper 模型）';
    broadcast('meeting:state', currentState);
    return currentState;
  }

  // 保存转录文本
  const transcriptPath = path.join(MEETINGS_DIR, `${currentState.id}.txt`);
  const transcript = currentState.segments
    .map((s) => {
      const m = Math.floor(s.startMs / 60000);
      const sec = Math.floor((s.startMs % 60000) / 1000);
      return `[${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}] ${s.text}`;
    })
    .join('\n\n');
  fs.writeFileSync(
    transcriptPath,
    `# ${currentState.title}\n时间: ${currentState.startedAt} - ${currentState.endedAt}\n\n${transcript}\n\n# 滚动摘要\n${currentState.rollingSummary}\n`,
    'utf-8'
  );
  currentState.transcriptPath = transcriptPath;

  // 调用 AI 生成最终总结（要点 + 行动项）
  try {
    const config = loadConfig();
    const provider = getProviderFromConfig(config);

    const prompt = `你是会议总结助手。请根据以下会议转录，输出结构化的最终总结：\n\n## 要点\n（用 3-6 条项目符号列出关键讨论点）\n\n## 行动项\n（用列表列出具体行动项和负责人，若没有明确负责人则写"待定"）\n\n会议转录:\n${transcript}`;

    const req: ChatRequest = {
      model: config.aiModel || config.modelName,
      messages: [
        { role: 'system', content: '你是会议总结助手。' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    };
    const res = await chat(provider, req);
    currentState.finalSummary = res.content;

    // 把最终总结追加到文件
    fs.appendFileSync(transcriptPath, `\n\n# 最终总结\n${res.content}\n`, 'utf-8');
  } catch (e: any) {
    console.error('[Meeting] 最终总结失败:', e.message);
    currentState.finalSummary = `总结生成失败: ${e.message}\n\n请查看完整转录: ${transcriptPath}`;
  }

  currentState.status = 'done';
  broadcast('meeting:state', currentState);
  return currentState;
}

/** 获取当前会议状态 */
export function getMeetingState(): MeetingState {
  return currentState;
}

/** 取消会议 */
export function cancelMeeting() {
  if (chunkTimer) {
    clearInterval(chunkTimer);
    chunkTimer = null;
  }
  if (soxProc) {
    try { soxProc.kill('SIGTERM'); } catch {}
    soxProc = null;
  }
  currentState = {
    id: '',
    title: '',
    startedAt: '',
    segments: [],
    rollingSummary: '',
    status: 'idle',
  };
  broadcast('meeting:state', currentState);
}

// ---------- 音频捕获辅助函数 ----------

function spawnAudioCapture(outPath: string): ReturnType<typeof spawn> {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: 用 sox 通过 BlackHole 等虚拟设备，或 ffmpeg 捕获系统音频
    // 优先尝试 ffmpeg avfoundation
    return spawn('ffmpeg', [
      '-f', 'avfoundation',
      '-i', ':0', // 默认音频设备
      '-ac', '1',
      '-ar', '16000',
      '-y',
      outPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (platform === 'win32') {
    return spawn('ffmpeg', [
      '-f', 'dshow',
      '-i', 'audio=virtual-audio-capturer',
      '-ac', '1',
      '-ar', '16000',
      '-y',
      outPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // linux: pulseaudio monitor
    return spawn('ffmpeg', [
      '-f', 'pulse',
      '-i', 'default',
      '-ac', '1',
      '-ar', '16000',
      '-y',
      outPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

export interface WavInfo {
  /** data 块在文件中的起始字节 */
  dataOffset: number;
  byteRate: number;
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
}

/** 解析 RIFF/WAVE 头，容忍 fmt 之后还有 LIST 等块 */
export function parseWavHeader(buf: Buffer): WavInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = 0;
  let bitsPerSample = 16;
  let channels = 1;
  let sampleRate = 16000;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      return {
        dataOffset: body,
        byteRate: byteRate || (sampleRate * channels * (bitsPerSample / 8)),
        bitsPerSample,
        channels,
        sampleRate,
      };
    }
    if (size <= 0) break;
    pos = body + size + (size % 2); // RIFF 块按偶数字节对齐
  }
  return null;
}

function buildWavHeader(pcmLength: number, info: WavInfo): Buffer {
  const byteRate = info.byteRate || info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const blockAlign = Math.max(1, Math.round((info.bitsPerSample / 8) * info.channels));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcmLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(info.channels, 22);
  h.writeUInt32LE(info.sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(info.bitsPerSample, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcmLength, 40);
  return h;
}

/**
 * 只切出"上次到现在"的 PCM 增量（D19）。
 * 旧实现每 10 秒 copyFileSync 整份 wav，第 N 块里重复了前 N-1 块的全部内容，
 * 既让 whisper 反复重转录同一批音频（O(n^2)），也让转录文本出现整段重复。
 */
let chunkByteOffset = 0;

export function resetChunkOffset(): void {
  chunkByteOffset = 0;
}

/** 返回本次写出的 chunk 信息；没有新音频时返回 null */
export async function extractAudioChunk(
  src: string,
  dst: string,
  _durationMs?: number
): Promise<{ bytes: number; startMs: number } | null> {
  try {
    if (!fs.existsSync(src)) return null;
    const size = fs.statSync(src).size;

    const head = Buffer.alloc(Math.min(4096, size));
    const fd = fs.openSync(src, 'r');
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    const info = parseWavHeader(head);
    if (!info) {
      console.warn('[Meeting] 录制文件头不可解析，跳过本次切块（不做整份复制以免重复转录）');
      return null;
    }

    const available = size - info.dataOffset;
    if (available <= chunkByteOffset) return null;

    let take = available - chunkByteOffset;
    // 对齐到采样边界，避免切出半个采样点
    const frame = Math.max(1, Math.round((info.bitsPerSample / 8) * info.channels));
    take -= take % frame;
    if (take <= 0) return null;

    const slice = Buffer.alloc(take);
    const fd2 = fs.openSync(src, 'r');
    try {
      fs.readSync(fd2, slice, 0, take, info.dataOffset + chunkByteOffset);
    } finally {
      fs.closeSync(fd2);
    }

    fs.writeFileSync(dst, Buffer.concat([buildWavHeader(take, info), slice]));
    const startMs = Math.round((chunkByteOffset / info.byteRate) * 1000);
    chunkByteOffset += take;
    return { bytes: take, startMs };
  } catch (e: any) {
    console.error('[Meeting] 切块失败:', e.message);
    return null;
  }
}

/** 调用本地 STT 服务转录一个 wav 文件 */
async function transcribeChunk(wavPath: string, sttUrl: string, authToken?: string): Promise<string> {
  const buffer = fs.readFileSync(wavPath);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    // 路由与 body 对齐 server/stt.js：此前打的是不存在的 /inference（修复 D10 必 404）
    const res = await fetch(`${sttUrl}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'x-auth-token': authToken } : {}),
      },
      body: JSON.stringify({ audio: buffer.toString('base64') }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`STT 返回 ${res.status}`);
    const data: any = await res.json();
    return data.text || data.transcription || '';
  } finally {
    clearTimeout(timeout);
  }
}

function loadConfig(): any {
  try {
    const cfgPath = path.join(os.homedir(), '.z-bot', 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    }
  } catch {}
  return {};
}

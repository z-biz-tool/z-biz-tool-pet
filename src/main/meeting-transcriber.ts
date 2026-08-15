// 会议实时转录模块
// 通过 macOS 系统音频捕获 + 复用 STT 服务实现实时转录
// 并在会议结束时调用 AI 生成总结（要点 + 行动项）

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
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
let chunkCounter = 0;

const MEETINGS_DIR = path.join(os.homedir(), '.z-bot', 'meetings');

function ensureDir() {
  if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });
}

function emit(event: string, payload: any, win?: BrowserWindow | null) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(event, payload);
  }
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
export async function startMeeting(title: string, sttUrl: string): Promise<MeetingState> {
  if (currentState.status === 'recording') {
    throw new Error('会议已在进行中');
  }

  ensureDir();
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
  try {
    soxProc = spawnAudioCapture(tmpWav);
  } catch (e: any) {
    currentState.status = 'error';
    currentState.error = `无法启动音频捕获: ${e.message}。请安装 sox (brew install sox) 或 ffmpeg`;
    broadcast('meeting:state', currentState);
    throw e;
  }

  // 每 10 秒切一段 wav 发送到 STT 服务
  const chunkDurationMs = 10000;
  let currentChunkIndex = 0;
  chunkTimer = setInterval(async () => {
    currentChunkIndex++;
    const chunkPath = path.join(MEETINGS_DIR, `${id}_chunk_${currentChunkIndex}.wav`);
    await extractAudioChunk(tmpWav, chunkPath, chunkDurationMs * currentChunkIndex);
    if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 1000) {
      try {
        const text = await transcribeChunk(chunkPath, sttUrl);
        if (text && text.trim().length > 0) {
          addSegment(text.trim());
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
function addSegment(text: string) {
  const now = Date.now();
  const startMs = now - new Date(currentState.startedAt).getTime();
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
  if (soxProc) {
    try { soxProc.kill('SIGTERM'); } catch {}
    soxProc = null;
  }
  if (sttProc) {
    try { sttProc.kill('SIGTERM'); } catch {}
    sttProc = null;
  }

  currentState.endedAt = new Date().toISOString();

  // 保存转录文本
  const transcriptPath = path.join(MEETINGS_DIR, `${currentState.id}.txt`);
  const transcript = currentState.segments
    .map((s, idx) => {
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

/** 从持续录制的 wav 中切出最近一段（简化版：每次重写整个 wav） */
async function extractAudioChunk(_src: string, _dst: string, _durationMs: number) {
  // 简化: 由于 ffmpeg 持续写入一个 wav，我们每 10 秒复制一份作为 chunk
  // 这里实际是直接读 _src 的最新内容复制到 _dst
  // 为简化逻辑，实际实现需要 ffmpeg 输出分段 wav，本版本用单 wav 持续录制
  // 每 10 秒复制当前 wav 到 chunk 文件，发送给 STT
  try {
    const src = path.join(MEETINGS_DIR, `${currentState.id}.wav`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, _dst);
    }
  } catch (e: any) {
    console.error('[Meeting] 切块失败:', e.message);
  }
}

/** 调用本地 STT 服务转录一个 wav 文件 */
async function transcribeChunk(wavPath: string, sttUrl: string): Promise<string> {
  const buffer = fs.readFileSync(wavPath);
  const formBoundary = '----meeting' + Date.now();
  const payload = Buffer.concat([
    Buffer.from(`--${formBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="chunk.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${formBoundary}--\r\n`),
  ]);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${sttUrl}/inference`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${formBoundary}` },
      body: payload,
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

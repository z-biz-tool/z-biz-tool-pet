const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: false }));
app.use(express.json({ limit: '50mb' }));

// ---------- 仅本机访问 + 一次性 token 鉴权（T2.4） ----------
const PORT = Number(process.env.PORT || 8084);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.ZBOT_AUTH_TOKEN || '';

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!TOKEN || req.headers['x-auth-token'] !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ---------- whisper 模型可配置（T2.2 / T2.3） ----------
// 与 src/main/config-store.ts 保持一致：ZBOT_DATA_DIR 优先（测试隔离）
const BASE_DIR = process.env.ZBOT_DATA_DIR || path.join(os.homedir(), '.z-bot');
const DEFAULT_MODEL = path.join(BASE_DIR, 'models', 'ggml-base.bin');
const MODEL_PATH = process.env.ZBOT_WHISPER_MODEL || DEFAULT_MODEL;
function resolveWhisperBin() {
  if (process.env.ZBOT_WHISPER_BIN) return process.env.ZBOT_WHISPER_BIN;
  // 开发态随仓库走；打包后 Resources 内不放二进制，回退到 PATH 上的安装
  const bundled = path.join(__dirname, '../whisper.cpp/build/bin/whisper-cli');
  if (fs.existsSync(bundled)) return bundled;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, 'whisper-cli');
    if (fs.existsSync(p)) return p;
  }
  return bundled;
}

const WHISPER_BIN = resolveWhisperBin();

function missingWhisper() {
  if (!fs.existsSync(WHISPER_BIN)) {
    return `whisper-cli 未找到: ${WHISPER_BIN}（可用 ZBOT_WHISPER_BIN 指定）`;
  }
  if (!fs.existsSync(MODEL_PATH)) {
    return `whisper 模型未找到: ${MODEL_PATH}，请参考 whisper.cpp/README.md 下载模型`;
  }
  return null;
}

// ---------- 临时文件隔离在私有目录，处理完即删（T1.8，修复 D07） ----------
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-stt-'));
const liveFiles = new Set();

function tmpPath(ext) {
  const p = path.join(workDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  liveFiles.add(p);
  return p;
}

function cleanup(file) {
  liveFiles.delete(file);
  try {
    fs.unlinkSync(file);
  } catch {}
}

function cleanupAll() {
  for (const f of liveFiles) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  try {
    fs.rmdirSync(workDir);
  } catch {}
}

process.on('exit', cleanupAll);
process.on('SIGINT', () => {
  cleanupAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(0);
});

app.get('/health', (req, res) => {
  const problem = missingWhisper();
  res.json({ ok: !problem, service: 'stt', model: MODEL_PATH, bin: WHISPER_BIN, problem: problem || undefined });
});

app.post('/transcribe', (req, res) => {
  const { audio } = req.body;

  if (!audio) {
    return res.status(400).json({ error: 'No audio provided' });
  }
  const problem = missingWhisper();
  if (problem) {
    return res.status(503).json({ error: problem });
  }

  console.log('[STT] Audio base64 length:', audio.length);

  let buffer;
  try {
    buffer = Buffer.from(audio, 'base64');
  } catch (e) {
    return res.status(400).json({ error: `音频 base64 解码失败: ${e.message}` });
  }
  if (!buffer.length) {
    return res.status(400).json({ error: '音频为空' });
  }

  const tempWav = tmpPath('.wav');

  // 会议转录的每个分块本身就是 16k 单声道 wav，再转一次码纯属浪费
  if (isWav(buffer)) {
    try {
      fs.writeFileSync(tempWav, buffer);
    } catch (e) {
      cleanup(tempWav);
      return res.status(500).json({ error: `写入临时文件失败: ${e.message}` });
    }
    return runWhisper(tempWav, res, 'wav-passthrough');
  }

  const tempWebm = tmpPath('.webm');
  try {
    fs.writeFileSync(tempWebm, buffer);
  } catch (e) {
    cleanup(tempWebm);
    cleanup(tempWav);
    return res.status(500).json({ error: `写入临时文件失败: ${e.message}` });
  }

  // Convert webm to wav using ffmpeg
  const ffmpeg = spawn('ffmpeg', ['-i', tempWebm, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tempWav, '-y']);

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (data) => {
    ffmpegError += data.toString();
  });

  ffmpeg.on('error', (e) => {
    cleanup(tempWebm);
    cleanup(tempWav);
    res.status(500).json({ error: 'ffmpeg 不可用，无法转换音频', details: e.message });
  });

  ffmpeg.on('close', (code) => {
    // 转换完成，源 webm 不再需要
    cleanup(tempWebm);

    if (code !== 0) {
      console.error('[STT] ffmpeg error:', ffmpegError);
      cleanup(tempWav);
      // webm 必须靠 ffmpeg 转成 16k wav；坏掉/缺失时给出可定位的原因而不是 'Conversion failed'
      const hint = /Library not loaded|dyld/i.test(ffmpegError)
        ? 'ffmpeg 安装已损坏（动态库缺失），需重装 ffmpeg，否则语音输入与会议转录不可用'
        : 'ffmpeg 转码失败';
      return res.status(503).json({ error: hint, details: ffmpegError.slice(-300) });
    }

    runWhisper(tempWav, res, 'ffmpeg');
  });
});

function isWav(buffer) {
  return (
    buffer.length > 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WAVE'
  );
}

/** webm（需转码）与 wav（直通）共用同一次 whisper 调用 */
function runWhisper(wavPath, res, via) {
  const args = [
    '-m', MODEL_PATH,
    '-f', wavPath,
    '-l', 'auto',
    '--no-timestamps',
    '-pp',
    '-nt',          // no timestamps
    '-dt', '30000', // duration 30s
  ];

  console.log(`[STT] Running whisper (${via})...`);
  const whisper = spawn(WHISPER_BIN, args);
  let output = '';
  let whisperError = '';

  whisper.stdout.on('data', (data) => {
    output += data.toString();
  });
  whisper.stderr.on('data', (data) => {
    whisperError += data.toString();
  });
  whisper.on('error', (e) => {
    cleanup(wavPath);
    if (!res.headersSent) res.status(500).json({ error: 'whisper 启动失败', details: e.message });
  });
  whisper.on('close', (code) => {
    cleanup(wavPath);
    if (code !== 0) {
      console.error('[STT] Whisper error:', whisperError);
      return res.status(500).json({ error: 'Transcription failed', details: whisperError });
    }
    const text = output.trim();
    console.log('[STT] Result:', text || '(empty)');
    res.json({ text, via });
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[STT Server] Running on http://${HOST}:${PORT}`);
});

module.exports = { app, server, workDir };

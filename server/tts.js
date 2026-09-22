const express = require('express');
const cors = require('cors');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

/**
 * 本地 TTS：不再调用微软 edge-tts 云端服务（T2.1，修复 D06 语音文本外泄）
 * - macOS: 系统内置 `say`
 * - Windows: PowerShell + System.Speech
 * - Linux: espeak-ng / festival（存在则用）
 * 合成的音频始终落在本地私有临时目录，响应后立即删除。
 */

const app = express();
app.use(cors({ origin: false }));
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT || 8086);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.ZBOT_AUTH_TOKEN || '';

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!TOKEN || req.headers['x-auth-token'] !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-tts-'));
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

function hasBinary(bin) {
  const probe = spawnSync(bin, ['--help'], { timeout: 3000 });
  return !probe.error;
}

function engineAvailable() {
  if (process.platform === 'darwin') return hasBinary('say');
  if (process.platform === 'win32') return hasBinary('powershell');
  return hasBinary('espeak-ng') || hasBinary('festival');
}

// 中文可用音色（macOS）；找不到时回退默认音色
const ZH_VOICES = ['Ting-Ting', 'Mei-Jia', 'Sin-ji'];

function pickMacVoice(requested) {
  if (requested) return requested;
  try {
    const out = spawnSync('say', ['-v', '?'], { timeout: 5000 }).stdout.toString();
    const found = ZH_VOICES.find((v) => out.includes(v));
    if (found) return found;
  } catch {}
  return null;
}

/** 用 ffmpeg 把引擎产物统一转成 mp3；ffmpeg 不可用则原样返回 */
function toMp3(src, dst) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-i', src, '-codec:a', 'libmp3lame', '-q:a', '4', dst, '-y']);
    let err = '';
    ff.stderr.on('data', (d) => (err += d.toString()));
    ff.on('error', () => resolve({ ok: false, reason: 'ffmpeg 不可用' }));
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(dst)) resolve({ ok: true });
      else resolve({ ok: false, reason: err.slice(0, 200) || `ffmpeg exit ${code}` });
    });
  });
}

function synthesizeMac(text, voice, outAiff) {
  return new Promise((resolve, reject) => {
    const args = ['-o', outAiff];
    const picked = pickMacVoice(voice);
    if (picked) args.unshift('-v', picked);
    args.push(text);
    const say = spawn('say', args);
    let err = '';
    say.stderr.on('data', (d) => (err += d.toString()));
    say.on('error', reject);
    say.on('close', (code) => {
      if (code === 0 && fs.existsSync(outAiff)) resolve();
      else reject(new Error(err || `say 退出码 ${code}`));
    });
  });
}

function synthesizeWindows(text, outFile) {
  // 文本走 UTF-8 临时文件，不再用 stdin：[Console]::In.ReadToEnd() 在
  // -NonInteractive + 管道 stdin 下会读到空串，PowerShell 于是"成功"退出并留下
  // 一个只有头的 wav（实测 64 B），上层把静音当成合成成功播了出去。
  const textFile = tmpPath('.txt');
  fs.writeFileSync(textFile, text, 'utf-8');
  const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
  return new Promise((resolve, reject) => {
    const ps = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.SetOutputToWaveFile(${q(outFile)})`,
      `$t = Get-Content -Raw -Encoding UTF8 ${q(textFile)}`,
      'if ([string]::IsNullOrWhiteSpace($t)) { throw "文本读取为空" }',
      '$s.Speak($t)',
      '$s.Dispose()',
    ].join('\n');
    const powershell = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let err = '';
    powershell.stderr.on('data', (d) => (err += d.toString()));
    powershell.on('error', (e) => {
      cleanup(textFile);
      reject(e);
    });
    powershell.on('close', (code) => {
      cleanup(textFile);
      let size = 0;
      try {
        size = fs.statSync(outFile).size;
      } catch {}
      // 44 B 是空 wav 头；阈值留够余量，宁肯报错也不回一段静音
      if (code === 0 && size > 1000) resolve();
      else reject(new Error(`powershell 退出码 ${code}，产出 ${size} B${err ? '：' + err.slice(-300) : ''}`));
    });
  });
}

function synthesizeLinux(text, outFile) {
  const bin = hasBinary('espeak-ng') ? 'espeak-ng' : 'festival';
  return new Promise((resolve, reject) => {
    const child =
      bin === 'espeak-ng'
        ? spawn(bin, ['-w', outFile, text])
        : spawn(bin, ['--tts', '--output', outFile]);
    let err = '';
    if (bin === 'festival') {
      child.stdin.write(text);
      child.stdin.end();
    }
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outFile)) resolve();
      else reject(new Error(err || `${bin} 退出码 ${code}`));
    });
  });
}

app.get('/health', (req, res) => {
  const ok = engineAvailable();
  res.json({
    ok,
    service: 'tts',
    engine: process.platform,
    problem: ok ? undefined : '本机未找到可用的离线语音合成引擎',
  });
});

app.post('/speak', async (req, res) => {
  const { text, voice } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'No text provided' });
  }
  if (!engineAvailable()) {
    return res.status(503).json({ error: `当前平台(${process.platform})无可用离线 TTS 引擎` });
  }

  const clipped = String(text).slice(0, 2000);
  console.log('[TTS] Speaking:', clipped.slice(0, 50));

  const rawOut = tmpPath(process.platform === 'darwin' ? '.aiff' : '.wav');
  const mp3Out = tmpPath('.mp3');

  try {
    if (process.platform === 'darwin') await synthesizeMac(clipped, voice, rawOut);
    else if (process.platform === 'win32') await synthesizeWindows(clipped, rawOut);
    else await synthesizeLinux(clipped, rawOut);
  } catch (e) {
    console.error('[TTS] Error:', e.message);
    cleanup(rawOut);
    cleanup(mp3Out);
    return res.status(500).json({ error: 'TTS failed', details: e.message });
  }

  const converted = await toMp3(rawOut, mp3Out);
  const fileToSend = converted.ok ? mp3Out : rawOut;
  const format = converted.ok ? 'mp3' : process.platform === 'darwin' ? 'aiff' : 'wav';

  try {
    const audioData = fs.readFileSync(fileToSend);
    res.json({ audio: audioData.toString('base64'), format });
  } catch (e) {
    console.error('[TTS] Read error:', e);
    res.status(500).json({ error: 'Failed to read audio' });
  } finally {
    cleanup(rawOut);
    cleanup(mp3Out);
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[TTS Server] Running on http://${HOST}:${PORT} (local engine: ${process.platform})`);
});

module.exports = { app, server, workDir };

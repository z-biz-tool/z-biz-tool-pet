const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const WHISPER_BIN = path.join(__dirname, '../whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = path.join(__dirname, '../whisper.cpp/models/for-tests-ggml-tiny.bin');

app.post('/transcribe', (req, res) => {
  const { audio } = req.body;

  if (!audio) {
    return res.status(400).json({ error: 'No audio provided' });
  }

  console.log('[STT] Audio base64 length:', audio.length);

  // Save webm audio to temp file
  const tempWebm = path.join(__dirname, 'temp_audio.webm');
  const tempWav = path.join(__dirname, 'temp_audio.wav');
  const buffer = Buffer.from(audio, 'base64');
  fs.writeFileSync(tempWebm, buffer);
  console.log('[STT] Saved webm file, size:', buffer.length, 'bytes');

  // Convert webm to wav using ffmpeg
  console.log('[STT] Converting to wav...');
  const ffmpeg = spawn('ffmpeg', ['-i', tempWebm, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tempWav, '-y']);

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (data) => {
    ffmpegError += data.toString();
  });

  ffmpeg.on('close', (code) => {
    // Check wav file
    try {
      const wavStats = fs.statSync(tempWav);
      console.log('[STT] Wav file size:', wavStats.size, 'bytes');
    } catch (e) {
      console.log('[STT] Wav file not found');
    }

    // Keep webm for debugging
    // try { fs.unlinkSync(tempWebm); } catch (e) {}

    if (code !== 0) {
      console.error('[STT] ffmpeg error:', ffmpegError);
      return res.status(500).json({ error: 'Conversion failed' });
    }

    console.log('[STT] Running whisper...');
    const args = [
      '-m', MODEL_PATH,
      '-f', tempWav,
      '-l', 'auto',
      '--no-timestamps',
      '-pp',
      '-nt',  // no timestamps
      '-dt', '30000'  // duration 30s
    ];

    const whisper = spawn(WHISPER_BIN, args);
    let output = '';
    let whisperError = '';

    whisper.stdout.on('data', (data) => {
      output += data.toString();
    });

    whisper.stderr.on('data', (data) => {
      whisperError += data.toString();
    });

    whisper.on('close', (code) => {
      // Clean up wav
      try { fs.unlinkSync(tempWav); } catch (e) {}

      if (code !== 0) {
        console.error('[STT] Whisper error:', whisperError);
        return res.status(500).json({ error: 'Transcription failed', details: whisperError });
      }

      const text = output.trim();
      console.log('[STT] Result:', text || '(empty)');
      res.json({ text });
    });
  });
});

const PORT = 8083;
app.listen(PORT, () => {
  console.log(`[STT Server] Running on http://localhost:${PORT}`);
});
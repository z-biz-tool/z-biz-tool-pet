const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/speak', async (req, res) => {
  const { text, voice } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'No text provided' });
  }

  console.log('[TTS] Speaking:', text.slice(0, 50));

  // Create temp file for audio
  const tempPath = path.join(__dirname, 'temp_speech.mp3');

  // Use edge-tts to generate speech
  const python = spawn('python3', [
    '-c',
    `
import asyncio
import edge_tts
import base64

async def speak():
    communicate = edge_tts.Communicator("${text.replace(/"/g, '\\"')}", "zh-CN-XiaoxiaoNeural")
    await communicate.save("${tempPath}")
    print("done")

asyncio.run(speak())
`
  ]);

  let error = '';
  python.stderr.on('data', (data) => {
    error += data.toString();
  });

  python.on('close', (code) => {
    if (code !== 0) {
      console.error('[TTS] Error:', error);
      return res.status(500).json({ error: 'TTS failed' });
    }

    try {
      const audioData = fs.readFileSync(tempPath);
      const base64Audio = audioData.toString('base64');
      fs.unlinkSync(tempPath);
      res.json({ audio: base64Audio, format: 'mp3' });
    } catch (e) {
      console.error('[TTS] Read error:', e);
      res.status(500).json({ error: 'Failed to read audio' });
    }
  });
});

const PORT = 8085;
app.listen(PORT, () => {
  console.log(`[TTS Server] Running on http://localhost:${PORT}`);
});
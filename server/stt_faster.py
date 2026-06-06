#!/usr/bin/env python3
from flask import Flask, request, jsonify
from flask_cors import CORS
from faster_whisper import WhisperModel
import os
import base64
import tempfile
import io

app = Flask(__name__)
CORS(app)

print("[STT] Loading model...")
model = WhisperModel("tiny", device="cpu", compute_type="int8")
print("[STT] Model loaded!")

@app.route('/transcribe', methods=['POST'])
def transcribe():
    data = request.json
    audio_base64 = data.get('audio', '')

    if not audio_base64:
        return jsonify({'error': 'No audio provided'}), 400

    # Decode base64 to audio
    try:
        audio_data = base64.b64decode(audio_base64)
    except Exception as e:
        return jsonify({'error': f'Invalid base64: {e}'}), 400

    print(f"[STT] Processing {len(audio_data)} bytes...")

    # Try to transcribe directly (faster-whisper supports webm via av)
    try:
        segments, info = model.transcribe(io.BytesIO(audio_data), language="zh")
        text = ' '.join([seg.text for seg in segments])
        print(f"[STT] Result: {text or '(empty)'}")
        return jsonify({'text': text})
    except Exception as e:
        print(f"[STT] Direct transcribe failed: {e}")

        # Fallback: try converting with ffmpeg
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
            f.write(audio_data)
            webm_path = f.name

        wav_path = webm_path.replace('.webm', '.wav')
        result = os.system(f'ffmpeg -i {webm_path} -ar 16000 -ac 1 -c:a pcm_s16le {wav_path} -y 2>&1 >/dev/null')

        try:
            if os.path.exists(wav_path):
                segments, info = model.transcribe(wav_path, language="zh")
                text = ' '.join([seg.text for seg in segments])
                print(f"[STT] Result (via wav): {text or '(empty)'}")
                return jsonify({'text': text})
            else:
                print(f"[STT] ffmpeg failed with code {result}")
                return jsonify({'error': 'Conversion failed'}), 500
        except Exception as e2:
            print(f"[STT] Error: {e2}")
            return jsonify({'error': str(e2)}), 500
        finally:
            try:
                os.unlink(webm_path)
                os.unlink(wav_path)
            except:
                pass

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8084)
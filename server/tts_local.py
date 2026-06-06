#!/usr/bin/env python3
from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import base64

app = Flask(__name__)
CORS(app)

# 可选声音: Tingting (女声), Meijia (女声), Yunxi (男声)
VOICE = "Tingting"

@app.route('/speak', methods=['POST'])
def speak():
    data = request.json
    text = data.get('text', '')

    if not text:
        return jsonify({'error': 'No text provided'}), 400

    print(f"[TTS] Speaking with {VOICE}: {text[:30]}...")

    # Use macOS say command
    os.system(f'say -o /tmp/speech.aiff -v "{VOICE}" "{text}"')
    os.system(f'ffmpeg -i /tmp/speech.aiff -ar 16000 -ac 1 /tmp/speech.wav -y 2>/dev/null')

    try:
        with open('/tmp/speech.wav', 'rb') as f:
            audio_data = f.read()
        os.remove('/tmp/speech.aiff')
        os.remove('/tmp/speech.wav')

        audio_base64 = base64.b64encode(audio_data).decode()
        return jsonify({'audio': audio_base64, 'format': 'wav'})
    except Exception as e:
        print(f"[TTS] Error: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8086)
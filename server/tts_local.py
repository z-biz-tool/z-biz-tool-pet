import asyncio
import edge_tts
import sys
import os

async def speak():
    text = sys.stdin.read().strip()
    output_path = sys.argv[1] if len(sys.argv) > 1 else "temp_speech.mp3"
    
    if not text:
        print("error: no text provided", file=sys.stderr)
        sys.exit(1)
    
    try:
        communicate = edge_tts.Communicator(text, "zh-CN-XiaoxiaoNeural")
        await communicate.save(output_path)
        print("done")
    except Exception as e:
        print(f"error: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(speak())

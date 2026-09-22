#!/usr/bin/env bash
# 下载 whisper.cpp 的 GGML 模型到 ~/.z-bot/models/（doc/优化方案 T2.2）
# 模型不进 git 仓库，只在这里按需拉取。
set -euo pipefail

MODEL="${1:-base}"
DEST_DIR="${ZBOT_MODEL_DIR:-$HOME/.z-bot/models}"
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

case "$MODEL" in
  tiny|base|small|medium|large-v3) FILE="ggml-${MODEL}.bin" ;;
  *) echo "未知模型: $MODEL（可选 tiny/base/small/medium/large-v3）" >&2; exit 1 ;;
esac

mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/$FILE"

if [[ -s "$DEST" ]]; then
  echo "[model] 已存在: $DEST"
  exit 0
fi

echo "[model] 下载 $BASE_URL/$FILE -> $DEST"
curl -fL --retry 3 --progress-bar -o "$DEST.part" "$BASE_URL/$FILE"
mv "$DEST.part" "$DEST"   # 下完再改名，避免半截模型被当成可用
echo "[model] 完成: $DEST ($(du -h "$DEST" | cut -f1))"
echo "[model] 如非默认 base，请设置 ZBOT_WHISPER_MODEL=$DEST"

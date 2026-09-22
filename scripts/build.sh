#!/usr/bin/env bash
# 一键构建：主进程 + preload + 渲染层产物，并校验产物齐全（doc/优化方案 T5.2）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[build] typecheck main"
npx tsc -p tsconfig.main.json

echo "[build] typecheck preload"
npx tsc -p tsconfig.preload.json

echo "[build] bundle renderer"
npx vite build

for f in dist/main/index.js dist/preload/index.js dist/renderer/pet/index.html dist/renderer/admin/index.html; do
  if [[ ! -f "$f" ]]; then
    echo "[build] 缺少产物: $f" >&2
    exit 1
  fi
done

echo "[build] 产物:"
du -sh dist/main dist/preload dist/renderer | sed 's/^/  /'

if [[ "${WITH_INSTALLER:-0}" == "1" ]]; then
  case "$(uname -s)" in
    Darwin) npx electron-builder --mac ;;
    *) npx electron-builder --win ;;
  esac
fi

echo "[build] 完成"

#!/usr/bin/env bash
# macOS 构建脚本：.app + .dmg
#
# 为什么需要这个脚本
# ------------------
# `tauri build` 内部调用 tauri-bundler 生成的 bundle_dmg.sh，其中有两处在受限
# shell 环境下会失败（tauri-cli 2.12.4 仍未修）：
#
#   1. find_mount_dir 用 `grep -E "${dev_name}"` 把 "/dev/disk4s" 当正则。设备名
#      恰好不含正则元字符时 BSD grep 能容忍，但 toybox grep 会直接报
#      "bad regex ... brackets not balanced"，导致找不到中间盘、构建中断。
#   2. 用 AppleScript 美化 Finder 窗口（背景图/图标排布）。在无法控制 Finder
#      的环境里会报 "A privilege violation occurred (-10004)"。
#
# 两处都只影响 DMG 的"外壳"，不影响 .app 内容。本项目的 tauri.conf.json 没有配置
# 任何 dmg 布局（无背景图、无图标定位），所以 --skip-jenkins 跳过 Finder 美化
# 不会损失任何实质产物。
#
# 策略：先按正常方式构建；若 DMG 没出来，再用干净 PATH + --skip-jenkins 兜底。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

APP_GLOB="src-tauri/target/release/bundle/macos/*.app"
DMG_DIR="src-tauri/target/release/bundle/dmg"
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(rustc -vV 2>/dev/null | awk '/^host: /{print $2}' | cut -d- -f1)"
# 用版本+架构拼出期望的 DMG 名，只认这个文件 —— 目录里可能躺着上一版的包，
# 拿 ls -t 挑最新的会把陈旧产物误报成本次构建成功。
EXPECTED_DMG="$DMG_DIR/z-biz-tool-pet_${VERSION}_${ARCH}.dmg"

echo "==> tauri build"
node_modules/.bin/tauri build
BUILD_STATUS=$?

if [ $BUILD_STATUS -ne 0 ]; then
    echo "==> tauri build returned ${BUILD_STATUS} (DMG step may have failed)"
fi

if [ -f "$EXPECTED_DMG" ]; then
    echo "==> DMG 已就绪：$EXPECTED_DMG"
    ls -lh "$EXPECTED_DMG"
    exit 0
fi

APP=$(ls -d $APP_GLOB 2>/dev/null | head -1)
if [ -z "$APP" ]; then
    echo "==> 失败：连 .app 都没产出，上游构建有问题，不能兜底。" >&2
    exit 1
fi

echo "==> DMG 缺失，改用干净环境兜底（绕开受限 shell 的 grep / Finder 限制）"
DMG_PATH="$EXPECTED_DMG"
mkdir -p "$DMG_DIR"

# 先清掉上一次失败遗留的中间盘映像，避免占用盘符
hdiutil info 2>/dev/null | awk '/^image-path/ {print $3}' | grep -E "rw\.[0-9]+\." | while read -r img; do
    dev=$(hdiutil info | awk -v p="$img" '$1=="image-path" && $3==p {f=1} f && /^\/dev\/disk[0-9]+[[:space:]]/ {print $1; exit}')
    [ -n "$dev" ] && hdiutil detach "$dev" -force >/dev/null 2>&1
done

env -u BASH_ENV PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin \
    src-tauri/target/release/bundle/dmg/bundle_dmg.sh \
    --skip-jenkins \
    --volname "$(basename "${APP%.app}")" \
    "$DMG_PATH" "$APP"

if [ -f "$DMG_PATH" ]; then
    echo "==> DMG 已就绪（兜底路径）：$DMG_PATH"
    ls -lh "$DMG_PATH"
    hdiutil verify "$DMG_PATH" >/dev/null 2>&1 && echo "==> hdiutil verify 通过"
    exit 0
fi

echo "==> 失败：兜底也未能产出 DMG" >&2
exit 1

#!/usr/bin/env python3
"""把「AI 娘化全家福」的 6 张立绘加工成应用素材。

这一步是**一次性资产加工**，产物已经提交在 src/renderer/pet/characters/。
只有换素材时才需要重跑。

依赖（本机实测：Python 3.13 + onnxruntime 1.31）：
    pip install pillow rembg onnxruntime
首次运行会下载 isnet-anime 模型（176MB，走 ~/.rembg/models）。

为什么要 isnet-anime 而不是自写阈值抠图：
这些立绘是浅灰渐变背景 + 人物背后一圈白色轮廓光。用「色距 + 洪泛」抠，
光晕会被判成前景，最后得到一圈洗不掉的白边（试过，狗牙一样）。
isnet-anime 是专门训练动漫人像的 matting 模型，发丝和裙摆都能留住。

为什么要用并集 bbox 统一裁切：
6 张是同系列同构图，但人物高度差几像素。各裁各的会让切换角色时人忽大忽小，
像换了个游戏。取并集裁切后，6 个人的相对大小和站位完全一致。

用法：
    python3 scripts/build-characters.py <源图目录> [输出目录]
源图目录里放 6 张 png，文件名需含 chatgpt/claude/gemini/deepseek/midjourney/suno。
"""
import os
import sys
import glob
import numpy as np
from PIL import Image

KEYS = ["chatgpt", "claude", "gemini", "deepseek", "midjourney", "suno"]
DISP_W = 260  # 素材按 260 CSS px 宽出图（界面当前显示 238，留一点放大的余量）
SCALE = 2     # 供 retina

SRC = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = sys.argv[2] if len(sys.argv) > 2 else "src/renderer/pet/characters"


def cutout(path: str) -> Image.Image:
    from rembg import remove, new_session
    global _SESSION
    try:
        _SESSION
    except NameError:
        _SESSION = new_session("isnet-anime")
    return remove(Image.open(path), session=_SESSION).convert("RGBA")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)

    files = {}
    for key in KEYS:
        hits = [p for p in glob.glob(os.path.join(SRC, "*.png")) if key in os.path.basename(p).lower()]
        if not hits:
            print(f"缺素材: {key}")
            return 1
        files[key] = hits[0]

    imgs = {k: cutout(v) for k, v in files.items()}

    boxes = [im.split()[3].point(lambda a: 255 if a > 20 else 0).getbbox() for im in imgs.values()]
    pad = 8
    x0 = max(0, min(b[0] for b in boxes) - pad)
    y0 = max(0, min(b[1] for b in boxes) - pad)
    x1 = min(imgs[KEYS[0]].width, max(b[2] for b in boxes) + pad)
    y1 = min(imgs[KEYS[0]].height, max(b[3] for b in boxes) + pad)
    box = (x0, y0, x1, y1)

    tw = DISP_W * SCALE
    th = round((y1 - y0) * tw / (x1 - x0))
    print(f"统一裁切 {box} → 立绘 {tw}×{th}")

    total = 0
    for key, im in imgs.items():
        crop = im.crop(box).resize((tw, th), Image.LANCZOS)
        portrait = os.path.join(OUT, f"{key}.webp")
        crop.save(portrait, "WEBP", quality=86, method=6)

        # 面部头像：头顶往下 31%，水平居中于该带的不透明像素
        alpha = np.asarray(crop)[:, :, 3]
        rows = np.where(alpha.max(axis=1) > 40)[0]
        top = rows[0] if len(rows) else 0
        band = alpha[top:top + int(th * 0.30)]
        cols = np.where(band.max(axis=0) > 40)[0]
        cx = int((cols[0] + cols[-1]) / 2) if len(cols) else tw // 2
        side = int(th * 0.31)
        fx = max(0, min(tw - side, cx - side // 2))
        fy = max(0, top - int(side * 0.13))
        face = crop.crop((fx, fy, fx + side, fy + side)).resize((160, 160), Image.LANCZOS)
        face_path = os.path.join(OUT, f"{key}-face.webp")
        face.save(face_path, "WEBP", quality=88, method=6)

        size = (os.path.getsize(portrait) + os.path.getsize(face_path)) // 1024
        total += size
        print(f"  {key:<11} {size:>4} KB")

    print(f"合计 {total} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

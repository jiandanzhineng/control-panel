"""把 tools/render-icon.cjs 渲染出的多尺寸 PNG 合成 assets/icon.ico，并导出前端用的 PNG。

用法（在仓库根目录）：
    node tools/render-icon.cjs
    python -I tools/build-icon-ico.py
"""
from pathlib import Path
import shutil

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tmp" / "icon"
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    frames = [Image.open(SRC / f"icon-{s}.png").convert("RGBA") for s in ICO_SIZES]
    # Pillow 以最大帧为底、按 sizes 缩放；用 append_images 保证每个尺寸用各自渲染的那张
    frames[-1].save(
        ROOT / "assets" / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=frames[:-1],
    )
    shutil.copyfile(SRC / "icon-512.png", ROOT / "assets" / "icon.png")
    shutil.copyfile(SRC / "icon-64.png", ROOT / "frontend" / "public" / "favicon.png")
    print("ok", ROOT / "assets" / "icon.ico")


if __name__ == "__main__":
    main()

"""Generates the MyDownloadManager icon set (original artwork): extension PNGs and the Windows .ico.

Usage: python3 tools/generate_icons.py   (requires Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TOP, BOTTOM = (37, 125, 235), (18, 76, 170)


def render(size: int) -> Image.Image:
    s = 1024  # draw large, downsample for anti-aliasing
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / (s - 1)
        gd.line([(0, y), (s, y)], fill=tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, s - 40, s - 40], radius=210, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    # Arrow shaft + head
    d.rounded_rectangle([430, 190, 594, 560], radius=40, fill=white)
    d.polygon([(272, 500), (752, 500), (512, 760)], fill=white)
    # Tray
    d.rounded_rectangle([250, 800, 774, 870], radius=35, fill=white)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ext_icons = ROOT / "extensions" / "src" / "icons"
    ext_icons.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        render(size).save(ext_icons / f"icon{size}.png")
    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)
    render(256).save(assets / "icon256.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    render(256).save(assets / "MyDownloadManager.ico", sizes=[(s, s) for s in sizes])
    print("icons written")


if __name__ == "__main__":
    main()

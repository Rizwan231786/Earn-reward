"""Motion-graphics templates rendered with Pillow (4x-supersampled RGBA PNGs).

Each template returns a transparent PNG and where to place it. The renderer animates it with
FFmpeg (slide/fade/pop/rise with eased timing). Templates follow the active profile's palette
and typography. They show only text and data supplied by the user or taken from the transcript.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter

from .fonts import pil_font
from .models import Graphic

SS = 3  # supersampling factor


def hex_rgb(h: str, a: int = 255) -> tuple[int, int, int, int]:
    h = h.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a


@dataclass
class Placed:
    path: Path
    x: int
    y: int
    w: int
    h: int
    fullscreen: bool = False


class Ctx:
    def __init__(self, W: int, H: int, profile: dict):
        self.W, self.H = W, H
        self.s = min(W, H) / 1080.0
        self.vertical = H > W
        pal = profile.get("palette", {})
        self.accent = pal.get("turquoise", "#14C8C0")
        self.accent2 = pal.get("turquoise_bright", "#2EE6D6")
        self.navy = pal.get("navy", "#0B1E3A")
        self.navy2 = pal.get("navy_soft", "#13294B")
        self.ice = pal.get("ice_blue", "#DCF3FA")
        self.white = pal.get("white", "#FFFFFF")
        typ = profile.get("typography", {})
        self.head = typ.get("headline", "Montserrat")
        self.head_w = typ.get("headline_weight", "ExtraBold")
        self.body = typ.get("body", "Inter")
        self.body_w = typ.get("body_weight", "SemiBold")
        self.radius = int(profile.get("graphics", {}).get("corner_radius", 28))

    def px(self, v: float) -> int:
        return int(round(v * self.s * SS))

    def font(self, fam: str, weight: str, size: float):
        return pil_font(fam, weight, max(8, self.px(size)))

    def margin(self) -> int:
        return int((0.07 if self.vertical else 0.055) * self.W)


def _canvas(w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def _finish(im: Image.Image, dest: Path, shadow: bool = True, c: Ctx | None = None) -> Image.Image:
    """Downsample (anti-aliasing) and add a soft drop shadow."""
    w, h = im.width // SS, im.height // SS
    small = im.resize((w, h), Image.LANCZOS)
    if shadow:
        pad = int(24 * (c.s if c else 1))
        out = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
        alpha = small.split()[3].point(lambda a: int(a * 0.45))
        sh = Image.new("RGBA", small.size, (4, 12, 28, 255))
        sh.putalpha(alpha)
        out.paste(sh, (pad, pad + int(pad * 0.35)), sh)
        out = out.filter(ImageFilter.GaussianBlur(pad * 0.45))
        out.alpha_composite(small, (pad, pad))
        small = out
    dest.parent.mkdir(parents=True, exist_ok=True)
    small.save(dest)
    return small


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        t = (cur + " " + word).strip()
        if draw.textlength(t, font=font) <= max_w or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def _panel(draw, box, c: Ctx, fill=None, outline=True, radius=None):
    r = c.px(radius if radius is not None else c.radius)
    draw.rounded_rectangle(box, r, fill=fill or hex_rgb(c.navy, 222))
    if outline:
        draw.rounded_rectangle(box, r, outline=(255, 255, 255, 46), width=max(1, c.px(1.5)))


# ---------------------------------------------------------------------------
# Icons (vector, drawn at supersampled size)
# ---------------------------------------------------------------------------
def draw_icon(draw: ImageDraw.ImageDraw, name: str, cx: int, cy: int, r: int, color, bg=None):
    if bg:
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=bg)
    k = r * 0.5
    lw = max(2, int(r * 0.16))
    if name == "check":
        draw.line([(cx - k, cy), (cx - k * 0.25, cy + k * 0.7), (cx + k, cy - k * 0.65)], fill=color, width=lw, joint="curve")
    elif name in ("medical", "plus"):
        a = k * 0.9
        t = k * 0.32
        draw.rectangle((cx - t, cy - a, cx + t, cy + a), fill=color)
        draw.rectangle((cx - a, cy - t, cx + a, cy + t), fill=color)
    elif name == "pin":
        rr = k * 0.8
        draw.ellipse((cx - rr, cy - rr * 1.5, cx + rr, cy + rr * 0.5), fill=color)
        draw.polygon([(cx - rr * 0.8, cy - rr * 0.3), (cx + rr * 0.8, cy - rr * 0.3), (cx, cy + rr * 1.4)], fill=color)
        hole = rr * 0.38
        draw.ellipse((cx - hole, cy - rr * 0.5 - hole, cx + hole, cy - rr * 0.5 + hole), fill=bg or (0, 0, 0, 0))
    elif name == "phone":
        draw.rounded_rectangle((cx - k * 0.55, cy - k, cx + k * 0.55, cy + k), int(k * 0.2), outline=color, width=lw)
        draw.ellipse((cx - lw * 0.6, cy + k * 0.62, cx + lw * 0.6, cy + k * 0.62 + lw * 1.2), fill=color)
    elif name == "star":
        pts = []
        for i in range(10):
            ang = -math.pi / 2 + i * math.pi / 5
            rad = k if i % 2 == 0 else k * 0.45
            pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
        draw.polygon(pts, fill=color)
    elif name == "clock":
        draw.ellipse((cx - k, cy - k, cx + k, cy + k), outline=color, width=lw)
        draw.line([(cx, cy), (cx, cy - k * 0.6)], fill=color, width=lw)
        draw.line([(cx, cy), (cx + k * 0.45, cy + k * 0.2)], fill=color, width=lw)
    elif name == "shield":
        draw.polygon([(cx, cy - k), (cx + k * 0.85, cy - k * 0.6), (cx + k * 0.7, cy + k * 0.35), (cx, cy + k),
                      (cx - k * 0.7, cy + k * 0.35), (cx - k * 0.85, cy - k * 0.6)], outline=color, width=lw)
        draw.line([(cx - k * 0.35, cy), (cx - k * 0.05, cy + k * 0.3), (cx + k * 0.4, cy - k * 0.3)], fill=color, width=lw)
    elif name == "calendar":
        draw.rounded_rectangle((cx - k, cy - k * 0.8, cx + k, cy + k), int(k * 0.2), outline=color, width=lw)
        draw.line([(cx - k, cy - k * 0.3), (cx + k, cy - k * 0.3)], fill=color, width=lw)
    elif name == "sparkle":
        for ang in (0, math.pi / 2):
            draw.polygon([(cx + k * math.cos(ang), cy + k * math.sin(ang)), (cx + k * 0.18 * math.cos(ang + math.pi / 2), cy + k * 0.18 * math.sin(ang + math.pi / 2)),
                          (cx - k * math.cos(ang), cy - k * math.sin(ang)), (cx - k * 0.18 * math.cos(ang + math.pi / 2), cy - k * 0.18 * math.sin(ang + math.pi / 2))], fill=color)
    elif name == "chat":
        draw.rounded_rectangle((cx - k, cy - k * 0.75, cx + k, cy + k * 0.45), int(k * 0.35), fill=color)
        draw.polygon([(cx - k * 0.5, cy + k * 0.3), (cx - k * 0.1, cy + k * 0.3), (cx - k * 0.6, cy + k * 0.95)], fill=color)
    elif name == "drop":
        draw.polygon([(cx, cy - k), (cx - k * 0.62, cy + k * 0.05), (cx + k * 0.62, cy + k * 0.05)], fill=color)
        draw.ellipse((cx - k * 0.65, cy - k * 0.25, cx + k * 0.65, cy + k * 0.95), fill=color)
    elif name == "user":
        draw.ellipse((cx - k * 0.42, cy - k * 0.95, cx + k * 0.42, cy - k * 0.1), fill=color)
        draw.pieslice((cx - k * 0.85, cy - k * 0.05, cx + k * 0.85, cy + k * 1.5), 180, 360, fill=color)
    elif name == "video":
        draw.rounded_rectangle((cx - k, cy - k * 0.55, cx + k * 0.35, cy + k * 0.55), int(k * 0.18), fill=color)
        draw.polygon([(cx + k * 0.4, cy - k * 0.1), (cx + k, cy - k * 0.5), (cx + k, cy + k * 0.5), (cx + k * 0.4, cy + k * 0.1)],
                     fill=color)
    elif name == "home":
        draw.polygon([(cx, cy - k), (cx - k, cy - k * 0.05), (cx + k, cy - k * 0.05)], outline=color, width=lw)
        draw.rectangle((cx - k * 0.68, cy - k * 0.05, cx + k * 0.68, cy + k * 0.85), outline=color, width=lw)
        draw.rectangle((cx - k * 0.2, cy + k * 0.3, cx + k * 0.2, cy + k * 0.85), fill=color)
    elif name == "briefcase":
        draw.rounded_rectangle((cx - k, cy - k * 0.45, cx + k, cy + k * 0.8), int(k * 0.15), outline=color, width=lw)
        draw.rounded_rectangle((cx - k * 0.38, cy - k * 0.85, cx + k * 0.38, cy - k * 0.45), int(k * 0.1), outline=color,
                               width=lw)
        draw.line([(cx - k, cy + k * 0.1), (cx + k, cy + k * 0.1)], fill=color, width=lw)
    elif name == "graduation":
        draw.polygon([(cx, cy - k * 0.8), (cx - k, cy - k * 0.25), (cx, cy + k * 0.3), (cx + k, cy - k * 0.25)], outline=color,
                     width=lw)
        draw.arc((cx - k * 0.6, cy - k * 0.3, cx + k * 0.6, cy + k * 0.8), 0, 180, fill=color, width=lw)
        draw.line([(cx + k * 0.85, cy - k * 0.2), (cx + k * 0.85, cy + k * 0.5)], fill=color, width=lw)
    elif name == "monitor":
        draw.rounded_rectangle((cx - k, cy - k * 0.75, cx + k, cy + k * 0.4), int(k * 0.12), outline=color, width=lw)
        draw.line([(cx, cy + k * 0.4), (cx, cy + k * 0.75)], fill=color, width=lw)
        draw.line([(cx - k * 0.45, cy + k * 0.8), (cx + k * 0.45, cy + k * 0.8)], fill=color, width=lw)
    elif name == "pulse":
        draw.line([(cx - k, cy), (cx - k * 0.4, cy), (cx - k * 0.15, cy - k * 0.7), (cx + k * 0.15, cy + k * 0.7),
                   (cx + k * 0.4, cy), (cx + k, cy)], fill=color, width=lw, joint="curve")
    elif name == "search":
        draw.ellipse((cx - k * 0.85, cy - k * 0.85, cx + k * 0.35, cy + k * 0.35), outline=color, width=lw)
        draw.line([(cx + k * 0.25, cy + k * 0.25), (cx + k * 0.9, cy + k * 0.9)], fill=color, width=lw)
    elif name == "document":
        draw.rounded_rectangle((cx - k * 0.7, cy - k, cx + k * 0.7, cy + k), int(k * 0.12), outline=color, width=lw)
        for j in range(3):
            draw.line([(cx - k * 0.4, cy - k * 0.45 + j * k * 0.45), (cx + k * 0.4, cy - k * 0.45 + j * k * 0.45)], fill=color,
                      width=max(1, lw // 2 + 1))
    elif name == "warning":
        draw.polygon([(cx, cy - k), (cx - k, cy + k * 0.8), (cx + k, cy + k * 0.8)], outline=color, width=lw)
        draw.line([(cx, cy - k * 0.3), (cx, cy + k * 0.25)], fill=color, width=lw)
        draw.ellipse((cx - lw * 0.6, cy + k * 0.45, cx + lw * 0.6, cy + k * 0.45 + lw * 1.2), fill=color)
    else:  # dot
        draw.ellipse((cx - k * 0.4, cy - k * 0.4, cx + k * 0.4, cy + k * 0.4), fill=color)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------
def lower_third(c: Ctx, p: dict, dest: Path) -> Placed:
    name = str(p.get("name") or p.get("title") or "").strip()
    role = str(p.get("role") or p.get("subtitle") or "").strip()
    fn, fr = c.font(c.head, "Bold", 46), c.font(c.body, "Medium", 30)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    tw = max(tmp.textlength(name, font=fn), tmp.textlength(role, font=fr) if role else 0)
    padx, bar = c.px(34), c.px(10)
    w = int(tw + padx * 2 + bar + c.px(10))
    h = c.px(150 if role else 100)
    im, d = _canvas(w, h)
    _panel(d, (0, 0, w - 1, h - 1), c, radius=20)
    d.rounded_rectangle((c.px(16), c.px(18), c.px(16) + bar, h - c.px(18)), bar // 2, fill=hex_rgb(c.accent2))
    x0 = c.px(16) + bar + c.px(22)
    d.text((x0, c.px(22)), name, font=fn, fill=hex_rgb(c.white))
    if role:
        d.text((x0, c.px(86)), role, font=fr, fill=hex_rgb(c.ice, 235))
    small = _finish(im, dest, c=c)
    m = c.margin()
    y = int(c.H * (0.62 if c.vertical else 0.70))
    return Placed(dest, m - int(24 * c.s), y, small.width, small.height)


def title_card(c: Ctx, p: dict, dest: Path) -> Placed:
    title = str(p.get("title", "")).strip()
    sub = str(p.get("subtitle", "")).strip()
    full = bool(p.get("fullscreen", False))
    W, H = c.W * SS, c.H * SS
    ft = c.font(c.head, c.head_w, 96 if not c.vertical else 92)
    fs = c.font(c.body, "Medium", 40)
    im, d = _canvas(W, H)
    maxw = int(W * (0.78 if c.vertical else 0.66))
    lines = _wrap(d, title.upper() if p.get("uppercase", True) else title, ft, maxw)
    slines = _wrap(d, sub, fs, maxw) if sub else []
    lh, sh = c.px(112), c.px(56)
    block_h = len(lines) * lh + (c.px(40) + len(slines) * sh if slines else 0)
    y = (H - block_h) // 2
    if full:
        top, bot = hex_rgb(c.navy), hex_rgb(c.navy2)
        for yy in range(0, H, SS * 2):
            f = yy / H
            col = tuple(int(top[i] * (1 - f) + bot[i] * f) for i in range(3)) + (255,)
            d.rectangle((0, yy, W, yy + SS * 2), fill=col)
        d.ellipse((W * 0.55, -H * 0.2, W * 1.3, H * 0.5), fill=hex_rgb(c.accent, 26))
    else:
        pad = c.px(60)
        bw = max(d.textlength(l, font=ft) for l in lines) if lines else 0
        if slines:
            bw = max(bw, max(d.textlength(l, font=fs) for l in slines))
        _panel(d, ((W - bw) / 2 - pad, y - pad, (W + bw) / 2 + pad, y + block_h + pad), c, fill=hex_rgb(c.navy, 200))
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=ft)
        d.text(((W - tw) / 2, y + i * lh), ln, font=ft, fill=hex_rgb(c.white))
    ay = y + len(lines) * lh + c.px(14)
    d.rounded_rectangle((W / 2 - c.px(60), ay, W / 2 + c.px(60), ay + c.px(7)), c.px(4), fill=hex_rgb(c.accent2))
    for i, ln in enumerate(slines):
        tw = d.textlength(ln, font=fs)
        d.text(((W - tw) / 2, ay + c.px(30) + i * sh), ln, font=fs, fill=hex_rgb(c.ice))
    small = im.resize((c.W, c.H), Image.LANCZOS)
    small.save(dest)
    return Placed(dest, 0, 0, c.W, c.H, fullscreen=full)


def info_card(c: Ctx, p: dict, dest: Path, stat: bool = False) -> Placed:
    head = str(p.get("value") if stat else p.get("title", "")).strip()
    body = str(p.get("label") if stat else p.get("text", "")).strip()
    icon = p.get("icon", "sparkle" if not stat else None)
    w = c.px(560 if not c.vertical else 760)
    fh = c.font(c.head, c.head_w if stat else "Bold", 88 if stat else 44)
    fb = c.font(c.body, "Medium", 32)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    text_x = c.px(130) if icon else c.px(40)
    hl = _wrap(tmp, head, fh, w - text_x - c.px(40))
    bl = _wrap(tmp, body, fb, w - text_x - c.px(40)) if body else []
    lh_h, lh_b = c.px(100 if stat else 56), c.px(44)
    h = c.px(44) * 2 + len(hl) * lh_h + len(bl) * lh_b + (c.px(10) if bl else 0)
    im, d = _canvas(w, max(h, c.px(150)))
    _panel(d, (0, 0, w - 1, im.height - 1), c, fill=hex_rgb(c.navy, 215))
    if icon:
        draw_icon(d, icon, c.px(72), c.px(44) + c.px(38), c.px(38), hex_rgb(c.navy), bg=hex_rgb(c.accent2))
    y = c.px(40)
    for ln in hl:
        d.text((text_x, y), ln, font=fh, fill=hex_rgb(c.accent2 if stat else c.white))
        y += lh_h
    y += c.px(6)
    for ln in bl:
        d.text((text_x, y), ln, font=fb, fill=hex_rgb(c.ice, 235))
        y += lh_b
    small = _finish(im, dest, c=c)
    m = c.margin()
    pos = p.get("side", "right")
    x = c.W - small.width - m + int(24 * c.s) if pos == "right" else m - int(24 * c.s)
    y0 = int(c.H * (0.14 if c.vertical else 0.12))
    return Placed(dest, x, y0, small.width, small.height)


def callout(c: Ctx, p: dict, dest: Path) -> Placed:
    text = str(p.get("text", "")).strip()
    f = c.font(c.body, "Bold", 34)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    tw = int(tmp.textlength(text, font=f))
    w, h = tw + c.px(110), c.px(84)
    im, d = _canvas(w, h)
    d.rounded_rectangle((0, 0, w - 1, h - 1), h // 2, fill=hex_rgb(c.white, 245))
    draw_icon(d, "dot", c.px(42), h // 2, c.px(22), hex_rgb(c.accent), bg=hex_rgb(c.accent, 60))
    d.text((c.px(76), (h - c.px(40)) // 2), text, font=f, fill=hex_rgb(c.navy))
    small = _finish(im, dest, c=c)
    ax, ay = float(p.get("x", 0.5)), float(p.get("y", 0.3))
    x = int(min(max(0, ax * c.W - small.width / 2), c.W - small.width))
    y = int(min(max(0, ay * c.H - small.height / 2), c.H - small.height))
    return Placed(dest, x, y, small.width, small.height)


def notification(c: Ctx, p: dict, dest: Path) -> Placed:
    app = str(p.get("app", "Messages"))
    title = str(p.get("title", "")).strip()
    body = str(p.get("text", "")).strip()
    w = c.px(820 if c.vertical else 640)
    ft, fb, fa = c.font(c.body, "Bold", 32), c.font(c.body, "Regular", 30), c.font(c.body, "Medium", 24)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bl = _wrap(tmp, body, fb, w - c.px(170))[:3]
    h = c.px(118) + len(bl) * c.px(42)
    im, d = _canvas(w, h)
    d.rounded_rectangle((0, 0, w - 1, h - 1), c.px(34), fill=(246, 249, 252, 242))
    d.rounded_rectangle((c.px(26), c.px(26), c.px(106), c.px(106)), c.px(22), fill=hex_rgb(c.accent))
    draw_icon(d, p.get("icon", "chat"), c.px(66), c.px(66), c.px(34), (255, 255, 255, 255))
    d.text((c.px(130), c.px(22)), app.upper(), font=fa, fill=(110, 120, 135, 255))
    d.text((w - c.px(110), c.px(22)), str(p.get("time", "now")), font=fa, fill=(110, 120, 135, 255))
    d.text((c.px(130), c.px(54)), title, font=ft, fill=hex_rgb(c.navy))
    for i, ln in enumerate(bl):
        d.text((c.px(130), c.px(96) + i * c.px(42)), ln, font=fb, fill=(40, 52, 70, 255))
    small = _finish(im, dest, c=c)
    return Placed(dest, (c.W - small.width) // 2, int(c.H * (0.08 if c.vertical else 0.06)), small.width, small.height)


def phone_mockup(c: Ctx, p: dict, dest: Path, project_root: Path | None = None) -> Placed:
    ph = c.px(1150 if c.vertical else 820)
    pw = int(ph * 0.49)
    im, d = _canvas(pw, ph)
    bez = c.px(18)
    d.rounded_rectangle((0, 0, pw - 1, ph - 1), c.px(78), fill=(18, 22, 30, 255))
    d.rounded_rectangle((c.px(4), c.px(4), pw - c.px(5), ph - c.px(5)), c.px(76), outline=(90, 100, 115, 255), width=c.px(3))
    sx0, sy0, sx1, sy1 = bez, bez, pw - bez, ph - bez
    screen = Image.new("RGBA", (sx1 - sx0, sy1 - sy0), hex_rgb(c.ice))
    sd = ImageDraw.Draw(screen)
    img_path = p.get("image")
    if img_path and project_root:
        ip = (project_root / img_path).resolve()
        if ip.exists() and str(ip).startswith(str(project_root.resolve())):
            simg = Image.open(ip).convert("RGBA")
            r = max(screen.width / simg.width, screen.height / simg.height)
            simg = simg.resize((int(simg.width * r) + 1, int(simg.height * r) + 1), Image.LANCZOS)
            screen.alpha_composite(simg, ((screen.width - simg.width) // 2, (screen.height - simg.height) // 2))
    else:
        sw = screen.width
        u = sw / 100.0  # phone-relative unit (1% of screen width) so UI always fits the screen

        def fit(text, fam, weight, size_u, max_w):
            size = int(size_u * u)
            f = pil_font(fam, weight, size)
            while sd.textlength(text, font=f) > max_w and size > 8:
                size -= 2
                f = pil_font(fam, weight, size)
            return f
        sd.rectangle((0, 0, sw, int(26 * u)), fill=hex_rgb(c.navy))
        title = str(p.get("app_title", "Book Appointment"))
        sd.text((int(7 * u), int(13 * u)), title, font=fit(title, c.head, "Bold", 7.5, sw - 14 * u), fill=hex_rgb(c.white))
        y = int(32 * u)
        for item in (p.get("items") or ["Consultation", "Treatment plan", "Follow-up"])[:5]:
            sd.rounded_rectangle((int(6 * u), y, sw - int(6 * u), y + int(17 * u)), int(4 * u), fill=(255, 255, 255, 255))
            draw_icon(sd, "check", int(15 * u), y + int(8.5 * u), int(4.5 * u), (255, 255, 255, 255), bg=hex_rgb(c.accent))
            txt = str(item)
            sd.text((int(24 * u), y + int(4.5 * u)), txt, font=fit(txt, c.body, "SemiBold", 6, sw - 32 * u), fill=hex_rgb(c.navy))
            y += int(21 * u)
        btn = str(p.get("button", "Book Now"))
        by = screen.height - int(30 * u)
        sd.rounded_rectangle((int(6 * u), by, sw - int(6 * u), by + int(16 * u)), int(8 * u), fill=hex_rgb(c.accent))
        bf = fit(btn, c.body, "Bold", 6.5, sw - 20 * u)
        sd.text(((sw - sd.textlength(btn, font=bf)) / 2, by + int(4 * u)), btn, font=bf, fill=(255, 255, 255, 255))
    mask = Image.new("L", screen.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, screen.width - 1, screen.height - 1), c.px(62), fill=255)
    im.paste(screen, (sx0, sy0), mask)
    d.rounded_rectangle((pw / 2 - c.px(70), c.px(34), pw / 2 + c.px(70), c.px(70)), c.px(18), fill=(18, 22, 30, 255))
    small = _finish(im, dest, c=c)
    side = p.get("side", "right")
    x = int(c.W * 0.62 - small.width / 2) if side == "right" and not c.vertical else (c.W - small.width) // 2
    y = (c.H - small.height) // 2
    return Placed(dest, x, y, small.width, small.height)


def process_steps(c: Ctx, p: dict, dest: Path) -> Placed:
    steps = [str(s) for s in (p.get("steps") or [])][:5] or ["Step 1", "Step 2", "Step 3"]
    n = len(steps)
    w = int(c.W * SS * (0.88 if c.vertical else 0.8))
    h = c.px(300)
    im, d = _canvas(w, h)
    _panel(d, (0, 0, w - 1, h - 1), c, fill=hex_rgb(c.navy, 205))
    seg = w / n
    cy = c.px(110)
    d.line([(seg / 2, cy), (w - seg / 2, cy)], fill=hex_rgb(c.accent, 160), width=c.px(5))
    f_num, f_lab = c.font(c.head, "ExtraBold", 40), c.font(c.body, "SemiBold", 28 if c.vertical else 30)
    for i, s in enumerate(steps):
        cx = seg * i + seg / 2
        r = c.px(46)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=hex_rgb(c.accent2), outline=hex_rgb(c.white), width=c.px(4))
        num = str(i + 1)
        d.text((cx - d.textlength(num, font=f_num) / 2, cy - c.px(26)), num, font=f_num, fill=hex_rgb(c.navy))
        for k, ln in enumerate(_wrap(d, s, f_lab, int(seg - c.px(24)))[:2]):
            d.text((cx - d.textlength(ln, font=f_lab) / 2, cy + c.px(72) + k * c.px(38)), ln, font=f_lab, fill=hex_rgb(c.white))
    small = _finish(im, dest, c=c)
    return Placed(dest, (c.W - small.width) // 2, int(c.H * (0.12 if c.vertical else 0.1)), small.width, small.height)


def checklist(c: Ctx, p: dict, dest: Path) -> Placed:
    items = [str(s) for s in (p.get("items") or [])][:6]
    title = str(p.get("title", "")).strip()
    w = c.px(760 if c.vertical else 640)
    fi, ft = c.font(c.body, "SemiBold", 34), c.font(c.head, "Bold", 40)
    h = c.px(60) + (c.px(70) if title else 0) + len(items) * c.px(76)
    im, d = _canvas(w, h)
    _panel(d, (0, 0, w - 1, h - 1), c)
    y = c.px(34)
    if title:
        d.text((c.px(40), y), title, font=ft, fill=hex_rgb(c.white))
        y += c.px(70)
    for it in items:
        draw_icon(d, "check", c.px(68), y + c.px(26), c.px(24), hex_rgb(c.navy), bg=hex_rgb(c.accent2))
        d.text((c.px(112), y + c.px(4)), it, font=fi, fill=hex_rgb(c.ice))
        y += c.px(76)
    small = _finish(im, dest, c=c)
    m = c.margin()
    return Placed(dest, m - int(24 * c.s), int(c.H * (0.15 if c.vertical else 0.14)), small.width, small.height)


def location_pin(c: Ctx, p: dict, dest: Path) -> Placed:
    """Stylised location card (illustrative map pattern, not a real map)."""
    place = str(p.get("name", "")).strip()
    addr = str(p.get("address", "")).strip()
    w, mh = c.px(640), c.px(300)
    fh, fa = c.font(c.head, "Bold", 38), c.font(c.body, "Medium", 28)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    al = _wrap(tmp, addr, fa, w - c.px(80))[:2]
    h = mh + c.px(70) + len(al) * c.px(40) + c.px(40)
    im, d = _canvas(w, h)
    _panel(d, (0, 0, w - 1, h - 1), c)
    mp = Image.new("RGBA", (w - c.px(24), mh), hex_rgb(c.ice))
    md = ImageDraw.Draw(mp)
    for k in range(-2, 12):
        md.line([(k * c.px(80), 0), (k * c.px(80) + c.px(160), mh)], fill=(255, 255, 255, 255), width=c.px(10))
        md.line([(0, k * c.px(70)), (mp.width, k * c.px(70) - c.px(60))], fill=(196, 226, 236, 255), width=c.px(6))
    md.line([(0, mh * 0.62), (mp.width, mh * 0.48)], fill=(255, 255, 255, 255), width=c.px(22))
    draw_icon(md, "pin", mp.width // 2, mh // 2, c.px(70), hex_rgb(c.accent), bg=hex_rgb(c.ice))
    mask = Image.new("L", mp.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mp.width - 1, mh - 1), c.px(20), fill=255)
    im.paste(mp, (c.px(12), c.px(12)), mask)
    y = mh + c.px(36)
    d.text((c.px(40), y), place, font=fh, fill=hex_rgb(c.white))
    y += c.px(56)
    for ln in al:
        d.text((c.px(40), y), ln, font=fa, fill=hex_rgb(c.ice, 230))
        y += c.px(40)
    small = _finish(im, dest, c=c)
    m = c.margin()
    return Placed(dest, c.W - small.width - m + int(24 * c.s), int(c.H * 0.12), small.width, small.height)


def cta(c: Ctx, p: dict, dest: Path) -> Placed:
    head = str(p.get("headline", p.get("title", ""))).strip()
    sub = str(p.get("subtitle", "")).strip()
    btn = str(p.get("button", "")).strip()
    contact = [str(x) for x in (p.get("contact") or [])][:3]
    W, H = c.W * SS, c.H * SS
    im, d = _canvas(W, H)
    full = p.get("fullscreen", True)
    if full:
        top, bot = hex_rgb(c.navy), hex_rgb(c.navy2)
        for yy in range(0, H, SS * 2):
            f = yy / H
            d.rectangle((0, yy, W, yy + SS * 2), fill=tuple(int(top[i] * (1 - f) + bot[i] * f) for i in range(3)) + (255,))
        d.ellipse((-W * 0.3, H * 0.6, W * 0.5, H * 1.3), fill=hex_rgb(c.accent, 30))
    fh, fs, fb, fc = (c.font(c.head, c.head_w, 84), c.font(c.body, "Medium", 40), c.font(c.body, "Bold", 40),
                      c.font(c.body, "SemiBold", 34))
    maxw = int(W * (0.8 if c.vertical else 0.7))
    hl = _wrap(d, head, fh, maxw)
    sl = _wrap(d, sub, fs, maxw) if sub else []
    total = len(hl) * c.px(100) + len(sl) * c.px(54) + (c.px(170) if btn else 0) + len(contact) * c.px(54)
    y = (H - total) // 2
    if not full:
        pad = c.px(60)
        _panel(d, (W * 0.1 - pad / 2, y - pad, W * 0.9 + pad / 2, y + total + pad), c, fill=hex_rgb(c.navy, 225))
    for ln in hl:
        d.text(((W - d.textlength(ln, font=fh)) / 2, y), ln, font=fh, fill=hex_rgb(c.white))
        y += c.px(100)
    for ln in sl:
        d.text(((W - d.textlength(ln, font=fs)) / 2, y), ln, font=fs, fill=hex_rgb(c.ice))
        y += c.px(54)
    if btn:
        y += c.px(40)
        bw = d.textlength(btn, font=fb) + c.px(120)
        d.rounded_rectangle(((W - bw) / 2, y, (W + bw) / 2, y + c.px(100)), c.px(50), fill=hex_rgb(c.accent))
        d.text(((W - d.textlength(btn, font=fb)) / 2, y + c.px(26)), btn, font=fb, fill=hex_rgb(c.white))
        y += c.px(130)
    for ln in contact:
        d.text(((W - d.textlength(ln, font=fc)) / 2, y), ln, font=fc, fill=hex_rgb(c.accent2))
        y += c.px(54)
    im.resize((c.W, c.H), Image.LANCZOS).save(dest)
    return Placed(dest, 0, 0, c.W, c.H, fullscreen=bool(full))


def image_card(c: Ctx, p: dict, dest: Path, project_root: Path, logo: bool = False) -> Placed:
    ip = (project_root / str(p.get("image", ""))).resolve()
    if not ip.exists() or not str(ip).startswith(str(project_root.resolve())):
        raise ValueError(f"image not found inside project: {p.get('image')}")
    img = Image.open(ip).convert("RGBA")
    target_w = int(c.W * (0.14 if logo else (0.6 if c.vertical else 0.36)) * float(p.get("scale", 1.0)))
    r = target_w / img.width
    img = img.resize((target_w, max(1, int(img.height * r))), Image.LANCZOS)
    if logo:
        img.save(dest)
        m = c.margin() // 2
        return Placed(dest, c.W - img.width - m, m, img.width, img.height)
    rad = int(c.radius * c.s)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), rad, fill=255)
    img.putalpha(Image.composite(img.split()[3], mask, mask))
    out = Image.new("RGBA", (img.width + 8, img.height + 8), (0, 0, 0, 0))
    ImageDraw.Draw(out).rounded_rectangle((0, 0, out.width - 1, out.height - 1), rad + 4, fill=(255, 255, 255, 230))
    out.alpha_composite(img, (4, 4))
    out.save(dest)
    return Placed(dest, (c.W - out.width) // 2, int(c.H * 0.12), out.width, out.height)


def line_accent(c: Ctx, p: dict, dest: Path) -> Placed:
    w, h = int(c.W * 0.3), max(2, int(6 * c.s))
    im = Image.new("RGBA", (w, h), hex_rgb(c.accent2))
    im.save(dest)
    return Placed(dest, int(float(p.get("x", 0.5)) * c.W - w / 2), int(float(p.get("y", 0.5)) * c.H), w, h)


def render_graphic(g: Graphic, W: int, H: int, profile: dict, out_dir: Path, project_root: Path) -> Placed | None:
    """Render a graphic to PNG. Returns None for ASS-based graphics (kinetic_text)."""
    if g.type == "kinetic_text":
        return None
    c = Ctx(W, H, profile)
    dest = out_dir / f"{g.id}_{g.type}_{W}x{H}.png"
    p: dict[str, Any] = g.params
    fn = {
        "lower_third": lambda: lower_third(c, p, dest),
        "title_card": lambda: title_card(c, p, dest),
        "info_card": lambda: info_card(c, p, dest),
        "stat_card": lambda: info_card(c, p, dest, stat=True),
        "callout": lambda: callout(c, p, dest),
        "notification": lambda: notification(c, p, dest),
        "phone_mockup": lambda: phone_mockup(c, p, dest, project_root),
        "process_steps": lambda: process_steps(c, p, dest),
        "checklist": lambda: checklist(c, p, dest),
        "location_pin": lambda: location_pin(c, p, dest),
        "cta": lambda: cta(c, p, dest),
        "image_card": lambda: image_card(c, p, dest, project_root),
        "logo_bug": lambda: image_card(c, p, dest, project_root, logo=True),
        "line_accent": lambda: line_accent(c, p, dest),
    }[g.type]
    placed = fn()
    if g.position not in ("auto", ""):
        placed = _apply_position(placed, g.position, W, H, c)
    return placed


def _apply_position(pl: Placed, pos: str, W: int, H: int, c: Ctx) -> Placed:
    m = c.margin()
    xs = {"left": m, "center": (W - pl.w) // 2, "right": W - pl.w - m}
    ys = {"top": int(H * 0.08), "middle": (H - pl.h) // 2, "bottom": int(H * 0.92) - pl.h}
    parts = pos.split("_")
    if len(parts) == 2 and parts[0] in ys and parts[1] in xs:
        pl.y, pl.x = ys[parts[0]], xs[parts[1]]
    return pl

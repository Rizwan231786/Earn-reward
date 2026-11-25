"""Layered motion graphics: full-screen designed scenes and animated overlays.

This is the "motion explainer" style, as in premium medical/clinic Reels:
* **Full-screen scenes** (opaque) replace the footage for a few seconds and illustrate exactly what
  is being said: kinetic headlines, phone UI (booking, chat, video call with real footage inside),
  journey flows, numbered steps, icon tiles, cards and a CTA end card. Each is rendered as its own
  video clip and joined to the footage with slide transitions.
* **Overlays** (transparent) sit on top of the talking-head footage: label pills, count-up stats,
  credential cards, headline cards, floating chat bubbles.

Every element is a separate PNG layer with its own entrance delay and easing, so lines and cards come
in one after another instead of the whole graphic appearing at once.

Text markup: wrap a word or phrase in *asterisks* to colour it with the accent colour, and use \\n for
line breaks. For example "RANDOM\\n*SKINCARE*\\nROUTINES".
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter

from .fonts import pil_font
from .graphics import draw_icon, hex_rgb

SS = 3  # supersampling

SCENE_TYPES = {"scene_headline", "scene_phone", "scene_flow", "scene_steps", "scene_icons", "scene_cards", "scene_cta"}
LAYERED_OVERLAYS = {"label_pill", "counter", "credential_card", "headline_card", "chat_bubbles"}


@dataclass
class Layer:
    path: Path
    x: int
    y: int
    w: int
    h: int
    delay: float = 0.0
    anim: str = "rise"  # rise | drop | fade | slide_left | slide_right | none
    until: float | None = None  # seconds after the graphic starts; None => until the graphic ends
    dur_in: float = 0.45


@dataclass
class Composite:
    layers: list[Layer] = field(default_factory=list)
    fullscreen: bool = False
    background: Path | None = None
    inset: dict | None = None  # video inside the frame: {asset_id, src_in, x, y, w, h, radius}


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
class Builder:
    def __init__(self, W: int, H: int, profile: dict, out_dir: Path, gid: str, theme: str = "navy"):
        self.W, self.H = W, H
        self.s = min(W, H) / 1080.0
        self.vertical = H > W
        self.out = out_dir
        self.gid = gid
        self.n = 0
        pal = profile.get("palette", {})
        self.navy = pal.get("navy", "#0B1E3A")
        self.navy2 = pal.get("navy_soft", "#13294B")
        self.ice = pal.get("ice_blue", "#DCF3FA")
        self.turq = pal.get("turquoise", "#14C8C0")
        self.turq2 = pal.get("turquoise_bright", "#2EE6D6")
        typ = profile.get("typography", {})
        self.head = typ.get("headline", "Montserrat")
        self.body = typ.get("body", "Inter")
        self.set_theme(theme)

    def set_theme(self, theme: str):
        self.theme = "ice" if theme in ("ice", "light", "white") else "navy"
        if self.theme == "navy":
            self.fg, self.accent, self.muted = hex_rgb("#FFFFFF"), hex_rgb(self.turq2), hex_rgb("#9DB4C8")
            self.card_fill, self.card_line = hex_rgb(self.navy2, 225), (255, 255, 255, 34)
        else:
            self.fg, self.accent, self.muted = hex_rgb(self.navy), hex_rgb("#0FA8A0"), hex_rgb("#5B7287")
            self.card_fill, self.card_line = (255, 255, 255, 240), (11, 30, 58, 22)

    # --- units ---------------------------------------------------------------
    def u(self, v: float) -> int:  # design px (1080-wide) -> output px
        return int(round(v * self.s))

    def f(self, fam: str, weight: str, size: float):
        return pil_font(fam, weight, max(6, int(size * self.s * SS)))

    def canvas(self, w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
        im = Image.new("RGBA", (max(1, w * SS), max(1, h * SS)), (0, 0, 0, 0))
        return im, ImageDraw.Draw(im)

    def add(self, comp: Composite, im_ss: Image.Image, x: int, y: int, delay: float = 0.0, anim: str = "rise",
            until: float | None = None, shadow: bool = False, dur_in: float = 0.45) -> Layer:
        im = im_ss.resize((max(1, im_ss.width // SS), max(1, im_ss.height // SS)), Image.LANCZOS)
        if shadow:
            pad = self.u(26)
            out = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
            a = im.split()[3].point(lambda v: int(v * (0.30 if self.theme == "ice" else 0.5)))
            sh = Image.new("RGBA", im.size, (6, 20, 40, 255))
            sh.putalpha(a)
            out.paste(sh, (pad, pad + pad // 3), sh)
            out = out.filter(ImageFilter.GaussianBlur(pad * 0.45))
            out.alpha_composite(im, (pad, pad))
            im, x, y = out, x - pad, y - pad
        self.n += 1
        p = self.out / f"{self.gid}_L{self.n:02d}.png"
        im.save(p)
        layer = Layer(p, int(x), int(y), im.width, im.height, delay, anim, until, dur_in)
        comp.layers.append(layer)
        return layer

    # --- text ----------------------------------------------------------------
    def _measure(self, d, txt, font, tracking):
        if not tracking:
            return d.textlength(txt, font=font)
        return sum(d.textlength(ch, font=font) for ch in txt) + tracking * max(0, len(txt) - 1)

    def _draw(self, d, xy, txt, font, fill, tracking):
        if not tracking:
            d.text(xy, txt, font=font, fill=fill)
            return
        x, y = xy
        for ch in txt:
            d.text((x, y), ch, font=font, fill=fill)
            x += d.textlength(ch, font=font) + tracking

    def text(self, markup: str, fam: str, weight: str, size: float, color=None, accent=None, max_w: int | None = None,
             align: str = "center", line_h: float = 1.12, tracking: float = 0.0, upper: bool = False) -> Image.Image:
        """Render (possibly multi-line, accent-marked) text into a supersampled RGBA image."""
        color = color or self.fg
        accent = accent or self.accent
        font = self.f(fam, weight, size)
        trk = tracking * self.s * SS
        d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        max_px = (max_w or self.W) * SS
        lines: list[list[tuple[str, bool]]] = []
        for raw in str(markup).split("\n"):
            toks, acc = [], False
            for i, part in enumerate(raw.split("*")):
                if i > 0:
                    acc = not acc
                for w in part.split():
                    toks.append((w.upper() if upper else w, acc))
            cur: list[tuple[str, bool]] = []
            for t in toks:
                trial = cur + [t]
                if cur and self._measure(d0, " ".join(x[0] for x in trial), font, trk) > max_px:
                    lines.append(cur)
                    cur = [t]
                else:
                    cur = trial
            lines.append(cur)
        space = d0.textlength(" ", font=font) + trk
        widths = [sum(self._measure(d0, t, font, trk) for t, _ in ln) + space * max(0, len(ln) - 1) for ln in lines]
        asc, desc = font.getmetrics()
        lh = int((asc + desc) * line_h)
        W = int(max(widths + [1])) + SS * 4
        H = lh * len(lines) + SS * 4
        im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for i, ln in enumerate(lines):
            x = {"center": (W - widths[i]) / 2, "left": 0, "right": W - widths[i]}[align]
            for t, acc in ln:
                self._draw(d, (x, i * lh), t, font, accent if acc else color, trk)
                x += self._measure(d0, t, font, trk) + space
        return im

    def text_lines(self, markup: str, fam: str, weight: str, size: float, **kw) -> list[Image.Image]:
        return [self.text(ln, fam, weight, size, **kw) for ln in str(markup).split("\n") if ln.strip()]

    # --- shapes --------------------------------------------------------------
    def pill(self, label: str, fill, color, size: float = 26, icon: str | None = None, icon_bg=None, icon_color=None,
             pad_x: float = 26, pad_y: float = 14, tracking: float = 1.5, weight: str = "Bold", outline=None) -> Image.Image:
        t = self.text(label, self.body, weight, size, color=color, accent=color, tracking=tracking, upper=True)
        ir = int(t.height * 0.62) if icon else 0
        px, py = int(pad_x * self.s * SS), int(pad_y * self.s * SS)
        w = t.width + 2 * px + (ir * 2 + px // 2 if icon else 0)
        h = max(t.height, ir * 2) + 2 * py
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=min(h // 2, int(18 * self.s * SS)), fill=fill,
                            outline=outline, width=max(1, SS) if outline else 0)
        x = px
        if icon:
            draw_icon(d, icon, x + ir, h // 2, ir, icon_color or (255, 255, 255, 255), bg=icon_bg)
            x += ir * 2 + px // 2
        im.alpha_composite(t, (x, (h - t.height) // 2 + SS))
        return im

    def card(self, w: int, h: int, fill=None, radius: float = 26, line=None) -> tuple[Image.Image, ImageDraw.ImageDraw]:
        im, d = self.canvas(w, h)
        d.rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), int(radius * self.s * SS), fill=fill or self.card_fill,
                            outline=line or self.card_line, width=max(1, int(1.5 * SS)))
        return im, d

    # --- backgrounds -----------------------------------------------------------
    def background(self) -> Path:
        p = self.out / f"bg_{self.theme}_{self.W}x{self.H}.png"
        if p.exists():
            return p
        W, H = self.W, self.H
        im = Image.new("RGBA", (W, H))
        d = ImageDraw.Draw(im)
        if self.theme == "navy":
            top, bot = hex_rgb(self.navy), hex_rgb("#0A2A45")
        else:
            top, bot = hex_rgb("#F7FCFE"), hex_rgb("#D8EEF6")
        for y in range(H):
            f = y / max(1, H - 1)
            d.line([(0, y), (W, y)], fill=tuple(int(top[i] * (1 - f) + bot[i] * f) for i in range(3)) + (255,))
        def soft(color, alpha_shape, blur, strength=1.0):
            m = Image.new("L", (W, H), 0)
            alpha_shape(ImageDraw.Draw(m))
            m = m.filter(ImageFilter.GaussianBlur(blur))
            if strength != 1.0:
                m = m.point(lambda v: int(v * strength))
            layer = Image.new("RGBA", (W, H), tuple(color[:3]) + (255,))
            layer.putalpha(m)
            im.alpha_composite(layer)
        if self.theme == "navy":
            soft(hex_rgb(self.turq), lambda g: g.ellipse((W * 0.35, -H * 0.15, W * 1.35, H * 0.45), fill=70), W * 0.18)
            soft(hex_rgb(self.turq), lambda g: g.ellipse((-W * 0.5, H * 0.65, W * 0.6, H * 1.25), fill=45), W * 0.18)
            import random
            rnd = random.Random(7)
            dm = Image.new("L", (W, H), 0)
            dd = ImageDraw.Draw(dm)
            for _ in range(60):
                x, y, r = rnd.random() * W, rnd.random() * H, rnd.uniform(1, 3.5) * self.s
                dd.ellipse((x - r, y - r, x + r, y + r), fill=rnd.randint(25, 70))
            dots = Image.new("RGBA", (W, H), (170, 235, 240, 255))
            dots.putalpha(dm.filter(ImageFilter.GaussianBlur(1)))
            im.alpha_composite(dots)
        else:
            def wave(yb, amp, k, up):
                def f(g):
                    pts = [(x, H * yb + math.sin(x / W * math.pi * 2 + k) * H * amp) for x in range(0, W + 20, 20)]
                    g.polygon(pts + ([(W, 0), (0, 0)] if up else [(W, H), (0, H)]), fill=255)
                return f
            soft((255, 255, 255), wave(0.22, 0.03, 0.5, True), W * 0.06)
            soft(hex_rgb(self.turq), wave(0.86, 0.025, 1.0, False), W * 0.08, strength=0.3)
            soft((255, 255, 255), lambda g: g.ellipse((-W * 0.3, H * 0.35, W * 1.3, H * 0.75), fill=110), W * 0.2)
        im.convert("RGB").save(p)
        return p


# ---------------------------------------------------------------------------
# Full-screen scenes
# ---------------------------------------------------------------------------
def _title_block(b: Builder, comp: Composite, p: dict, y: int, delay: float = 0.15, size: float = 92) -> int:
    """Kicker + accent-marked multi-line headline (each line its own layer). Returns next y."""
    maxw = int(b.W * 0.86)
    if p.get("kicker"):
        k = b.text(p["kicker"], b.body, "Bold", 28, color=b.muted if b.theme == "navy" else b.fg, tracking=3, upper=True,
                   max_w=maxw)
        b.add(comp, k, (b.W - k.width // SS) // 2, y, delay, "fade")
        y += k.height // SS + b.u(18)
        delay += 0.1
    for ln in b.text_lines(p.get("title", ""), b.head, "ExtraBold", size, upper=True, max_w=maxw, line_h=1.04):
        b.add(comp, ln, (b.W - ln.width // SS) // 2, y, delay, "rise")
        y += ln.height // SS - b.u(6)
        delay += 0.12
    return y + b.u(18)


def scene_headline(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite(fullscreen=True, background=b.background())
    if p.get("decor") == "cards":
        _decor_cards(b, comp)
    big = p.get("big")
    est = (180 if big else 0) + 110 * len(str(p.get("title", "")).split("\n")) + 120
    y = int(b.H * 0.42) - b.u(est) // 2
    y = _title_block(b, comp, p, y, size=p.get("size", 96))
    delay = 0.2 + 0.12 * len(str(p.get("title", "")).split("\n"))
    if big:
        bi = b.text(f"*{big}*", b.head, "ExtraBold", p.get("big_size", 200), upper=True)
        b.add(comp, bi, (b.W - bi.width // SS) // 2, y - b.u(20), delay, "rise", dur_in=0.55)
        y += bi.height // SS - b.u(10)
        delay += 0.2
    if p.get("subtitle"):
        st = b.text(p["subtitle"], b.head, "ExtraBold" if big else "SemiBold", 44 if big else 38, upper=bool(big),
                    max_w=int(b.W * 0.84))
        b.add(comp, st, (b.W - st.width // SS) // 2, y, delay, "rise")
        y += st.height // SS + b.u(26)
        delay += 0.15
    if p.get("tag"):
        if p.get("tag_style") == "text":
            tg = b.text(f"*{p['tag']}*", b.body, "Bold", 30, tracking=2, upper=True)
        else:
            tg = b.pill(p["tag"], hex_rgb(b.turq), hex_rgb(b.navy), size=22, icon=p.get("tag_icon"),
                        icon_color=hex_rgb(b.navy))
        b.add(comp, tg, (b.W - tg.width // SS) // 2, y, delay + 0.1, "fade")
    return comp


def _decor_cards(b: Builder, comp: Composite):
    """Soft floating cards around the headline (hook-scene decoration)."""
    spots = [(0.06, 0.12, -8), (0.70, 0.08, 7), (0.02, 0.40, 6), (0.76, 0.38, -6), (0.08, 0.66, -5), (0.72, 0.66, 8)]
    icons = ["drop", "sparkle", "drop", "sparkle", "drop", "sparkle"]
    for k, (fx, fy, rot) in enumerate(spots):
        w, h = b.u(230), b.u(300)
        im, d = b.card(w, h, fill=(255, 255, 255, 34 if b.theme == "navy" else 150), radius=30, line=(255, 255, 255, 50))
        draw_icon(d, icons[k], im.width // 2, im.height // 2 - h * SS // 8, int(h * SS * 0.13), (255, 255, 255, 150))
        for j in range(2):
            d.rounded_rectangle((w * SS * 0.15, h * SS * (0.68 + j * 0.1), w * SS * (0.85 - j * 0.2), h * SS * (0.72 + j * 0.1)),
                                SS * 4, fill=(255, 255, 255, 90))
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
        b.add(comp, im, int(b.W * fx), int(b.H * fy), 0.05 * k, "fade", dur_in=0.8)


def _phone_frame(b: Builder, ph: int) -> tuple[Image.Image, tuple[int, int, int, int], int]:
    """Phone body at SS scale with a transparent screen. Returns (image, screen box (ss px), screen radius)."""
    pw = int(ph * 0.49)
    im, d = b.canvas(pw, ph)
    W, H = pw * SS, ph * SS
    r = int(W * 0.15)
    d.rounded_rectangle((0, 0, W - 1, H - 1), r, fill=(16, 20, 28, 255))
    d.rounded_rectangle((SS * 2, SS * 2, W - SS * 3, H - SS * 3), r - SS * 2, outline=(110, 122, 140, 255), width=SS * 2)
    bz = int(W * 0.04)
    box = (bz, bz, W - bz, H - bz)
    sr = r - bz
    hole = Image.new("L", im.size, 0)
    ImageDraw.Draw(hole).rounded_rectangle(box, sr, fill=255)
    a = im.split()[3]
    im.putalpha(Image.composite(Image.new("L", im.size, 0), a, hole))
    di = ImageDraw.Draw(im)
    di.rounded_rectangle((W / 2 - W * 0.14, bz + SS * 10, W / 2 + W * 0.14, bz + SS * 10 + W * 0.075), SS * 20,
                         fill=(16, 20, 28, 255))
    return im, box, sr


def _screen(b: Builder, size: tuple[int, int], radius: int, p: dict) -> list[tuple[Image.Image, int, int, float]]:
    """Phone screen UI. Returns pieces [(img_ss, x_ss, y_ss, delay)], the first one being the base screen."""
    Wss, Hss = size
    u = Wss / 100.0
    base = Image.new("RGBA", size, (244, 250, 252, 255))
    d = ImageDraw.Draw(base)
    pieces: list[tuple[Image.Image, int, int, float]] = []
    ui = p.get("ui", "booking")
    navy, turq = hex_rgb(b.navy), hex_rgb(b.turq)

    def font(w, s):
        return pil_font(b.body, w, max(6, int(s * u)))

    if ui == "booking":
        d.rectangle((0, 0, Wss, 34 * u), fill=turq)
        d.ellipse((7 * u, 12 * u, 23 * u, 28 * u), fill=(255, 255, 255, 255))
        draw_icon(d, "user", 15 * u, 20 * u, 6 * u, navy)
        d.text((27 * u, 13 * u), p.get("header", "Online Consultation"), font=font("Bold", 5.4), fill=(255, 255, 255, 255))
        d.text((27 * u, 21 * u), p.get("subheader", "Consultant Dermatologist"), font=font("Medium", 4.2), fill=(220, 250, 248, 255))
        d.rounded_rectangle((6 * u, 38 * u, Wss - 6 * u, 48 * u), 3 * u, fill=(255, 255, 255, 255), outline=(220, 230, 236, 255))
        draw_icon(d, "video", 11 * u, 43 * u, 3.2 * u, turq)
        d.text((17 * u, 40.5 * u), p.get("row", "One-to-One Video Call"), font=font("SemiBold", 4.3), fill=navy)
        d.text((7 * u, 52 * u), "Select a date", font=font("Bold", 4.6), fill=navy)
        days = "M T W T F S S".split()
        for i, dd in enumerate(days):
            d.text((9 * u + i * 12.5 * u, 60 * u), dd, font=font("Medium", 3.6), fill=(120, 135, 150, 255))
        sel = int(p.get("selected_day", 12))
        for wk in range(3):
            for i in range(7):
                n = 1 + wk * 7 + i
                cx, cy = 10.5 * u + i * 12.5 * u, 70 * u + wk * 9 * u
                if n == sel:
                    d.ellipse((cx - 4 * u, cy - 4 * u, cx + 4 * u, cy + 4 * u), fill=turq)
                d.text((cx - 2.2 * u * len(str(n)) / 2 - 0.5 * u, cy - 2.6 * u), str(n), font=font("SemiBold", 4.0),
                       fill=(255, 255, 255, 255) if n == sel else navy)
        for i, slot in enumerate(p.get("slots", ["10:00 AM", "4:30 PM", "7:00 PM"])[:3]):
            x = 6 * u + i * 30 * u
            d.rounded_rectangle((x, 98 * u, x + 27 * u, 105 * u), 3 * u, fill=turq if i == 1 else (255, 255, 255, 255),
                                outline=(210, 225, 232, 255))
            d.text((x + 3 * u, 99.5 * u), slot, font=font("SemiBold", 3.6), fill=(255, 255, 255, 255) if i == 1 else navy)
        pieces.append((base, 0, 0, 0.0))
        btn_y = Hss - 26 * u
        for k, (label, col, dl) in enumerate(((p.get("button", "Book Consultation"), navy, 0.0),
                                              (p.get("booked_label", "Booked ✓"), turq, 1.3))):
            if k == 1 and not p.get("booked", True):
                break
            bt = Image.new("RGBA", (int(Wss - 12 * u), int(11 * u)), (0, 0, 0, 0))
            bd = ImageDraw.Draw(bt)
            bd.rounded_rectangle((0, 0, bt.width - 1, bt.height - 1), int(5.5 * u), fill=col)
            fnt = font("Bold", 4.6)
            bd.text(((bt.width - bd.textlength(label, font=fnt)) / 2, 2.6 * u), label, font=fnt, fill=(255, 255, 255, 255))
            pieces.append((bt, int(6 * u), int(btn_y), dl))
    elif ui == "chat":
        d.rectangle((0, 0, Wss, 30 * u), fill=navy)
        d.text((7 * u, 14 * u), p.get("header", "Patient Messages"), font=font("Bold", 5.2), fill=(255, 255, 255, 255))
        cnt = str(p.get("badge", ""))
        if cnt:
            d.rounded_rectangle((68 * u, 13.5 * u, 80 * u, 20.5 * u), 3.5 * u, fill=turq)
            d.text((70 * u, 14.3 * u), cnt, font=font("Bold", 4.2), fill=(255, 255, 255, 255))
        pieces.append((base, 0, 0, 0.0))
        y = 36 * u
        for i, msg in enumerate(p.get("messages", [])[:5]):
            fnt = font("Medium", 5.4)
            lines, cur = [], ""
            for w in str(msg).split():
                t = (cur + " " + w).strip()
                if ImageDraw.Draw(base).textlength(t, font=fnt) > 60 * u and cur:
                    lines.append(cur)
                    cur = w
                else:
                    cur = t
            lines.append(cur)
            bh = int((len(lines) * 7.4 + 5) * u)
            bw = int(min(72 * u, max(ImageDraw.Draw(base).textlength(x, font=fnt) for x in lines) + 8 * u))
            bub = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
            bd = ImageDraw.Draw(bub)
            bd.rounded_rectangle((0, 0, bw - 1, bh - 1), int(3.5 * u), fill=(255, 255, 255, 255), outline=(215, 226, 233, 255))
            for j, ln in enumerate(lines):
                bd.text((4 * u, 2.5 * u + j * 7.4 * u), ln, font=fnt, fill=navy)
            pieces.append((bub, int(6 * u), int(y), 0.5 + 0.55 * i))
            y += bh + 3 * u
        if p.get("typing", True):
            ty = Image.new("RGBA", (int(16 * u), int(7 * u)), (0, 0, 0, 0))
            td = ImageDraw.Draw(ty)
            td.rounded_rectangle((0, 0, ty.width - 1, ty.height - 1), int(3.5 * u), fill=(255, 255, 255, 255))
            for k in range(3):
                td.ellipse((3 * u + k * 4 * u, 2.6 * u, 5 * u + k * 4 * u, 4.6 * u), fill=(140, 155, 170, 255))
            pieces.append((ty, int(6 * u), int(y), 0.5 + 0.55 * len(p.get("messages", [])[:5])))
    elif ui == "video_call":
        base = Image.new("RGBA", size, (0, 0, 0, 0))  # transparent: real footage shows through
        pieces.append((base, 0, 0, 0.0))
        live = Image.new("RGBA", (int(22 * u), int(8 * u)), (0, 0, 0, 0))
        ld = ImageDraw.Draw(live)
        ld.rounded_rectangle((0, 0, live.width - 1, live.height - 1), int(4 * u), fill=(10, 15, 25, 170))
        ld.ellipse((2.5 * u, 2.5 * u, 5.5 * u, 5.5 * u), fill=(255, 70, 70, 255))
        ld.text((7 * u, 1.4 * u), p.get("live_label", "LIVE 00:15"), font=font("Bold", 3.8), fill=(255, 255, 255, 255))
        pieces.append((live, int(7 * u), int(16 * u), 0.3))
        me = Image.new("RGBA", (int(24 * u), int(32 * u)), (0, 0, 0, 0))
        md = ImageDraw.Draw(me)
        md.rounded_rectangle((0, 0, me.width - 1, me.height - 1), int(4 * u), fill=(200, 225, 235, 255),
                             outline=(255, 255, 255, 255), width=max(1, int(0.6 * u)))
        draw_icon(md, "user", me.width / 2, me.height / 2, 7 * u, (110, 140, 160, 255))
        pieces.append((me, int(Wss - 30 * u), int(Hss - 66 * u), 0.5))
        end = Image.new("RGBA", (int(16 * u), int(16 * u)), (0, 0, 0, 0))
        ImageDraw.Draw(end).ellipse((0, 0, end.width - 1, end.height - 1), fill=(240, 70, 70, 255))
        pieces.append((end, int((Wss - 16 * u) / 2), int(Hss - 26 * u), 0.6))
    else:  # list
        d.rectangle((0, 0, Wss, 30 * u), fill=navy)
        d.text((7 * u, 14 * u), p.get("header", ""), font=font("Bold", 5.2), fill=(255, 255, 255, 255))
        pieces.append((base, 0, 0, 0.0))
        for i, it in enumerate(p.get("items", [])[:5]):
            row = Image.new("RGBA", (int(Wss - 12 * u), int(14 * u)), (0, 0, 0, 0))
            rd = ImageDraw.Draw(row)
            rd.rounded_rectangle((0, 0, row.width - 1, row.height - 1), int(3.5 * u), fill=(255, 255, 255, 255))
            draw_icon(rd, "check", 7 * u, 7 * u, 3.6 * u, (255, 255, 255, 255), bg=turq)
            rd.text((14 * u, 4 * u), str(it), font=font("SemiBold", 4.4), fill=navy)
            pieces.append((row, int(6 * u), int(36 * u + i * 17 * u), 0.4 + 0.35 * i))
    return pieces


def scene_phone(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite(fullscreen=True, background=b.background())
    y = _title_block(b, comp, p, int(b.H * 0.07), size=p.get("size", 54)) if (p.get("title") or p.get("kicker")) else int(b.H * 0.1)
    ph = int(b.H * (0.44 if b.vertical else 0.62))
    pw = int(ph * 0.49)
    px = (b.W - pw) // 2
    py = max(y + b.u(10), int(b.H * 0.44) - ph // 2)
    frame, box, sr = _phone_frame(b, ph)
    sw, sh = box[2] - box[0], box[3] - box[1]
    delay = 0.35
    pieces = _screen(b, (sw, sh), sr, p)
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), sr, fill=255)
    screen_base = pieces[0][0]
    screen_base.putalpha(Image.composite(screen_base.split()[3], Image.new("L", (sw, sh), 0), mask))
    phone_img = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    phone_img.alpha_composite(screen_base, (box[0], box[1]))
    phone_img.alpha_composite(frame)
    if p.get("ui") == "video_call" and p.get("video"):
        v = p["video"]
        comp.inset = {"asset_id": v["asset_id"], "src_in": float(v.get("src_in", 0)),
                      "x": px + box[0] // SS, "y": py + box[1] // SS, "w": sw // SS, "h": sh // SS, "radius": sr // SS,
                      "delay": delay}
    b.add(comp, phone_img, px, py, delay, "rise", shadow=True, dur_in=0.55)
    for img, x, yy, dl in pieces[1:]:
        b.add(comp, img, px + (box[0] + x) // SS, py + (box[1] + yy) // SS, delay + 0.35 + dl, "rise")
    # floating side icons
    icons = p.get("side_icons", [])
    for i, ic in enumerate(icons[:4]):
        r = b.u(40)
        im, d = b.canvas(2 * r, 2 * r)
        d.ellipse((0, 0, 2 * r * SS - 1, 2 * r * SS - 1), fill=(255, 255, 255, 245) if b.theme == "ice" else hex_rgb(b.navy2, 240),
                  outline=hex_rgb(b.turq, 120), width=SS * 2)
        draw_icon(d, ic, r * SS, r * SS, int(r * SS * 0.55), hex_rgb(b.turq))
        left = i % 2 == 0
        ix = px - b.u(120) if left else px + pw + b.u(40)
        iy = py + int(ph * (0.25 + 0.3 * (i // 2)))
        b.add(comp, im, ix, iy, delay + 0.6 + 0.15 * i, "slide_left" if left else "slide_right", shadow=True)
    # tags / caption under the phone
    ty = py + ph + b.u(30)
    tags = p.get("tags", [])
    if tags:
        imgs = [b.pill(t, hex_rgb(b.turq), (255, 255, 255, 255), size=24) for t in tags[:4]]
        rows, cur, cw = [], [], 0
        for im in imgs:
            w = im.width // SS + b.u(14)
            if cur and cw + w > b.W * 0.86:
                rows.append(cur)
                cur, cw = [], 0
            cur.append(im)
            cw += w
        rows.append(cur)
        k = 0
        for row in rows:
            tw = sum(im.width // SS + b.u(14) for im in row) - b.u(14)
            x = (b.W - tw) // 2
            for im in row:
                b.add(comp, im, x, ty, delay + 1.0 + 0.25 * k, "pop")
                x += im.width // SS + b.u(14)
                k += 1
            ty += row[0].height // SS + b.u(12)
    if p.get("tag"):
        tg = b.pill(p["tag"], hex_rgb(b.turq), hex_rgb(b.navy), size=20, icon=p.get("tag_icon", "clock"),
                    icon_color=hex_rgb(b.navy))
        b.add(comp, tg, (b.W - tg.width // SS) // 2, ty, delay + 1.2, "fade")
    return comp


def scene_flow(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite(fullscreen=True, background=b.background())
    y = _title_block(b, comp, p, int(b.H * 0.2), size=p.get("size", 52)) + b.u(30)
    rows = p.get("rows", [])
    delay = 0.5
    for r in rows[:4]:
        lw, rw, h = b.u(330), b.u(330), b.u(130)
        left, ld = b.card(lw, h, fill=(255, 255, 255, 250), line=(11, 30, 58, 25), radius=20)
        draw_icon(ld, r.get("icon", "chat"), int(50 * b.s * SS), h * SS // 2, int(26 * b.s * SS), hex_rgb(b.turq))
        lt = b.text(r.get("from", ""), b.body, "Bold", 24, color=hex_rgb(b.navy), upper=True, max_w=lw - b.u(110), align="left")
        left.alpha_composite(lt, (int(95 * b.s * SS), (h * SS - lt.height) // 2))
        style = r.get("style", "accent")
        fill = hex_rgb(b.turq) if style == "accent" else hex_rgb(b.navy)
        right, rd = b.card(rw, h, fill=fill, line=(0, 0, 0, 0), radius=20)
        size = 48 if len(r.get("to", "")) <= 6 else 26
        rt = b.text(r.get("to", ""), b.head, "ExtraBold", size, color=(255, 255, 255, 255), upper=True, max_w=rw - b.u(40))
        right.alpha_composite(rt, ((rw * SS - rt.width) // 2, (h * SS - rt.height) // 2))
        arrow, ad = b.canvas(b.u(90), h)
        ad.line([(10 * SS * b.s, h * SS / 2), (70 * SS * b.s, h * SS / 2)], fill=b.fg, width=int(5 * SS * b.s))
        ad.polygon([(80 * SS * b.s, h * SS / 2), (60 * SS * b.s, h * SS / 2 - 14 * SS * b.s),
                    (60 * SS * b.s, h * SS / 2 + 14 * SS * b.s)], fill=b.fg)
        total = lw + b.u(90) + rw
        x0 = (b.W - total) // 2
        b.add(comp, left, x0, y, delay, "slide_left", shadow=True)
        b.add(comp, arrow, x0 + lw, y, delay + 0.25, "fade")
        b.add(comp, right, x0 + lw + b.u(90), y, delay + 0.45, "slide_right", shadow=True)
        y += h + b.u(70)
        delay += 0.9
    if p.get("note"):
        nt = b.text(p["note"], b.body, "Medium", 26, color=b.muted)
        b.add(comp, nt, (b.W - nt.width // SS) // 2, y - b.u(30), delay, "fade")
    return comp


def scene_steps(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite(fullscreen=True, background=b.background())
    items = p.get("items", [])[:5]
    y = int(b.H * 0.2)
    if p.get("title") and p.get("title_position", "bottom") == "top":
        y = _title_block(b, comp, p, int(b.H * 0.12), size=p.get("size", 64))
    cw, ch = int(b.W * 0.82), b.u(176)
    delay = 0.2
    for i, it in enumerate(items):
        it = it if isinstance(it, dict) else {"title": str(it)}
        im, d = b.card(cw, ch, radius=24)
        r = int(36 * b.s * SS)
        draw_icon(d, it.get("icon", "check"), int(70 * b.s * SS), ch * SS // 2, r, hex_rgb(b.navy), bg=hex_rgb(b.turq2))
        num = b.text(f"{i + 1:02d}", b.body, "Bold", 26, color=b.muted, align="left")
        tt = b.text(it.get("title", ""), b.body, "ExtraBold", 38, upper=True, align="left", max_w=cw - b.u(170))
        tx = int(130 * b.s * SS)
        ty = (ch * SS - num.height - tt.height) // 2
        im.alpha_composite(num, (tx, ty))
        im.alpha_composite(tt, (tx, ty + num.height))
        b.add(comp, im, (b.W - cw) // 2, y, delay, "slide_left", shadow=True)
        y += ch + b.u(26)
        delay += float(p.get("stagger", 0.45))
    if p.get("title") and p.get("title_position", "bottom") != "top":
        y = _title_block(b, comp, {"title": p["title"]}, y + b.u(40), delay, size=p.get("size", 60))
        if p.get("tag"):
            tg = b.text(p["tag"], b.body, "Bold", 22, color=b.muted, tracking=2, upper=True)
            b.add(comp, tg, (b.W - tg.width // SS) // 2, y - b.u(6), delay + 0.3, "fade")
    return comp


def scene_icons(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite(fullscreen=True, background=b.background())
    focus = p.get("focus")
    if focus:
        y = int(b.H * 0.2)
        t = b.text(focus.get("label", ""), b.head, "ExtraBold", 64, upper=True, max_w=int(b.W * 0.92))
        b.add(comp, t, (b.W - t.width // SS) // 2, y, 0.1, "rise")
        y += t.height // SS + b.u(6)
        if focus.get("sub"):
            st = b.text(focus["sub"], b.body, "Medium", 26, color=b.muted)
            b.add(comp, st, (b.W - st.width // SS) // 2, y, 0.25, "fade")
            y += st.height // SS
        r = b.u(240)
        cy = y + b.u(90) + r
        im, d = b.canvas(2 * r, 2 * r)
        d.ellipse((0, 0, 2 * r * SS - 1, 2 * r * SS - 1), fill=hex_rgb(b.navy2, 200), outline=hex_rgb(b.turq, 200), width=SS * 3)
        draw_icon(d, focus.get("icon", "home"), r * SS, r * SS, int(r * SS * 0.5), (255, 255, 255, 255))
        b.add(comp, im, (b.W - 2 * r) // 2, cy - r, 0.3, "rise", dur_in=0.6)
        for k, ic in enumerate(focus.get("satellites", [])[:2]):
            sr = b.u(52)
            si, sd = b.canvas(2 * sr, 2 * sr)
            sd.ellipse((0, 0, 2 * sr * SS - 1, 2 * sr * SS - 1), fill=hex_rgb(b.turq))
            draw_icon(sd, ic, sr * SS, sr * SS, int(sr * SS * 0.55), (255, 255, 255, 255))
            sx = (b.W // 2 - r - sr // 2) if k == 0 else (b.W // 2 + r - int(1.5 * sr))
            b.add(comp, si, sx, cy - r - sr // 2, 0.6 + 0.15 * k, "pop")
        y = cy + r + b.u(60)
    else:
        y = _title_block(b, comp, {"kicker": p.get("kicker")}, int(b.H * 0.2), size=40) if p.get("kicker") else int(b.H * 0.22)
        items = p.get("items", [])[:4]
        tw, gap = b.u(270), b.u(28)
        x = (b.W - (len(items) * tw + (len(items) - 1) * gap)) // 2
        for k, it in enumerate(items):
            im, d = b.card(tw, tw, radius=24)
            draw_icon(d, it.get("icon", "home"), tw * SS // 2, int(tw * SS * 0.42), int(tw * SS * 0.17), b.fg)
            lt = b.text(it.get("label", ""), b.body, "Bold", 26, upper=True, max_w=tw - b.u(20))
            im.alpha_composite(lt, ((tw * SS - lt.width) // 2, int(tw * SS * 0.7)))
            b.add(comp, im, x, y, 0.2 + 0.15 * k, "rise", shadow=True)
            x += tw + gap
        y += tw + b.u(60)
        if p.get("title"):
            y = _title_block(b, comp, {"title": p["title"]}, y, 0.8, size=p.get("size", 52))
    tags = p.get("tags", [])
    for k, t in enumerate(tags[:4]):
        tg = b.pill(t, hex_rgb(b.turq), (255, 255, 255, 255), size=26)
        b.add(comp, tg, (b.W - tg.width // SS) // 2, y, 0.9 + 0.25 * k, "pop")
        y += tg.height // SS + b.u(12)
    return comp


def scene_cards(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite(fullscreen=True, background=b.background())
    y = _title_block(b, comp, p, int(b.H * 0.24), size=p.get("size", 64)) + b.u(20)
    cards = p.get("cards", [])[:3]
    cw, ch, gap = b.u(290), b.u(380), b.u(24)
    x = (b.W - (len(cards) * cw + (len(cards) - 1) * gap)) // 2
    import random
    for k, c in enumerate(cards):
        c = c if isinstance(c, dict) else {"label": str(c)}
        im, d = b.card(cw, ch, fill=(255, 255, 255, 250), line=(11, 30, 58, 20), radius=22)
        r = int(cw * SS * 0.3)
        cx, cy = cw * SS // 2, int(ch * SS * 0.3)
        col = hex_rgb(c.get("color", ["#D9A37E", "#E8B894", "#C8865F"][k % 3]))
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col, outline=(255, 255, 255, 255), width=SS * 3)
        rnd = random.Random(k)
        for _ in range(c.get("dots", [10, 0, 4][k % 3])):
            a, rr = rnd.random() * 6.28, rnd.random() * r * 0.75
            dx, dy = cx + math.cos(a) * rr, cy + math.sin(a) * rr
            d.ellipse((dx - SS * 4, dy - SS * 4, dx + SS * 4, dy + SS * 4), fill=(160, 70, 60, 170))
        lt = b.text(c.get("label", ""), b.body, "ExtraBold", 30, color=hex_rgb(b.navy), upper=True, max_w=cw - b.u(20))
        im.alpha_composite(lt, ((cw * SS - lt.width) // 2, int(ch * SS * 0.6)))
        for j, val in enumerate(c.get("bars", [0.7, 0.4])[:2]):
            by = int(ch * SS * (0.78 + j * 0.08))
            d.rounded_rectangle((cw * SS * 0.12, by, cw * SS * 0.88, by + SS * 7), SS * 4, fill=(225, 235, 240, 255))
            d.rounded_rectangle((cw * SS * 0.12, by, cw * SS * (0.12 + 0.76 * float(val)), by + SS * 7), SS * 4,
                                fill=hex_rgb(b.turq))
        b.add(comp, im, x, y, 0.5 + 0.2 * k, "rise", shadow=True)
        x += cw + gap
    if p.get("note"):
        nt = b.text(p["note"], b.body, "SemiBold", 26, color=hex_rgb("#0FA8A0") if b.theme == "ice" else b.accent)
        b.add(comp, nt, (b.W - nt.width // SS) // 2, y + ch + b.u(36), 1.3, "fade")
    return comp


def scene_cta(b: Builder, p: dict, project=None) -> Composite:
    b.set_theme("ice")
    comp = Composite(fullscreen=True, background=b.background())
    r = b.u(175)
    y_k = int(b.H * 0.05)
    k = b.text(p.get("kicker", "ONLINE CONSULTATION"), b.body, "Bold", 28, color=(255, 255, 255, 255), tracking=3, upper=True)
    y_photo = y_k + k.height // SS + b.u(26)
    band_h = y_photo + r + b.u(40)
    band, bd = b.canvas(b.W, band_h)
    Wss, Hss = band.size
    teal = hex_rgb("#0E9C96")
    bd.rectangle((0, 0, Wss, Hss - int(90 * b.s * SS)), fill=teal)
    bd.ellipse((-Wss * 0.3, Hss - int(180 * b.s * SS), Wss * 1.3, Hss), fill=teal)
    b.add(comp, band, 0, 0, 0.0, "drop", dur_in=0.5)
    b.add(comp, k, (b.W - k.width // SS) // 2, y_k, 0.2, "fade")
    photo = _photo_circle(project, p["photo"], 2 * r) if (p.get("photo") and project is not None) else None
    circ, cd = b.canvas(2 * r, 2 * r)
    cd.ellipse((0, 0, 2 * r * SS - 1, 2 * r * SS - 1), fill=(255, 255, 255, 255))
    if photo is not None:
        circ.alpha_composite(photo.resize((2 * r * SS - 10 * SS, 2 * r * SS - 10 * SS), Image.LANCZOS), (5 * SS, 5 * SS))
    else:
        draw_icon(cd, "user", r * SS, r * SS, int(r * SS * 0.6), hex_rgb(b.turq))
    b.add(comp, circ, (b.W - 2 * r) // 2, y_photo, 0.35, "rise", shadow=True, dur_in=0.55)
    y = y_photo + 2 * r + b.u(46)
    for i, ln in enumerate(b.text_lines(p.get("headline", ""), b.head, "ExtraBold", p.get("size", 58), upper=True,
                                        max_w=int(b.W * 0.92), line_h=1.05)):
        b.add(comp, ln, (b.W - ln.width // SS) // 2, y, 0.55 + 0.1 * i, "rise")
        y += ln.height // SS - b.u(6)
    y += b.u(20)
    for i, cl in enumerate(p.get("credentials", [])[:2]):
        t = b.text(cl, b.body, "Bold" if i == 0 else "SemiBold", 26 if i == 0 else 22,
                   color=hex_rgb("#0FA8A0") if i == 0 else b.muted, tracking=2, upper=True)
        b.add(comp, t, (b.W - t.width // SS) // 2, y, 0.8 + 0.1 * i, "fade")
        y += t.height // SS + b.u(4)
    y += b.u(40)
    if p.get("button"):
        bt = b.pill(p["button"], hex_rgb("#11B5AD"), (255, 255, 255, 255), size=32, icon=p.get("button_icon", "chat"),
                    icon_color=(255, 255, 255, 255), pad_x=50, pad_y=22)
        b.add(comp, bt, (b.W - bt.width // SS) // 2, y, 1.0, "pop", shadow=True)
        y += bt.height // SS + b.u(34)
    if p.get("phone"):
        nt = b.text(p["phone"], b.head, "ExtraBold", 84, color=hex_rgb(b.navy))
        bw, bh = nt.width // SS + b.u(80), nt.height // SS + b.u(44)
        box, xd = b.card(bw, bh, fill=(255, 255, 255, 255), line=(11, 30, 58, 18), radius=24)
        box.alpha_composite(nt, ((bw * SS - nt.width) // 2, (bh * SS - nt.height) // 2 + SS * 4))
        b.add(comp, box, (b.W - bw) // 2, y, 1.2, "rise", shadow=True)
    return comp


def _photo_circle(project, ph: dict, d: int) -> Image.Image | None:
    """Circular photo cropped from a frame of the user's own footage (no generated faces)."""
    from .ffmpeg_utils import extract_frame
    try:
        a = project.asset(ph["asset_id"])
        dest = project.path("graphics", f"photo_{a['id']}_{float(ph.get('time', 1.0)):.2f}.jpg")
        if not dest.exists():
            extract_frame(project.asset_path(a), float(ph.get("time", 1.0)), dest, 900)
        im = Image.open(dest).convert("RGBA")
    except Exception:  # noqa: BLE001
        return None
    fx, fy, zoom = float(ph.get("focus_x", 0.5)), float(ph.get("focus_y", 0.35)), float(ph.get("zoom", 1.6))
    side = int(min(im.width, im.height) / zoom)
    cx, cy = int(im.width * fx), int(im.height * fy)
    x0 = max(0, min(im.width - side, cx - side // 2))
    y0 = max(0, min(im.height - side, cy - side // 2))
    im = im.crop((x0, y0, x0 + side, y0 + side)).resize((d * SS, d * SS), Image.LANCZOS)
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).ellipse((0, 0, im.width - 1, im.height - 1), fill=255)
    im.putalpha(m)
    return im


# ---------------------------------------------------------------------------
# Overlays on footage (transparent, layered)
# ---------------------------------------------------------------------------
def _pos(b: Builder, w: int, h: int, pos: str, default: str) -> tuple[int, int]:
    pos = pos if pos not in ("", "auto") else default
    m = int(b.W * 0.05)
    top = int(b.H * 0.06)
    xs = {"left": m, "center": (b.W - w) // 2, "right": b.W - w - m}
    v, _, hz = pos.partition("_")
    ys = {"top": top, "upper": int(b.H * 0.16), "middle": (b.H - h) // 2, "lower": int(b.H * 0.56),
          "bottom": int(b.H * 0.86) - h}
    return xs.get(hz or "center", xs["center"]), ys.get(v, top)


def label_pill(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite()
    im = b.pill(p.get("text", ""), hex_rgb(b.navy, 215), (255, 255, 255, 255), size=36, icon=p.get("icon", "user"),
                icon_bg=hex_rgb(b.turq), icon_color=(255, 255, 255, 255), outline=(255, 255, 255, 40))
    x, y = _pos(b, im.width // SS, im.height // SS, p.get("position", ""), "top_left")
    b.add(comp, im, x, y, 0.0, "drop", shadow=True)
    return comp


def _counter_box(b: Builder, value: str, label: str, sub: str = "") -> Image.Image:
    w, h = b.u(250), b.u(220)
    im, d = b.card(w, h, fill=hex_rgb(b.navy, 215), radius=26, line=(255, 255, 255, 40))
    v = b.text(value, b.head, "ExtraBold", 96, color=hex_rgb(b.turq2))
    im.alpha_composite(v, ((w * SS - v.width) // 2, int(h * SS * 0.12)))
    lt = b.text(label, b.body, "Bold", 28, color=(255, 255, 255, 255), tracking=3, upper=True)
    im.alpha_composite(lt, ((w * SS - lt.width) // 2, int(h * SS * 0.68)))
    return im


def counter(b: Builder, p: dict, project=None) -> Composite:
    """Count-up stat box, e.g. 12+ -> 17+ YEARS (one layer per value, swapped quickly)."""
    comp = Composite()
    a, z = int(p.get("from", 0)), int(p.get("to", 10))
    suffix, prefix = str(p.get("suffix", "")), str(p.get("prefix", ""))
    steps = max(1, min(8, abs(z - a)))
    vals = [round(a + (z - a) * i / steps) for i in range(steps + 1)]
    dur = float(p.get("count_duration", 1.2))
    w, h = b.u(250), b.u(220)
    x, y = _pos(b, w, h, p.get("position", ""), "top_right")
    for i, v in enumerate(vals):
        im = _counter_box(b, f"{prefix}{v}{suffix}", p.get("label", ""))
        start = 0.0 if i == 0 else 0.35 + dur * i / len(vals)
        until = None if i == len(vals) - 1 else 0.35 + dur * (i + 1) / len(vals)
        b.add(comp, im, x, y, start, "drop" if i == 0 else "none", until=until, shadow=i == len(vals) - 1,
              dur_in=0.45 if i == 0 else 0.01)
    return comp


def credential_card(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite()
    t = b.text(p.get("title", ""), b.body, "ExtraBold", 40, color=hex_rgb(b.turq2), tracking=1.5, upper=True, align="left")
    s = b.text(p.get("sub", ""), b.body, "Bold", 28, color=(255, 255, 255, 255), tracking=1.5, upper=True, align="left") if p.get("sub") else None
    w = max(t.width, s.width if s else 0) // SS + b.u(56)
    h = (t.height + (s.height if s else 0)) // SS + b.u(36)
    im, d = b.card(w, h, fill=hex_rgb(b.navy, 220), radius=12, line=(255, 255, 255, 40))
    im.alpha_composite(t, (int(28 * b.s * SS), int(16 * b.s * SS)))
    if s:
        im.alpha_composite(s, (int(28 * b.s * SS), int(16 * b.s * SS) + t.height))
    x, y = _pos(b, w, h, p.get("position", ""), "lower_left")
    b.add(comp, im, x, y, 0.0, "slide_left", shadow=True)
    return comp


def headline_card(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite()
    k = b.text(p.get("kicker", ""), b.body, "ExtraBold", 42, color=(255, 255, 255, 255), tracking=1, upper=True) if p.get("kicker") else None
    big = b.text(p.get("big", ""), b.head, "ExtraBold", 140, color=hex_rgb(b.turq2), upper=True)
    w = max(big.width, k.width if k else 0) // SS + b.u(80)
    h = big.height // SS + (k.height // SS if k else 0) + b.u(30)
    im, d = b.card(w, h, fill=hex_rgb(b.navy, 210), radius=18, line=(255, 255, 255, 40))
    yy = int(14 * b.s * SS)
    if k:
        im.alpha_composite(k, ((w * SS - k.width) // 2, yy))
        yy += k.height - int(8 * b.s * SS)
    im.alpha_composite(big, ((w * SS - big.width) // 2, yy))
    x, y = _pos(b, w, h, p.get("position", ""), "upper_center")
    b.add(comp, im, x, y, 0.0, "drop", shadow=True)
    if p.get("tag"):
        tg = b.pill(p["tag"], hex_rgb(b.turq), (255, 255, 255, 255), size=24, icon="check", icon_color=(255, 255, 255, 255))
        b.add(comp, tg, (b.W - tg.width // SS) // 2, y + h + b.u(10), 0.5, "fade")
    return comp


def chat_bubbles(b: Builder, p: dict, project=None) -> Composite:
    comp = Composite()
    n = int(p.get("count", 3))
    spots = [(0.05, 0.11), (0.38, 0.17), (0.12, 0.24), (0.45, 0.07)]
    for i in range(min(n, 4)):
        w, h = b.u(420), b.u(104)
        im, d = b.card(w, h, fill=(255, 255, 255, 235), line=(0, 0, 0, 0), radius=18)
        for j, frac in enumerate((0.8, 0.55)):
            d.rounded_rectangle((w * SS * 0.07, h * SS * (0.28 + j * 0.28), w * SS * frac, h * SS * (0.40 + j * 0.28)),
                                SS * 6, fill=(185, 198, 210, 255))
        fx, fy = spots[i]
        b.add(comp, im, int(b.W * fx), int(b.H * fy), 0.25 * i, "rise", shadow=True)
    cp = p.get("counter")
    if cp:
        a, z = int(cp.get("from", 0)), int(cp.get("to", 10))
        steps = max(1, min(8, abs(z - a)))
        vals = [round(a + (z - a) * i / steps) for i in range(steps + 1)]
        label = cp.get("label", "replies today")
        dur = float(cp.get("count_duration", 2.0))
        for i, v in enumerate(vals):
            im = b.pill(f"{v} {label}", hex_rgb(b.navy, 225), (255, 255, 255, 255), size=34, icon="chat",
                        icon_color=hex_rgb(b.turq2), tracking=0, weight="Bold")
            x, y = _pos(b, im.width // SS, im.height // SS, cp.get("position", ""), "lower_center")
            start = 0.6 if i == 0 else 0.9 + dur * i / len(vals)
            until = None if i == len(vals) - 1 else 0.9 + dur * (i + 1) / len(vals)
            b.add(comp, im, x, y, start, "rise" if i == 0 else "none", until=until, dur_in=0.45 if i == 0 else 0.01)
    return comp


BUILDERS = {
    "scene_headline": scene_headline, "scene_phone": scene_phone, "scene_flow": scene_flow, "scene_steps": scene_steps,
    "scene_icons": scene_icons, "scene_cards": scene_cards, "scene_cta": scene_cta,
    "label_pill": label_pill, "counter": counter, "credential_card": credential_card, "headline_card": headline_card,
    "chat_bubbles": chat_bubbles,
}

DEFAULT_THEME = {"scene_headline": "navy", "scene_phone": "ice", "scene_flow": "ice", "scene_steps": "navy",
                 "scene_icons": "navy", "scene_cards": "ice", "scene_cta": "ice"}


def build(g, W: int, H: int, profile: dict, out_dir: Path, project=None) -> Composite:
    p: dict[str, Any] = dict(g.params)
    key = hashlib.sha1(json.dumps([g.type, p, W, H, profile.get("palette")], sort_keys=True, default=str).encode()).hexdigest()[:8]
    d = out_dir / f"{g.id}_{key}"
    d.mkdir(parents=True, exist_ok=True)
    b = Builder(W, H, profile, d, g.id, p.get("theme", DEFAULT_THEME.get(g.type, "navy")))
    return BUILDERS[g.type](b, p, project)


# ---------------------------------------------------------------------------
# FFmpeg helpers
# ---------------------------------------------------------------------------
def anim_exprs(L: Layer, t0: float, s: float) -> tuple[str, str]:
    """Overlay x/y expressions (global time t). t0 = absolute time when the layer starts animating."""
    e = f"min(1,max(0,(t-{t0:.3f})/{max(0.01, L.dur_in):.3f}))"
    ease = f"(1-pow(1-{e},3))"
    if L.anim == "rise":
        return f"{L.x}", f"{L.y}+{40 * s:.1f}*(1-{ease})"
    if L.anim == "pop":
        return f"{L.x}", f"{L.y}+{16 * s:.1f}*(1-{ease})"
    if L.anim == "drop":
        return f"{L.x}", f"{L.y}-{30 * s:.1f}*(1-{ease})"
    if L.anim == "slide_left":
        return f"{L.x}-{90 * s:.1f}*(1-{ease})", f"{L.y}"
    if L.anim == "slide_right":
        return f"{L.x}+{90 * s:.1f}*(1-{ease})", f"{L.y}"
    return f"{L.x}", f"{L.y}"


def layer_filters(L: Layer, idx: int, label: str, start: float, total: float, fps: str, s: float,
                  fade_out: bool = True) -> tuple[list[str], str, str]:
    """Return (filter lines for the layer input, overlay args, enable window) for a graphic starting at `start`."""
    a = start + L.delay
    end = start + (L.until if L.until is not None else total)
    life = max(0.05, end - a)
    fin = min(L.dur_in, life / 2) if L.anim != "none" else 0.0
    chain = f"[{idx}:v]format=rgba"
    if fin > 0.02:
        chain += f",fade=t=in:st=0:d={fin:.3f}:alpha=1"
    if fade_out and L.until is None and life > 0.6:
        chain += f",fade=t=out:st={max(0.0, life - 0.3):.3f}:d=0.3:alpha=1"
    chain += f",setpts=PTS-STARTPTS+{a:.3f}/TB[{label}]"
    x, y = anim_exprs(L, a, s)
    return [chain], f"x='{x}':y='{y}':eof_action=pass:eval=frame", f"between(t,{a:.3f},{end:.3f})"


def still_frame(comp: Composite, W: int, H: int, base: Image.Image | None = None, project=None) -> Image.Image:
    """Final state of a composite (all entrances finished) - used for previews and QA."""
    if comp.background is not None:
        canvas = Image.open(comp.background).convert("RGBA").resize((W, H))
    elif base is not None:
        canvas = base.convert("RGBA").resize((W, H))
    else:
        canvas = Image.new("RGBA", (W, H), (60, 70, 80, 255))
    if comp.inset:
        ins = comp.inset
        frame = None
        if project is not None:
            try:
                from .ffmpeg_utils import read_frames_rgb
                fr = read_frames_rgb(project.asset_path(ins["asset_id"]), [ins["src_in"] + 1.0], 320, 568)
                frame = Image.fromarray(fr[0]).convert("RGBA") if fr else None
            except Exception:  # noqa: BLE001
                frame = None
        frame = (frame or Image.new("RGBA", (10, 10), (90, 110, 130, 255)))
        r = max(ins["w"] / frame.width, ins["h"] / frame.height)
        frame = frame.resize((int(frame.width * r) + 1, int(frame.height * r) + 1))
        frame = frame.crop(((frame.width - ins["w"]) // 2, (frame.height - ins["h"]) // 2,
                            (frame.width - ins["w"]) // 2 + ins["w"], (frame.height - ins["h"]) // 2 + ins["h"]))
        m = Image.new("L", frame.size, 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, frame.width - 1, frame.height - 1), ins["radius"], fill=255)
        canvas.paste(frame, (ins["x"], ins["y"]), m)
    for L in comp.layers:
        if L.until is not None:
            continue
        im = Image.open(L.path).convert("RGBA")
        canvas.alpha_composite(im, (max(0, L.x), max(0, L.y)) if L.x >= 0 and L.y >= 0 else (0, 0))
    return canvas

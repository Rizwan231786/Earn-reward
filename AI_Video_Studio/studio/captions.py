"""Caption engine: phrase grouping, SRT export and animated ASS subtitles (burned in with libass).

The spoken words are used verbatim. Nothing is translated. Words in Devanagari or Arabic script
are left out of captions and reported, so Hindi or Devanagari captions are never produced from
Roman Urdu speech.
"""
from __future__ import annotations

import re
from typing import Callable

from .fonts import ass_font_name
from .models import CaptionSettings, Graphic
from .transcription import ARABIC, DEVANAGARI


def ass_color(hex_color: str, alpha: float = 0.0) -> str:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    a = int(round(max(0.0, min(1.0, alpha)) * 255))
    return f"&H{a:02X}{b}{g}{r}".upper()


def _ts_ass(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    cs = int(round((s - int(s)) * 100))
    si = int(s)
    if cs == 100:
        si, cs = si + 1, 0
    return f"{h}:{m:02d}:{si:02d}.{cs:02d}"


def _ts_srt(t: float) -> str:
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _esc(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def clean_words(words: list[dict]) -> tuple[list[dict], list[dict]]:
    """Drop non-Latin-script words (never caption Devanagari/Arabic) and report them."""
    kept, dropped = [], []
    for w in words:
        if DEVANAGARI.search(w["word"]) or ARABIC.search(w["word"]):
            dropped.append(w)
        elif w["word"].strip():
            kept.append(w)
    return kept, dropped


def group_words(words: list[dict], max_words: int, max_gap: float = 0.45, max_dur: float = 3.2) -> list[list[dict]]:
    groups: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        if cur:
            gap = w["start"] - cur[-1]["end"]
            punct = cur[-1]["word"].rstrip().endswith((".", "?", "!", ",", "۔", ":", ";"))
            if (len(cur) >= max_words or gap > max_gap or (punct and len(cur) >= 2)
                    or w["end"] - cur[0]["start"] > max_dur):
                groups.append(cur)
                cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _split_lines(words: list[str], max_per_line: int, max_lines: int) -> list[list[int]]:
    n = len(words)
    if n <= max_per_line or max_lines <= 1:
        return [list(range(n))]
    lines = min(max_lines, -(-n // max_per_line))
    per = -(-n // lines)
    return [list(range(i, min(n, i + per))) for i in range(0, n, per)]


def auto_font_size(w: int, h: int) -> int:
    if h > w:
        return int(round(w * 0.066))
    if w > h:
        return int(round(h * 0.058))
    return int(round(w * 0.062))


def _layout(cs: CaptionSettings, w: int, h: int) -> tuple[int, int]:
    """Return (ASS alignment, MarginV) respecting mobile safe zones."""
    vertical = h > w
    if cs.position == "center":
        return 5, 0
    if cs.position == "top":
        return 8, int(h * (0.12 if vertical else 0.07))
    if cs.position == "bottom":
        return 2, int(h * (0.16 if vertical else 0.07))
    return 2, int(h * (0.27 if vertical else 0.14))  # lower_third (above Reels/Shorts UI)


def build_captions(words: list[dict], cs: CaptionSettings, width: int, height: int,
                   time_map: Callable[[float], float] = lambda t: t,
                   kinetic: list[Graphic] | None = None,
                   extra_highlights: set[str] | None = None) -> dict:
    words, dropped = clean_words(words)
    mapped = [w | {"start": time_map(w["start"]), "end": time_map(w["end"])} for w in words]
    groups = group_words(mapped, cs.max_words_per_line * cs.max_lines)
    font_size = cs.font_size or auto_font_size(width, height)
    align, margin_v = _layout(cs, width, height)
    font = ass_font_name(cs.font, cs.weight)
    bold = -1 if cs.weight == "Bold" else 0
    hl = ass_color(cs.highlight_color)
    keywords = {k.lower() for k in cs.highlight_keywords} | {k.lower() for k in (extra_highlights or set())}

    border_style, outline_col, outline = 1, ass_color(cs.outline_color), cs.outline
    back_col = ass_color("#000000", 0.55)
    if cs.background in ("box", "soft_box"):
        border_style = 3
        outline_col = ass_color(cs.background_color, 1 - cs.background_opacity)
        outline = max(outline, font_size * 0.22)
        back_col = outline_col
    shadow = cs.shadow if cs.background == "none" else 0

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font},{font_size},{ass_color(cs.primary_color)},{hl},{outline_col},{back_col},{bold},0,0,0,100,100,0,0,{border_style},{outline:.1f},{shadow:.1f},{align},{int(width*0.08)},{int(width*0.08)},{margin_v},1
Style: Kinetic,{ass_font_name('Montserrat','ExtraBold')},{int(font_size*1.55)},&H00FFFFFF,{hl},&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,0,3,5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    srt: list[str] = []
    up = (lambda s: s.upper()) if cs.uppercase else (lambda s: s)

    def is_key(word: str) -> bool:
        t = re.sub(r"[^\w%]", "", word.lower())
        return bool(t) and (t in keywords or bool(re.search(r"\d", t)))

    for gi, g in enumerate(groups):
        start = g[0]["start"]
        nxt = groups[gi + 1][0]["start"] if gi + 1 < len(groups) else None
        end = g[-1]["end"] + 0.15
        if nxt is not None and nxt - end < 0.25:
            end = nxt - 0.01
        end = max(end, start + 0.5)
        texts = [up(_esc(w["word"])) for w in g]
        lines = _split_lines(texts, cs.max_words_per_line, cs.max_lines)
        srt.append(f"{len(srt) + 1}\n{_ts_srt(start)} --> {_ts_srt(end)}\n" +
                   "\n".join(" ".join(g[i]["word"] for i in ln) for ln in lines) + "\n")

        intro = ""
        if cs.animation == "pop":
            intro = r"{\fscx86\fscy86\t(0,110,\fscx100\fscy100)}"
        elif cs.animation == "fade":
            intro = r"{\fad(120,0)}"
        elif cs.animation == "rise":
            intro = r"{\fad(100,0)\frx20\t(0,160,\frx0)}"

        def render(active: int | None, visible_upto: int | None = None) -> str:
            out_lines = []
            for ln in lines:
                parts = []
                for i in ln:
                    t = texts[i]
                    if visible_upto is not None and i > visible_upto:
                        parts.append(r"{\alpha&HFF&}" + t + r"{\alpha&H00&}")
                    elif active == i:
                        parts.append(r"{\c" + hl + r"&\fscx108\fscy108}" + t + r"{\c" + ass_color(cs.primary_color) + r"&\fscx100\fscy100}")
                    elif is_key(g[i]["word"]):
                        parts.append(r"{\c" + hl + "&}" + t + r"{\c" + ass_color(cs.primary_color) + "&}")
                    else:
                        parts.append(t)
                out_lines.append(" ".join(parts))
            return r"\N".join(out_lines)

        if cs.mode == "phrase":
            events.append(f"Dialogue: 0,{_ts_ass(start)},{_ts_ass(end)},Caption,,0,0,0,,{intro}{render(None)}")
        elif cs.mode == "karaoke":
            body = []
            for i, w in enumerate(g):
                dur_cs = int(round(((g[i + 1]["start"] if i + 1 < len(g) else end) - w["start"]) * 100))
                body.append(r"{\kf" + str(max(1, dur_cs)) + "}" + texts[i])
            # karaoke fills from SecondaryColour to PrimaryColour; swap so the sweep shows highlight
            events.append(f"Dialogue: 0,{_ts_ass(start)},{_ts_ass(end)},Caption,,0,0,0,,"
                          r"{\1c" + hl + r"&\2c" + ass_color(cs.primary_color) + "&}" + " ".join(body))
        else:
            for i, w in enumerate(g):
                ws = start if i == 0 else w["start"]
                we = g[i + 1]["start"] if i + 1 < len(g) else end
                if we - ws < 0.02:
                    continue
                txt = render(i, i if cs.mode == "word_by_word" else None)
                events.append(f"Dialogue: 0,{_ts_ass(ws)},{_ts_ass(we)},Caption,,0,0,0,,{intro if i == 0 else ''}{txt}")

    for k in kinetic or []:
        events.extend(kinetic_events(k, width, height))

    return {"ass": header + "\n".join(events) + "\n", "srt": "\n".join(srt),
            "groups": len(groups), "words": len(words),
            "dropped_non_roman_words": [{"word": d["word"], "start": d["start"]} for d in dropped]}


def kinetic_events(g: Graphic, width: int, height: int) -> list[str]:
    """Kinetic typography: words land one after another with a soft scale/blur settle."""
    text = str(g.params.get("text", "")).strip()
    if not text:
        return []
    words = [_esc(w) for w in text.split()]
    hl_words = {w.lower() for w in g.params.get("highlight", [])}
    hl = ass_color(g.params.get("highlight_color", "#2EE6D6"))
    y = int(height * float(g.params.get("y", 0.45)))
    x = width // 2
    stagger = min(0.18, (g.duration * 0.4) / max(1, len(words)))
    out = []
    for i in range(len(words)):
        st = g.start + i * stagger
        parts = []
        for j, w in enumerate(words[: i + 1]):
            col = r"{\c" + hl + "&}" if w.lower().strip(".,!?") in hl_words else r"{\c&HFFFFFF&}"
            if j == i:
                parts.append(r"{\alpha&HFF&\t(0,140,\alpha&H00&)\fscx120\fscy120\blur6\t(0,180,\fscx100\fscy100\blur0)}" + col + w)
            else:
                parts.append(col + w)
        end = g.start + (i + 1) * stagger if i + 1 < len(words) else g.start + g.duration
        fade = r"{\fad(0,250)}" if i + 1 == len(words) else ""
        out.append(f"Dialogue: 2,{_ts_ass(st)},{_ts_ass(end)},Kinetic,,0,0,0,,{{\\an5\\pos({x},{y})}}{fade}" + " ".join(parts))
    return out

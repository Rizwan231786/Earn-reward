"""Permanent editing profiles.

Built-in profiles are defined here. User edits are stored as JSON overrides in
<studio_home>/profiles/<name>.json and deep-merged over the built-in definition, so updates
survive upgrades and can always be reset.
"""
from __future__ import annotations

import copy
import json
from typing import Any

from .config import get_settings
from .projects import get_setting, set_setting

PALETTE = {
    "turquoise": "#14C8C0",
    "turquoise_bright": "#2EE6D6",
    "white": "#FFFFFF",
    "ice_blue": "#DCF3FA",
    "navy": "#0B1E3A",
    "navy_soft": "#13294B",
    "text_dark": "#0B1E3A",
}

PREMIUM_COMMERCIAL: dict[str, Any] = {
    "name": "premium_commercial",
    "title": "PREMIUM COMMERCIAL EDITING PROFILE",
    "description": "Premium commercial production: modern cinematic storytelling, advertising aesthetics, natural visuals, "
                   "sophisticated motion graphics, clean typography, professional sound design.",
    "creative_direction": [
        "Premium commercial production", "Modern cinematic storytelling", "Professional advertising aesthetics",
        "Natural and realistic visuals", "Sophisticated motion graphics", "Clean typography", "Professional sound design",
    ],
    "palette": PALETTE,
    "typography": {"headline": "Montserrat", "body": "Inter", "accent": "Manrope",
                   "headline_weight": "ExtraBold", "body_weight": "SemiBold"},
    "visual_standards": [
        "Professional lower thirds", "Kinetic typography", "Animated titles", "Floating UI cards", "Smartphone mockups",
        "Elegant transitions", "Medical and business infographic elements", "Subtle parallax", "Clean iconography",
    ],
    "avoid": [
        "Cheap template aesthetics", "Random transitions", "Excessive zoom effects", "Excessive glitch effects",
        "Childish animations", "Unnecessary visual clutter", "Artificial skin smoothing", "Over-saturated colors",
    ],
    "pacing": {"min_shot": 1.6, "target_shot": 3.2, "max_shot": 6.0, "lead_in": 0.4, "tail": 0.8},
    "transitions": {"default": "cut", "section_change": "dissolve", "duration": 0.35, "max_non_cut_ratio": 0.25},
    "reframe": {"mode": "auto", "motion": "slow_push", "max_push": 1.04},
    "color": {"look": "clean_commercial", "look_intensity": 0.35, "max_saturation": 1.08, "preserve_skin": True,
              "contrast": 1.05, "target_brightness": 0.47},
    "captions": {"enabled": True, "mode": "word_highlight", "font": "Montserrat", "weight": "ExtraBold",
                 "position": "lower_third", "primary_color": "#FFFFFF", "highlight_color": "#2EE6D6",
                 "outline_color": "#0B1E3A", "outline": 0.0, "shadow": 2.0, "background": "none",
                 "max_words_per_line": 5, "max_lines": 2, "uppercase": False, "animation": "pop"},
    "graphics": {"title_card": True, "lower_third": True, "info_cards": True, "cta_end_card": True,
                 "max_graphics_per_minute": 6, "style": "glass", "corner_radius": 28, "animation": "slide"},
    "audio": {"voice_enhance": True, "denoise": "auto", "target_lufs": -14.0, "music_volume_db": -21.0,
              "duck_amount_db": -10.0, "sfx_density": "subtle", "sfx_volume_db": -17.0, "tighten_pauses": False,
              "max_pause": 0.6},
    "default_aspect": "16:9",
    "safety": [
        "Never fabricate medical qualifications, testimonials or results.",
        "Never create misleading before/after visuals.",
        "Never change a real person's identity or replace the original voice.",
        "Use only user-supplied, licensed or locally generated music/SFX.",
    ],
}


def _variant(name: str, title: str, description: str, **patch: Any) -> dict:
    p = copy.deepcopy(PREMIUM_COMMERCIAL)
    p.update({"name": name, "title": title, "description": description})
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(p.get(k), dict):
            p[k] = {**p[k], **v}
        else:
            p[k] = v
    return p


BUILTIN: dict[str, dict] = {
    "premium_commercial": PREMIUM_COMMERCIAL,
    "healthcare_dermatology": _variant(
        "healthcare_dermatology", "DERMATOLOGY & HEALTHCARE COMMERCIAL",
        "Trustworthy clinical premium look. True-to-life skin, calm pacing, medical infographics. Strict honesty rules.",
        pacing={"min_shot": 2.0, "target_shot": 3.6, "max_shot": 6.5},
        color={"look_intensity": 0.25, "max_saturation": 1.04, "contrast": 1.03},
        graphics={"medical_infographics": True},
        safety=PREMIUM_COMMERCIAL["safety"] + [
            "Show doctor names/qualifications exactly as supplied by the user - never invent credentials.",
            "Never retouch skin conditions or imply guaranteed results.",
            "Before/after material only when supplied by the user, unaltered and labelled."]),
    "real_estate": _variant(
        "real_estate", "REAL ESTATE WALKTHROUGH",
        "Smooth, spacious walkthroughs, location maps, price/feature cards.",
        pacing={"min_shot": 2.4, "target_shot": 4.0, "max_shot": 7.0},
        transitions={"default": "dissolve", "duration": 0.5, "max_non_cut_ratio": 0.6},
        reframe={"motion": "slow_push", "max_push": 1.05},
        color={"look_intensity": 0.4, "max_saturation": 1.1}),
    "product_ad": _variant(
        "product_ad", "PRODUCT ADVERTISEMENT",
        "Punchy, rhythmic product storytelling with feature callouts and a strong CTA.",
        pacing={"min_shot": 1.0, "target_shot": 2.2, "max_shot": 4.0},
        audio={"music_volume_db": -18.0, "sfx_density": "medium"}),
    "corporate": _variant(
        "corporate", "CORPORATE PROMOTIONAL",
        "Confident, clean corporate storytelling with process diagrams and stat cards.",
        pacing={"min_shot": 2.0, "target_shot": 3.8, "max_shot": 6.5},
        captions={"mode": "phrase", "font": "Inter", "weight": "Bold"}),
    "youtube": _variant(
        "youtube", "YOUTUBE VIDEO",
        "Long-form friendly pacing, chapter titles, readable phrase captions.",
        default_aspect="16:9", pacing={"min_shot": 2.0, "target_shot": 4.5, "max_shot": 9.0},
        captions={"mode": "phrase", "position": "bottom"},
        audio={"tighten_pauses": True, "max_pause": 0.7}),
    "reels_shorts": _variant(
        "reels_shorts", "INSTAGRAM REELS / SHORTS / TIKTOK",
        "Vertical 9:16, fast hook in first 2 seconds, bold word-highlight captions in mobile safe zone.",
        default_aspect="9:16", pacing={"min_shot": 0.9, "target_shot": 1.9, "max_shot": 3.5, "lead_in": 0.15},
        captions={"mode": "word_highlight", "position": "center", "max_words_per_line": 3, "uppercase": False},
        audio={"tighten_pauses": True, "max_pause": 0.45, "music_volume_db": -19.0}),
    "educational": _variant(
        "educational", "EDUCATIONAL VIDEO",
        "Clear explanatory pacing, step diagrams, checklists, phrase captions.",
        pacing={"min_shot": 2.2, "target_shot": 4.5, "max_shot": 8.0},
        captions={"mode": "phrase", "font": "Inter", "weight": "Bold", "position": "bottom"}),
    "cinematic": _variant(
        "cinematic", "CUSTOM CINEMATIC",
        "Slower, moodier cinematic pacing with dissolves and a deeper grade. Minimal graphics.",
        pacing={"min_shot": 2.5, "target_shot": 4.8, "max_shot": 9.0},
        transitions={"default": "dissolve", "duration": 0.6, "max_non_cut_ratio": 0.5},
        color={"look": "cinematic_teal", "look_intensity": 0.55, "contrast": 1.1},
        graphics={"info_cards": False, "max_graphics_per_minute": 2},
        captions={"mode": "phrase", "font": "Manrope", "weight": "SemiBold", "position": "bottom"}),
}


def _deep_merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _override_file(name: str):
    return get_settings().profiles_dir / f"{name}.json"


def list_profiles() -> list[dict]:
    names = set(BUILTIN)
    names |= {p.stem for p in get_settings().profiles_dir.glob("*.json")}
    active = active_profile_name()
    out = []
    for n in sorted(names):
        p = load_profile(n)
        out.append({"name": n, "title": p.get("title"), "description": p.get("description"),
                    "default_aspect": p.get("default_aspect"), "builtin": n in BUILTIN,
                    "customised": _override_file(n).exists(), "active": n == active})
    return out


def active_profile_name() -> str:
    return get_setting("active_profile", "premium_commercial")


def load_profile(name: str | None = None) -> dict:
    name = name or active_profile_name()
    base = BUILTIN.get(name)
    f = _override_file(name)
    override = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
    if base is None and override is None:
        raise ValueError(f"Unknown profile '{name}'. Available: {sorted(set(BUILTIN))}")
    return _deep_merge(base or PREMIUM_COMMERCIAL, override or {}) | {"name": name}


_ALLOWED_TOP = set(PREMIUM_COMMERCIAL) | {"notes", "brand", "custom_rules"}


def update_profile(name: str, changes: dict, set_active: bool = False, base: str | None = None) -> dict:
    if not isinstance(changes, dict):
        raise ValueError("changes must be an object")
    unknown = set(changes) - _ALLOWED_TOP
    if unknown:
        raise ValueError(f"Unknown profile keys: {sorted(unknown)}. Allowed: {sorted(_ALLOWED_TOP)}")
    if not name.replace("_", "").isalnum():
        raise ValueError("Profile name may contain only letters, digits and underscores")
    f = _override_file(name)
    current = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    if name not in BUILTIN and not current and base:
        current = copy.deepcopy(load_profile(base))
    merged = _deep_merge(current, changes)
    f.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    if set_active:
        set_setting("active_profile", name)
    return load_profile(name)


def reset_profile(name: str) -> dict:
    f = _override_file(name)
    if f.exists():
        backup = f.with_suffix(".json.bak")
        f.replace(backup)
    return load_profile(name) if name in BUILTIN else {"deleted": name}


def set_active_profile(name: str) -> dict:
    load_profile(name)
    set_setting("active_profile", name)
    return {"active_profile": name}

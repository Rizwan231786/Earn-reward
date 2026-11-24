"""Pydantic schemas for the editable timeline (editing plan) and related structures."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

FORMATS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
}


class OutputFormat(BaseModel):
    aspect: str = "16:9"
    width: int = 1920
    height: int = 1080
    fps: Optional[float] = None  # None => source frame rate
    fps_fraction: Optional[str] = None

    @classmethod
    def from_aspect(cls, aspect: str, fps: float | None = None, fps_fraction: str | None = None) -> "OutputFormat":
        if aspect not in FORMATS:
            raise ValueError(f"Unknown aspect '{aspect}'. Use one of {list(FORMATS)}")
        w, h = FORMATS[aspect]
        return cls(aspect=aspect, width=w, height=h, fps=fps, fps_fraction=fps_fraction)

    @field_validator("width", "height")
    @classmethod
    def _even(cls, v: int) -> int:
        if v < 64 or v > 7680:
            raise ValueError("dimension out of range (64-7680)")
        return v - (v % 2)


class Reframe(BaseModel):
    mode: Literal["auto", "crop", "blur_fill", "fit"] = "auto"
    focus_x: float = 0.5  # 0..1 horizontal subject centre in the source
    focus_y: float = 0.5
    zoom: float = 1.0  # extra punch-in (1.0 = none)
    motion: Literal["none", "slow_push", "slow_pull"] = "none"


class ColorSettings(BaseModel):
    enabled: bool = True
    exposure: float = 0.0  # brightness offset (-0.3..0.3)
    contrast: float = 1.0
    saturation: float = 1.0
    gamma: float = 1.0
    wb_r: float = 1.0
    wb_g: float = 1.0
    wb_b: float = 1.0
    shadows_lift: float = 0.0
    highlights_roll: float = 0.0
    look_intensity: float = 0.35  # creative look 0..1
    lut: Optional[str] = None  # project-relative .cube path
    lut_intensity: float = 1.0


class Transition(BaseModel):
    type: Literal["cut", "dissolve", "fade_black", "slide_left", "slide_up", "wipe", "smooth_zoom"] = "cut"
    duration: float = 0.0


class VideoSegment(BaseModel):
    id: str
    asset_id: str
    src_in: float
    src_out: float
    timeline_start: float
    reason: str = ""
    matched_text: str = ""
    scene_index: Optional[int] = None
    reframe: Reframe = Field(default_factory=Reframe)
    color: ColorSettings = Field(default_factory=ColorSettings)
    transition_in: Transition = Field(default_factory=Transition)
    keep_source_audio: bool = False
    is_broll: bool = False

    @property
    def duration(self) -> float:
        return max(0.0, self.src_out - self.src_in)


class Graphic(BaseModel):
    id: str
    type: Literal["title_card", "lower_third", "info_card", "callout", "cta", "notification",
                  "phone_mockup", "process_steps", "stat_card", "location_pin", "kinetic_text",
                  "logo_bug", "checklist", "image_card", "line_accent"]
    start: float
    duration: float
    params: dict[str, Any] = Field(default_factory=dict)
    position: str = "auto"
    animation: Literal["slide", "fade", "pop", "rise"] = "slide"
    sfx: Optional[str] = None  # sfx name to place at entrance


class SoundEffect(BaseModel):
    id: str
    name: str  # library name (e.g. "whoosh_soft") or project-relative file path
    time: float
    volume_db: float = -16.0
    reason: str = ""


class MusicSettings(BaseModel):
    asset_id: Optional[str] = None  # imported music asset, or "generated_ambient"
    volume_db: float = -20.0
    duck_under_voice: bool = True
    duck_amount_db: float = -10.0
    fade_in: float = 1.5
    fade_out: float = 2.5
    start_offset: float = 0.0


class CaptionSettings(BaseModel):
    enabled: bool = True
    burn_in: bool = True
    mode: Literal["phrase", "word_highlight", "word_by_word", "karaoke"] = "word_highlight"
    font: str = "Montserrat"
    weight: Literal["SemiBold", "Bold", "ExtraBold"] = "ExtraBold"
    font_size: Optional[int] = None  # px at output resolution; None => auto
    position: Literal["bottom", "lower_third", "center", "top"] = "lower_third"
    primary_color: str = "#FFFFFF"
    highlight_color: str = "#2EE6D6"
    outline_color: str = "#0B1E3A"
    outline: float = 0.0
    shadow: float = 2.0
    background: Literal["none", "box", "soft_box"] = "none"
    background_color: str = "#0B1E3A"
    background_opacity: float = 0.55
    max_words_per_line: int = 5
    max_lines: int = 2
    uppercase: bool = False
    highlight_keywords: list[str] = Field(default_factory=list)
    animation: Literal["none", "pop", "fade", "rise"] = "pop"


class AudioSettings(BaseModel):
    voice_enhance: bool = True
    denoise: Literal["auto", "off", "light", "medium"] = "auto"
    target_lufs: float = -14.0
    keep_source_audio: bool = False
    source_audio_volume_db: float = -22.0
    tighten_pauses: bool = False
    max_pause: float = 0.6


class MissingVisual(BaseModel):
    at: float
    duration: float
    text: str
    suggestion: str


class Timeline(BaseModel):
    version: int = 1
    project_id: str
    profile: str
    output: OutputFormat
    duration: float
    voiceover_asset_id: Optional[str] = None
    voiceover_offset: float = 0.5
    segments: list[VideoSegment] = Field(default_factory=list)
    graphics: list[Graphic] = Field(default_factory=list)
    sfx: list[SoundEffect] = Field(default_factory=list)
    music: MusicSettings = Field(default_factory=MusicSettings)
    captions: CaptionSettings = Field(default_factory=CaptionSettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)
    color_grade_global: ColorSettings = Field(default_factory=ColorSettings)
    missing_visuals: list[MissingVisual] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    approved: bool = False

    def validate_against(self, asset_ids: set[str]) -> list[str]:
        """Semantic validation; returns a list of problems (empty => OK)."""
        problems = []
        t = 0.0
        for s in sorted(self.segments, key=lambda x: x.timeline_start):
            if s.asset_id not in asset_ids:
                problems.append(f"segment {s.id}: unknown asset '{s.asset_id}'")
            if s.src_out <= s.src_in:
                problems.append(f"segment {s.id}: src_out must be greater than src_in")
            if s.timeline_start + 1e-3 < t - max(0.0, s.transition_in.duration) - 1e-3:
                problems.append(f"segment {s.id}: overlaps previous segment")
            t = s.timeline_start + s.duration
        for g in self.graphics:
            if g.start < 0 or g.start > self.duration:
                problems.append(f"graphic {g.id}: start outside timeline")
        return problems

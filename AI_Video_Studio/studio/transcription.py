"""Voiceover transcription with word timestamps, Roman Urdu safeguards and manual correction.

Engines (auto-detected, in order): faster-whisper, openai-whisper. If neither is installed, a
speech-region analysis (ffmpeg silencedetect) still runs and the exact script can be supplied with
`align_script`, which time-aligns it to the voice.

Roman Urdu policy
-----------------
* Whisper writes Urdu speech in Arabic script ("ur") or sometimes Devanagari ("hi"). We never
  ask for those languages in roman modes. We decode with language="en" and a Roman Urdu style
  prompt, which keeps output in Latin script.
* Any Devanagari / Arabic-script text that still appears is flagged for review and is never
  turned into captions automatically.
* Nothing is translated. If the recogniser seems to have translated instead of transcribing,
  the segment is flagged. Supplying the real script with align_script fixes it.
"""
from __future__ import annotations

import difflib
import logging
import re
from pathlib import Path
from typing import Any, Callable

from .config import get_settings
from .ffmpeg_utils import ffmpeg, media_info, silence_intervals
from .projects import Project, now_iso

log = logging.getLogger("studio.transcription")

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
ARABIC = re.compile(r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")

ROMAN_URDU_PROMPT = (
    "Assalam o alaikum. Aaj hum baat karenge skin care ke baare mein. Yeh bohat zaroori hai, "
    "aur main aap ko batata hoon ke treatment kaise kaam karta hai. Doctor sahab, clinic, results."
)
MIXED_PROMPT = (
    "Hello, assalam o alaikum! Aaj main aap ko batati hoon ke yeh treatment kaise work karta hai. "
    "It's simple, safe aur bohat effective hai."
)

STOPWORDS = set("""a an the and or but if then so to of in on at by for with from as is are was were be been being it this that these
those i you he she we they me him her us them my your our their its not no yes do does did have has had will would can could
should may might just very really also than too into about over under up down out more most some any all each other such only own
same here there when where why how what which who whom ok okay hai hain ho hoon tha thi the thay ka ki ke ko se mein main mai
hum aap yeh ye woh wo is us un in aur ya bhi to toh na nahi nahin ab jab tab kya kyun kaise kahan koi kuch bohat bahut bas phir
ne par pe tak wala wali wale apna apni apne hamara hamari ap""".split())

EMOTION_WORDS = {
    "positive": set("amazing beautiful best confident confidence glowing happy love perfect safe smooth trusted results khush "
                    "khoobsurat behtareen acha achi ache zabardast pyaar sukoon".split()),
    "concern": set("problem problems pain worried worry acne scars damage risk side effects pareshan pareshani dard masla "
                   "masail takleef darr fikar".split()),
    "action": set("book call visit contact today now appointment consult consultation register join aaj abhi rabta "
                  "call karein visit karein".split()),
}


# ---------------------------------------------------------------------------
# Engine detection
# ---------------------------------------------------------------------------
def available_engines() -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        import faster_whisper  # noqa: F401
        out["faster-whisper"] = getattr(faster_whisper, "__version__", "installed")
    except Exception:  # noqa: BLE001
        pass
    try:
        import whisper  # noqa: F401
        out["openai-whisper"] = "installed"
    except Exception:  # noqa: BLE001
        pass
    return out


def model_cached(engine: str, model: str) -> bool:
    s = get_settings()
    if engine == "faster-whisper":
        try:
            from faster_whisper.utils import download_model
            download_model(model, local_files_only=True, cache_dir=str(s.models_dir))
            return True
        except Exception:  # noqa: BLE001
            return Path(model).is_dir()
    if engine == "openai-whisper":
        return (s.models_dir / f"{model}.pt").exists() or Path(model).is_file()
    return False


def pick_engine() -> str | None:
    pref = get_settings()["transcription"]["engine"]
    eng = available_engines()
    if pref not in ("auto", "none") and pref in eng:
        return pref
    if pref == "none":
        return None
    for e in ("faster-whisper", "openai-whisper"):
        if e in eng:
            return e
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def prepare_voice_wav(project: Project, asset: dict) -> Path:
    """16 kHz mono analysis copy of the voiceover (original untouched)."""
    dest = project.path("work", f"{asset['id']}_16k.wav")
    if not dest.exists():
        ffmpeg(["-i", str(project.asset_path(asset)), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                str(dest)], timeout=3600)
    return dest


def load_wav_16k(path: Path):
    """Read the 16 kHz mono PCM WAV produced by prepare_voice_wav as float32 samples (-1..1)."""
    import wave

    import numpy as np
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"unexpected WAV format in {path.name}")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def speech_regions(wav: Path, total: float) -> list[tuple[float, float]]:
    sil = silence_intervals(wav, noise_db=-38, min_dur=0.3)
    regions, t = [], 0.0
    for a, b in sil:
        if a - t > 0.12:
            regions.append((round(t, 3), round(a, 3)))
        t = b
    if total - t > 0.12:
        regions.append((round(t, 3), round(total, 3)))
    return regions


def _script_flags(text: str, mode: str) -> list[str]:
    flags = []
    if DEVANAGARI.search(text):
        flags.append("devanagari_detected")
    if ARABIC.search(text) and mode in ("roman_urdu", "mixed", "english"):
        flags.append("arabic_script_detected")
    return flags


def _words_to_segments(words: list[dict], max_gap: float = 0.6, max_len: float = 9.0) -> list[dict]:
    """Group words into sentence-like segments by punctuation and pauses."""
    segs: list[dict] = []
    cur: list[int] = []
    for i, w in enumerate(words):
        if cur:
            prev = words[cur[-1]]
            gap = w["start"] - prev["end"]
            ends_sentence = prev["word"].rstrip().endswith((".", "?", "!", "۔"))
            too_long = w["end"] - words[cur[0]]["start"] > max_len
            if gap > max_gap or ends_sentence or too_long:
                segs.append(_mk_seg(words, cur, len(segs)))
                cur = []
        cur.append(i)
    if cur:
        segs.append(_mk_seg(words, cur, len(segs)))
    return segs


def _mk_seg(words: list[dict], idx: list[int], n: int) -> dict:
    ws = [words[i] for i in idx]
    probs = [w.get("prob") for w in ws if w.get("prob") is not None]
    return {
        "id": n, "start": ws[0]["start"], "end": ws[-1]["end"],
        "text": " ".join(w["word"].strip() for w in ws).strip(),
        "word_range": [idx[0], idx[-1]],
        "avg_prob": round(sum(probs) / len(probs), 3) if probs else None,
    }


def analyse_structure(tr: dict) -> dict:
    """Pauses, key phrases, emotional/informational sections (heuristic, reviewable)."""
    words, segs = tr["words"], tr["segments"]
    pauses = []
    for a, b in zip(words, words[1:]):
        gap = b["start"] - a["end"]
        if gap >= 0.35:
            pauses.append({"at": round(a["end"], 3), "duration": round(gap, 3)})
    freq: dict[str, int] = {}
    for w in words:
        t = re.sub(r"[^\w%]", "", w["word"].lower())
        if len(t) > 3 and t not in STOPWORDS:
            freq[t] = freq.get(t, 0) + 1
    key_terms = [k for k, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:15]]
    for s in segs:
        text_l = s["text"].lower()
        toks = set(re.findall(r"[\w%]+", text_l))
        kinds = [k for k, vocab in EMOTION_WORDS.items() if toks & vocab]
        has_number = bool(re.search(r"\d", text_l)) or bool(toks & {"percent", "fees", "price", "years", "saal", "minutes"})
        s["tone"] = "call_to_action" if "action" in kinds else ("emotional_" + kinds[0] if kinds else
                                                               ("informational_numeric" if has_number else "informational"))
        s["highlights"] = [w for w in re.findall(r"[\w%]+", s["text"]) if w.lower() in key_terms[:8] or re.search(r"\d", w)][:3]
    return {"pauses": pauses, "key_terms": key_terms}


def _finalise(project: Project, tr: dict) -> dict:
    thr = get_settings()["transcription"]["low_confidence_threshold"]
    mode = tr.get("language_mode", "auto")
    uncertain = []
    for i, w in enumerate(tr["words"]):
        w["i"] = i
        if w.get("prob") is not None and w["prob"] < thr:
            uncertain.append({"i": i, "word": w["word"], "start": w["start"], "prob": w["prob"]})
    tr["segments"] = tr.get("segments") or _words_to_segments(tr["words"])
    for s in tr["segments"]:
        s["flags"] = sorted(set(s.get("flags", [])) | set(_script_flags(s["text"], mode)))
        a, b = s["word_range"]
        if any(u["i"] >= a and u["i"] <= b for u in uncertain):
            s["flags"] = sorted(set(s["flags"]) | {"low_confidence_words"})
    tr["uncertain_words"] = uncertain
    tr.update(analyse_structure(tr))
    tr["needs_review"] = bool(uncertain) or any(s["flags"] for s in tr["segments"]) or tr.get("text_missing", False)
    tr["updated_at"] = now_iso()
    project.write_json("audio/transcript.json", tr)
    (project.path("audio", "transcript.txt")).write_text(
        "\n".join(f"[{s['start']:7.2f}-{s['end']:7.2f}] {s['text']}" for s in tr["segments"]), encoding="utf-8")
    project.data["status"] = "transcribed"
    project.log_event(f"transcript saved ({tr.get('engine')}, {len(tr['words'])} words)")
    project.save()
    return tr


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------
def transcribe(project: Project, language_mode: str = "roman_urdu", model: str | None = None,
               allow_model_download: bool = False, on_progress: Callable[[float], None] | None = None,
               cancel_check: Callable[[], None] | None = None) -> dict:
    vo = project.voiceover()
    if not vo:
        raise ValueError("No voiceover imported. Use import_voiceover first (or import the video's own audio).")
    s = get_settings()
    cfg = s["transcription"]
    model = model or cfg["model"]
    wav = prepare_voice_wav(project, vo)
    total = float(media_info(wav)["duration"] or 0)
    engine = pick_engine()

    if engine is None:
        regions = speech_regions(wav, total)
        tr = {"engine": "none", "model": None, "language_mode": language_mode, "duration": total,
              "words": [], "segments": [], "speech_regions": regions, "text_missing": True,
              "created_at": now_iso(),
              "message": "No speech-recognition engine installed. Speech regions were detected; provide the exact "
                         "script with align_script, or install faster-whisper (see README)."}
        for i, (a, b) in enumerate(regions):
            tr["segments"].append({"id": i, "start": a, "end": b, "text": "", "word_range": [0, -1], "flags": ["no_text"]})
        project.write_json("audio/transcript.json", tr)
        return tr

    if not model_cached(engine, model) and not (allow_model_download or cfg.get("allow_model_download")):
        sizes = {"tiny": "75 MB", "base": "145 MB", "small": "490 MB", "medium": "1.5 GB", "large-v3": "3 GB",
                 "large-v3-turbo": "1.6 GB"}
        raise PermissionError(
            f"The Whisper model '{model}' ({sizes.get(model, 'size unknown')}) is not downloaded yet. "
            "Ask the user for permission, then call transcribe_voiceover again with allow_model_download=true.")

    lang, prompt = None, None
    if language_mode in ("roman_urdu", "mixed"):
        lang, prompt = "en", (ROMAN_URDU_PROMPT if language_mode == "roman_urdu" else MIXED_PROMPT)
    elif language_mode == "english":
        lang = "en"

    words: list[dict] = []
    if engine == "faster-whisper":
        from faster_whisper import WhisperModel
        device = cfg["device"] if cfg["device"] != "auto" else "auto"
        compute = cfg["compute_type"]
        if compute == "auto":  # int8 is the fastest accurate mode on CPUs (Intel/AMD); float16 on NVIDIA GPUs
            try:
                import ctranslate2
                gpu = device != "cpu" and ctranslate2.get_cuda_device_count() > 0
            except Exception:  # noqa: BLE001
                gpu = False
            compute = "float16" if gpu else "int8"
        wm = WhisperModel(model, device=device, compute_type=compute, download_root=str(s.models_dir),
                          local_files_only=not (allow_model_download or cfg.get("allow_model_download")))
        # Pass decoded samples, not a path: faster-whisper's own PyAV decoder breaks with PyAV >= 19
        # ("open() got an unexpected keyword argument 'metadata_errors'"). FFmpeg already made the WAV.
        segments, info = wm.transcribe(load_wav_16k(wav), language=lang, task="transcribe", initial_prompt=prompt,
                                       word_timestamps=True, vad_filter=True, beam_size=5,
                                       condition_on_previous_text=False)
        detected = info.language
        for seg in segments:
            if cancel_check:
                cancel_check()
            for w in seg.words or []:
                words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3),
                              "prob": round(w.probability, 3)})
            if on_progress and total:
                on_progress(min(0.99, seg.end / total))
    else:
        import whisper
        wm = whisper.load_model(model, download_root=str(s.models_dir))
        res = wm.transcribe(str(wav), language=lang, task="transcribe", initial_prompt=prompt, word_timestamps=True,
                            condition_on_previous_text=False, fp16=False)
        detected = res.get("language")
        for seg in res["segments"]:
            for w in seg.get("words", []):
                words.append({"word": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3),
                              "prob": round(w.get("probability", 1.0), 3)})
    words = [w for w in words if w["word"]]
    tr = {"engine": engine, "model": model, "language_mode": language_mode, "detected_language": detected,
          "duration": total, "words": words, "segments": [], "created_at": now_iso(),
          "speech_regions": speech_regions(wav, total)}
    if language_mode in ("roman_urdu", "mixed") and detected not in (None, "en", "ur", "hi"):
        tr.setdefault("warnings", []).append(f"Recogniser detected language '{detected}'. Please review the text.")
    return _finalise(project, tr)


# ---------------------------------------------------------------------------
# Manual correction & script alignment
# ---------------------------------------------------------------------------
def _retime(words_text: list[str], start: float, end: float) -> list[dict]:
    weights = [max(1, len(w)) + 1 for w in words_text]
    tot = sum(weights)
    out, t = [], start
    for w, k in zip(words_text, weights):
        d = (end - start) * k / tot
        out.append({"word": w, "start": round(t, 3), "end": round(t + d * 0.92, 3), "prob": None, "edited": True})
        t += d
    return out


def correct_transcript(project: Project, segment_id: int | None = None, new_text: str | None = None,
                       replacements: list[dict] | None = None) -> dict:
    tr = project.read_json("audio/transcript.json")
    if not tr:
        raise ValueError("No transcript yet. Run transcribe_voiceover first.")
    words = tr["words"]
    if replacements:
        for r in replacements:
            frm, to = r.get("from", ""), r.get("to", "")
            if not frm:
                continue
            pat = re.compile(r"(?<![\w])" + re.escape(frm) + r"(?![\w])", re.I if r.get("ignore_case", True) else 0)
            for w in words:
                if pat.search(w["word"]):
                    w["word"] = pat.sub(to, w["word"])
                    w["prob"] = None
                    w["edited"] = True
    if segment_id is not None and new_text is not None:
        seg = next((s for s in tr["segments"] if s["id"] == segment_id), None)
        if seg is None:
            raise ValueError(f"Segment {segment_id} not found")
        a, b = seg["word_range"]
        new_words = _retime(new_text.split(), seg["start"], seg["end"])
        if b >= a:
            # keep real timings where the word count matches
            old = words[a:b + 1]
            if len(old) == len(new_words):
                for o, n in zip(old, new_words):
                    n["start"], n["end"] = o["start"], o["end"]
            words[a:b + 1] = new_words
        else:
            pos = next((i for i, w in enumerate(words) if w["start"] >= seg["start"]), len(words))
            words[pos:pos] = new_words
    tr["words"] = words
    tr["segments"] = []
    tr["text_missing"] = False
    tr["manually_corrected"] = True
    return _finalise(project, tr)


def align_script(project: Project, script: str, language_mode: str | None = None) -> dict:
    """Align the exact spoken script to the voice timing.

    If recognised words exist, timings are transferred with sequence alignment; otherwise the script is
    distributed over detected speech regions proportionally to text length. The supplied text is
    used verbatim - nothing is rewritten or translated.
    """
    tr = project.read_json("audio/transcript.json")
    vo = project.voiceover()
    if not vo:
        raise ValueError("No voiceover imported.")
    if not tr:
        wav = prepare_voice_wav(project, vo)
        total = float(media_info(wav)["duration"] or 0)
        tr = {"engine": "none", "duration": total, "words": [], "speech_regions": speech_regions(wav, total)}
    script_words = script.split()
    if not script_words:
        raise ValueError("Script is empty")
    rec = tr.get("words") or []
    new: list[dict | None] = [None] * len(script_words)
    if rec:
        norm = lambda x: re.sub(r"[^\w]", "", x.lower())  # noqa: E731
        sm = difflib.SequenceMatcher(a=[norm(w["word"]) for w in rec], b=[norm(w) for w in script_words], autojunk=False)
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                rw = rec[blk.a + k]
                new[blk.b + k] = {"word": script_words[blk.b + k], "start": rw["start"], "end": rw["end"], "prob": rw.get("prob")}
        matched = sum(1 for x in new if x)
        # fill gaps by interpolation between anchors
        i = 0
        while i < len(new):
            if new[i] is None:
                j = i
                while j < len(new) and new[j] is None:
                    j += 1
                t0 = new[i - 1]["end"] if i > 0 else (rec[0]["start"] if rec else 0.0)
                t1 = new[j]["start"] if j < len(new) else rec[-1]["end"]
                if t1 <= t0:
                    t1 = t0 + 0.25 * (j - i)
                for k, w in enumerate(_retime(script_words[i:j], t0, t1)):
                    new[i + k] = w
                i = j
            else:
                i += 1
        method = f"sequence_alignment ({matched}/{len(script_words)} words anchored)"
    else:
        regions = tr.get("speech_regions") or [(0.0, tr["duration"])]
        total_speech = sum(b - a for a, b in regions)
        total_chars = sum(len(w) + 1 for w in script_words)
        idx = 0
        for ri, (a, b) in enumerate(regions):
            share = (b - a) / total_speech
            n_chars = share * total_chars
            chunk, c = [], 0.0
            while idx < len(script_words) and (c < n_chars or ri == len(regions) - 1):
                chunk.append(script_words[idx])
                c += len(script_words[idx]) + 1
                idx += 1
            for k, w in enumerate(_retime(chunk, a, b)):
                new[idx - len(chunk) + k] = w
        method = "proportional_over_speech_regions"
    tr["words"] = [w for w in new if w]
    tr["segments"] = []
    tr["text_missing"] = False
    tr["script_supplied"] = True
    tr["alignment_method"] = method
    if language_mode:
        tr["language_mode"] = language_mode
    return _finalise(project, tr)

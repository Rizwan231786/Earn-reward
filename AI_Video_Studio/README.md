# AI Video Studio for Claude Desktop

AI Video Studio turns Claude Desktop into a local, AI-controlled video editing workstation. Give it your
footage and a voiceover, then say **"Edit this video professionally."** Claude then:

1. analyses the media,
2. transcribes the voiceover (Roman Urdu stays in Roman Urdu),
3. plans an edit to your saved **Premium Commercial** profile,
4. matches footage to the narration,
5. adds captions, motion graphics, sound design and colour correction,
6. renders and checks the final MP4.

Everything runs on your PC with FFmpeg. There are no paid APIs and nothing is uploaded.

```
Claude Desktop ──MCP (stdio)──► studio.server ─► media analysis · transcription · planner
                                              ─► renderer (FFmpeg) · captions (libass) · graphics (Pillow)
                                              ─► audio engine · colour · validation · export
Optional: start_dashboard.bat ─► http://127.0.0.1:8765 (same projects and jobs)
```

---

## 1. Install (Windows 10/11)

Requirements: **Python 3.10+** (3.12 recommended), **FFmpeg**, and **Claude Desktop**.

1. Copy the `AI_Video_Studio` folder somewhere permanent, for example `C:\Tools\AI_Video_Studio`.
2. Double-click **`install.bat`**. It:
   - checks Python and FFmpeg (and offers `winget install Gyan.FFmpeg` if FFmpeg is missing),
   - creates `.venv` and installs the dependencies, including `faster-whisper` for local speech-to-text,
   - creates the studio folders and self-tests the MCP server,
   - offers to register the server in Claude Desktop. It makes a timestamped backup of
     `claude_desktop_config.json` and asks before changing it.
3. **Fully quit Claude Desktop** (tray icon → Quit) and start it again. The studio's tools then
   appear in the tools (🔨) menu.

You can also run the steps separately: `scripts\check_env.py` (environment report),
`setup_claude_desktop.bat` (MCP registration only), `run_tests.bat` (test suite).

### Manual Claude Desktop configuration

Edit `%APPDATA%\Claude\claude_desktop_config.json`. For the Microsoft Store build, the file is
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`. Add the block below, using **your**
absolute paths:

```json
{
  "mcpServers": {
    "ai-video-studio": {
      "command": "C:\\Tools\\AI_Video_Studio\\.venv\\Scripts\\python.exe",
      "args": ["-m", "studio.server"],
      "env": { "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1" }
    }
  }
}
```

`.venv\Scripts\python.exe scripts\configure_claude_desktop.py --print` prints the exact block for your PC.

---

## 2. Everyday use

1. Put your files in the **inbox**: `Documents\AI_Video_Studio\inbox`. You can also give Claude full
   paths, or drag files into the dashboard.
   > Files you attach in the Claude chat are **not** saved to your disk, so the studio can't read
   > them. Use the inbox or a file path instead.
2. In Claude Desktop, type:

   > Edit `clinic_raw.mp4` with `voiceover.wav` professionally as a 9:16 Reel. Doctor: Dr. Ayesha Khan,
   > Consultant Dermatologist. CTA: "Book your consultation", 0300-1234567. Use generated music.

3. Claude follows the built-in workflow:
   `create_project → import → analyze_media → analyze_video_content (Claude looks at the scenes) →
   transcribe_voiceover → create_editing_plan`. It shows you the plan, including any **missing visuals**.
4. Approve the plan or ask for changes ("make captions phrase-style", "remove the stat card",
   "use clip 2 for the reception part"). Claude then renders a **preview**, and after your OK, the
   **final** video.
5. Output goes to `Documents\AI_Video_Studio\projects\project_00X\exports\`:
   `final_video.mp4`, `captions.srt`, `editing_timeline.json`, `project_settings.json` and `project_assets/`.

The MCP prompt **"edit_video_professionally"** (in Claude's prompt menu) starts the same workflow
from a form.

### Talking-head videos

If the voice is recorded **in** the video, import the same file as the voiceover. The planner switches to
**sync mode**:

- lip-sync is preserved,
- pauses are tightened on picture and sound together (when enabled),
- long takes get subtle alternating punch-ins,
- other clips are used only as B-roll cut-aways that genuinely match the words.

### Roman Urdu

- `transcribe_voiceover(language_mode="roman_urdu" | "mixed" | "english")` keeps Latin script and never
  translates.
- Any Devanagari or Arabic-script output is flagged and kept out of captions.
- Words the engine is unsure of are listed for review. Fix them with `correct_transcript`, or give Claude
  the exact script, which `align_script` time-aligns to the voice. That gives the best caption accuracy,
  and it works even without a speech engine.
- The Whisper model (`small` ≈ 490 MB by default) is **downloaded only after you approve it**.

---

## 3. Tools exposed to Claude

| Area | Tools |
|---|---|
| System | `get_system_status`, `list_inbox` |
| Projects | `create_project`, `list_projects`, `get_project`, `export_project` |
| Import | `import_video`, `import_voiceover`, `import_asset` (music, sfx, logo, image, broll, lut) |
| Analysis | `analyze_media` (metadata, scenes, thumbnails, measurements), `analyze_video_content` (returns frames for Claude to see), `describe_scenes` |
| Voice | `transcribe_voiceover`, `get_transcript`, `correct_transcript`, `align_script` |
| Planning | `create_editing_plan`, `get_editing_plan`, `update_editing_plan` |
| Elements | `generate_captions`, `add_graphics`, `add_background_music`, `add_sound_effects`, `list_sound_library` |
| Render | `preview_video`, `execute_video_edit`, `render_video`, `get_render_status`, `cancel_render` |
| Profiles | `load_editing_profile`, `update_editing_profile`, `set_active_profile` |

Long operations run in the background. Claude polls `get_render_status`, and `cancel_render` stops
FFmpeg safely. Rendered segments are cached, so a re-render after a small change, or after an
interruption, only re-encodes what changed.

---

## 4. What the engine does

- **Editing**: voice-led shots cut on word boundaries and paced by the profile. Each shot gets the best
  scene by meaning (Claude's scene descriptions vs. the narration), quality, forward continuity and a
  no-repeat penalty. When nothing matches, the gap is listed under `missing_visuals` with a suggestion;
  nothing is fabricated.
- **Reframing**: 16:9 → 9:16 / 1:1 uses a subject-aware crop (gradient + skin-tone weighting) or a
  blurred-fill background. Footage is never stretched.
- **Colour**: measured per shot and gentle: partial gray-world white balance, exposure via gamma,
  contrast, highlight roll-off and shadow lift, a saturation cap, and shot matching to a shared reference.
  An optional creative look and optional `.cube` LUT both have adjustable strength. There is no skin
  smoothing.
- **Captions**: ASS subtitles burned in with libass. Modes: phrase, word-highlight, word-by-word,
  karaoke. Numbers and keywords are highlighted, placement respects mobile safe zones, and SRT is
  exported too. Graphics automatically move out of the caption zone.
- **Graphics** (Pillow, supersampled, animated by FFmpeg with eased slide/rise/fade): title card,
  lower third, info card, stat card, callout, notification bubble, smartphone mockup, process steps,
  checklist, location card, CTA end card, kinetic typography, logo bug, image card. They use the
  profile's palette (turquoise, white, ice blue, navy) and the bundled Inter, Manrope and Montserrat
  fonts (OFL).
- **Audio**: voice chain (high-pass, adaptive FFT denoise, EQ, gentle compression, two-pass EBU R128
  loudness to −14 LUFS, limiter), optional pause tightening with caption re-timing, music ducked under
  the voice with a sidechain compressor, and fades.
- **SFX and music**: built-in **procedurally generated, royalty-free** SFX (whooshes, UI taps,
  notification chime, impacts, shimmer, riser, pop) and an optional generated ambient music bed. For
  commercial music, import a track you own or have licensed.
- **Export**: MP4 H.264 High, yuv420p, Rec.709 tags, AAC 48 kHz stereo, the original frame rate, and
  `+faststart`. Every render is validated: the file opens, has the right dimensions and an audio stream,
  matches the expected duration, and decodes fully without errors. Existing exports are never overwritten.

## 4b. Motion-explainer style (designed scenes like premium clinic Reels)

Profile **`motion_explainer`**: about half of the video is full-screen designed scenes that illustrate exactly what is
being said. The other half is the speaker on camera with animated overlays. Ask Claude:

> Edit this as a motion explainer Reel using the motion_explainer profile, like my reference ad.

Claude plans the edit, then calls **`set_storyboard`**. Every scene or overlay is tied to a phrase from the voiceover
(`at_text`), so the studio finds the exact time itself. Claude can check any design with **`preview_graphic`**.

| Full-screen scenes | Overlays on the speaker |
|---|---|
| `scene_headline`: kinetic headline, huge accent word (FREE), floating cards hook | `label_pill`: top label (EXPERIENCED DERMATOLOGIST) |
| `scene_phone`: phone with booking calendar, patient chat, or **video call with the real footage inside** | `counter`: count-up stat (12+ → 17+ YEARS) |
| `scene_flow`: journey diagram (FIRST CONSULTATION → FREE) | `credential_card`: title + experience |
| `scene_steps`: numbered steps appearing one by one | `headline_card`: FIRST CONSULTATION **FREE** |
| `scene_icons`: lifestyle tiles or a big icon circle with tags | `chat_bubbles`: floating messages + "N replies today" counter |
| `scene_cards`: skin-type cards | |
| `scene_cta`: end card with the doctor's photo (from your footage), WhatsApp button, phone number | |

- Each element animates in on its own (staggered rise, slide and fade).
- Scenes slide in and out of the footage, and lip-sync is kept after every scene.
- Overlays never appear on top of a scene.
- Captions are small navy **pills** with keywords in turquoise.

**Roman Urdu accuracy:** if the transcript shows English sentences where the speaker actually spoke Urdu, Whisper
translated the speech. Re-run with `language_mode="roman_urdu_via_urdu"`: Whisper writes Urdu script, which it never
translates, and Claude converts every line to Roman Urdu with `romanize_transcript`, keeping the timing. The studio
warns automatically when a transcript looks translated.

## 4c. AI Editor in the dashboard (Claude does the whole edit)

Open the dashboard (`start_dashboard.bat` → http://127.0.0.1:8765). The **🎬 AI Editor** card at the top lets you:

1. tick the inbox files and say what each one is,
2. write, in any language, what video you want,
3. fill in the facts that may appear on screen (name, credentials, WhatsApp),
4. click **✨ Create with Claude**.

Behind the scenes the dashboard runs **Claude Code** headlessly (`claude -p`) on **your Claude subscription**. It
removes `ANTHROPIC_API_KEY` from that run, so nothing is billed to API credits by accident. Claude gets *only* the
studio's tools (no shell, no file editing). It works through the full workflow (analyse, transcribe and romanize,
plan, storyboard, preview, and optionally the final render and export), and its steps stream live into the
dashboard. Type changes in **"Want changes?"** and Claude continues the same edit.

One-time setup: install Claude Code (PowerShell: `irm https://claude.ai/install.ps1 | iex`), then run
`claude auth login` and sign in with your Claude account. The card shows whether you are logged in.
Keep the dashboard window open while Claude works.

## 5. Editing profiles

The default is **PREMIUM COMMERCIAL EDITING PROFILE**. The others are `healthcare_dermatology`,
`real_estate`, `product_ad`, `corporate`, `youtube`, `reels_shorts`, `educational`, `cinematic` and `motion_explainer`.
Change preferences permanently by asking Claude, for example: *"Update my profile: captions at the
bottom, uppercase, music a bit quieter."* That calls `update_editing_profile`, and the overrides are
saved in `Documents\AI_Video_Studio\profiles\`.

## 6. Configuration

Copy `config.example.json` to `Documents\AI_Video_Studio\config.json` to change any of these:

- allowed input folders (the default is your user folder plus the inbox; anything else is refused),
- FFmpeg paths,
- Whisper model, device and compute type (CUDA is used automatically if available),
- render quality,
- vision provider: `claude` by default, or `ollama` for a local LLaVA-style model,
- dashboard port.

`.env.example` lists the environment variable overrides.

## 7. Safety rules built in

- Originals are never modified. Imports are hard-linked or copied into the project.
- Exports are never overwritten without explicit confirmation.
- Names, credentials, CTA text and statistics come only from your brief or from the spoken words.
  Testimonials and before/after visuals are never invented.
- The original voice is never replaced with synthetic speech, and a real person's identity is never
  changed.
- Music needs your licence confirmation (`i_confirm_license`). SFX are generated locally.
- Model downloads need your approval. Nothing is uploaded or published.
- The dashboard binds to 127.0.0.1 only, and paths are sandboxed to the allowed folders.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| Tools don't show in Claude | Fully quit Claude Desktop from the tray and restart. Check `%APPDATA%\Claude\logs\mcp-server-ai-video-studio.log`. |
| "FFmpeg not found" | `winget install Gyan.FFmpeg`, then open a new terminal, or set `AIVS_FFMPEG` in `.env`. |
| Transcription asks for permission | Expected: the Whisper model downloads once after you agree. |
| "Access denied … outside the allowed folders" | Move the file to the inbox, or add its folder to `allowed_input_dirs`. |
| Render failed | `get_render_status` shows the FFmpeg error. The full log is in `Documents\AI_Video_Studio\logs\studio.log`. |

## 9. Limitations (honest)

- **Scene understanding** comes from Claude looking at contact sheets (or a local Ollama vision
  model). Automatic metrics cover brightness, colour, motion, sharpness, likely people and subject
  position, but they don't recognise objects.
- **Remotion is not used**. It needs Node.js plus a headless Chrome renderer, and companies need a
  paid licence. The Pillow + FFmpeg + libass pipeline covers the required graphics with no extra
  runtime.
- **No synthetic B-roll is generated.** Missing visuals are reported with suggestions instead.
- The location card is an illustrative map pattern, not a real map.

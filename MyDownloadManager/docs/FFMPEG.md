# FFmpeg integration and licensing

## What FFmpeg is used for

Only to **remux** (container copy, `-c copy`) downloaded HLS/DASH tracks into MP4 (or MKV when MP4 cannot hold the
codecs) and to merge separate audio and video tracks. MyDownloadManager never re-encodes, never feeds FFmpeg a URL
and never uses FFmpeg to decrypt anything.

Invocation (`Media/Ffmpeg/FfmpegRunner.cs`):

```
ffmpeg -hide_banner -nostdin -loglevel error -y -protocol_whitelist file
       -i <work>\track0.ts [-i <work>\track1.mp4] -map ... -c copy -movflags +faststart -f mp4 <work>\output.mp4
```

- started with `UseShellExecute = false` and `ArgumentList` (no shell, no string concatenation ⇒ no injection),
- stdin closed, stderr captured with a 64 KB cap, process tree killed on cancel,
- all paths are absolute and inside the download's work folder,
- `-protocol_whitelist file` prevents a crafted input from making FFmpeg open network or other resources,
- a user-configured FFmpeg path must be an existing, absolute path to a file named `ffmpeg.exe`.

Lookup order: Settings → Media / FFmpeg path → `<app>\ffmpeg\ffmpeg.exe` (bundled) → `<app>\ffmpeg.exe` → `PATH`
(relative `PATH` entries are ignored).

Without FFmpeg: muxed HLS streams are still saved (as `.ts`, a byte-exact concatenation of the segments); DASH and
streams with separate audio report that FFmpeg is required and keep the downloaded segments for a later resume.

## Licensing and distribution

- MyDownloadManager is MIT-licensed and does **not** link to FFmpeg; it runs `ffmpeg.exe` as a separate program.
- The installer bundles an **LGPL-2.1-or-later** build (`win64-lgpl` from BtbN/FFmpeg-Builds). LGPL builds are
  sufficient because only stream copy is used (GPL-only components such as libx264 are not needed).
- `build/fetch-ffmpeg.ps1` downloads the build, verifies its **SHA-256** against the published `checksums.sha256`, and
  refuses binaries whose build configuration contains `--enable-gpl` or `--enable-nonfree`.
- Shipped alongside: `ffmpeg\FFMPEG-LICENSE.txt` (license text) and `ffmpeg\FFMPEG-SOURCE.txt` (exact asset, checksum,
  and where to get the corresponding source: https://github.com/FFmpeg/FFmpeg and https://github.com/BtbN/FFmpeg-Builds).
- If you redistribute the installer, keep those files and honour the LGPL's source-availability terms (pointing to the
  upstream source of the exact version is the usual practice; mirror the source if you need a stronger guarantee).
- To ship without FFmpeg, omit `-BundleFfmpeg` — the installer skips the folder automatically.
- The test suite uses a full FFmpeg (with libx264/libvpx) only to **generate** synthetic test videos; that binary is
  never shipped.

"FFmpeg" is a trademark of Fabrice Bellard. MyDownloadManager is not affiliated with the FFmpeg project.

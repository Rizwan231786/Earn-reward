# Third-party notices

MyDownloadManager is original software. It redistributes the following components in the Windows installer.

| Component | Used for | License |
|---|---|---|
| .NET 10 runtime, WPF, Windows Forms (Microsoft) | Application runtime (self-contained) | MIT |
| Microsoft.Extensions.DependencyInjection / Logging | Dependency injection, logging | MIT |
| Microsoft.Data.Sqlite | SQLite data access | MIT |
| SQLitePCLRaw (bundle e_sqlite3) | Native SQLite binding | Apache-2.0 |
| SQLite | Embedded database engine | Public domain |
| System.Security.Cryptography.ProtectedData | Windows DPAPI for encrypting stored secrets | MIT |
| CommunityToolkit.Mvvm | MVVM source generators | MIT |
| FFmpeg (optional, LGPL build from BtbN/FFmpeg-Builds) | Remuxing HLS/DASH audio and video (stream copy only) | LGPL-2.1-or-later |

## FFmpeg

When bundled, `ffmpeg\ffmpeg.exe` is an **LGPL** build of FFmpeg (no `--enable-gpl`, no `--enable-nonfree`).
It is executed as a separate process and is not linked into MyDownloadManager. Its license text is installed as
`ffmpeg\FFMPEG-LICENSE.txt`, and `ffmpeg\FFMPEG-SOURCE.txt` records the exact binary, its SHA-256 checksum and where
to obtain the corresponding source code (https://github.com/FFmpeg/FFmpeg, build scripts at
https://github.com/BtbN/FFmpeg-Builds). You may replace it with any other FFmpeg build (Settings → Media / FFmpeg).
FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

Development-only dependencies (not redistributed): xUnit (Apache-2.0), Microsoft.NET.Test.Sdk (MIT),
coverlet (MIT), ASP.NET Core / Kestrel for the in-process test server (MIT), Inno Setup for building the installer
(Inno Setup License), Node.js for building the browser extensions (MIT).

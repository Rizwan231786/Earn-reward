using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using MyDownloadManager.Media.Ffmpeg;
using MyDownloadManager.Tests.Infrastructure;

namespace MyDownloadManager.Tests.Media;

/// <summary>Skips a test when FFmpeg is not installed (media generation and merging need it).</summary>
public sealed class FfmpegFactAttribute : FactAttribute
{
    public FfmpegFactAttribute()
    {
        if (MediaFixture.FfprobePath() is null) Skip = "FFmpeg/ffprobe not found on PATH.";
    }
}

/// <summary>
/// Generates all test media locally with FFmpeg (synthetic test pattern + sine tone), so every stream used by the tests is
/// our own content: HLS (TS, fMP4, AES-128, multi-variant), DASH (separate audio/video), direct MP4 and WebM.
/// </summary>
public sealed class MediaFixture : IAsyncLifetime
{
    public const double Duration = 6;
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "mdm-media-fixture", Guid.NewGuid().ToString("N"));
    public bool Available { get; private set; }
    public byte[] AesKey { get; } = Convert.FromHexString("00112233445566778899AABBCCDDEEFF");

    public async Task InitializeAsync()
    {
        var ffmpeg = FfmpegLocator.Find();
        if (ffmpeg is null) return;
        Directory.CreateDirectory(Root);
        string[] src = ["-f", "lavfi", "-i", $"testsrc2=duration={Duration}:size=320x240:rate=25", "-f", "lavfi", "-i", $"sine=frequency=440:duration={Duration}"];
        string[] h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"];

        // HLS / MPEG-TS, two quality variants + master playlist.
        foreach (var (name, size) in new[] { ("hi", "320x240"), ("lo", "160x120") })
        {
            var dir = D("hls_ts", name);
            await Run(ffmpeg, [.. src, .. h264, "-s", size, "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
                "-hls_segment_filename", Path.Combine(dir, "seg_%03d.ts"), Path.Combine(dir, "index.m3u8")]);
        }
        await File.WriteAllTextAsync(Path.Combine(Root, "hls_ts", "master.m3u8"), """
            #EXTM3U
            #EXT-X-VERSION:3
            #EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x120,CODECS="avc1.42c00c,mp4a.40.2"
            lo/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x240,CODECS="avc1.42c00d,mp4a.40.2"
            hi/index.m3u8
            """);

        // HLS / fMP4 (CMAF) with init segment.
        var fmp4 = D("hls_fmp4");
        await Run(ffmpeg, [.. src, .. h264, "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
            "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", Path.Combine(fmp4, "seg_%03d.m4s"), Path.Combine(fmp4, "index.m3u8")]);

        // HLS with AES-128 clear-key encryption (standard HLS encryption, key served by "our" server).
        var aes = D("hls_aes");
        await File.WriteAllBytesAsync(Path.Combine(aes, "key.bin"), AesKey);
        var keyInfo = Path.Combine(Root, "keyinfo.txt");
        await File.WriteAllTextAsync(keyInfo, $"key.bin\n{Path.Combine(aes, "key.bin")}\n");
        await Run(ffmpeg, [.. src, .. h264, "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_key_info_file", keyInfo,
            "-hls_segment_filename", Path.Combine(aes, "seg_%03d.ts"), Path.Combine(aes, "index.m3u8")]);

        // DASH with separate video and audio adaptation sets (needs FFmpeg merging).
        var dash = D("dash");
        await Run(ffmpeg, [.. src, .. h264, "-map", "0:v", "-map", "1:a", "-f", "dash", "-seg_duration", "1", "-use_template", "1",
            "-use_timeline", "1", "-adaptation_sets", "id=0,streams=v id=1,streams=a", Path.Combine(dash, "manifest.mpd")]);

        // Direct files.
        var direct = D("direct");
        await Run(ffmpeg, [.. src, .. h264, "-movflags", "+faststart", Path.Combine(direct, "clip.mp4")]);
        await Run(ffmpeg, [.. src, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "200k", "-c:a", "libopus", Path.Combine(direct, "clip.webm")]);
        Available = true;
    }

    private string D(params string[] parts)
    {
        var p = Path.Combine([Root, .. parts]);
        Directory.CreateDirectory(p);
        return p;
    }

    private static async Task Run(string exe, string[] args)
    {
        var psi = new ProcessStartInfo(exe) { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false };
        foreach (var a in new[] { "-hide_banner", "-loglevel", "error", "-y" }.Concat(args)) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var err = await p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        if (p.ExitCode != 0) throw new InvalidOperationException($"ffmpeg failed: {err}");
    }

    public static string? FfprobePath()
    {
        var ffmpeg = FfmpegLocator.Find();
        if (ffmpeg is null) return null;
        var probe = Path.Combine(Path.GetDirectoryName(ffmpeg)!, OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe");
        return File.Exists(probe) ? probe : null;
    }

    public static (double Duration, string[] Codecs) Probe(string file)
    {
        var ffprobe = FfprobePath()!;
        var psi = new ProcessStartInfo(ffprobe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in new[] { "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file }) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var json = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new InvalidOperationException("ffprobe failed: " + p.StandardError.ReadToEnd());
        using var doc = JsonDocument.Parse(json);
        var duration = double.Parse(doc.RootElement.GetProperty("format").GetProperty("duration").GetString()!, CultureInfo.InvariantCulture);
        var codecs = doc.RootElement.GetProperty("streams").EnumerateArray().Select(s => s.GetProperty("codec_name").GetString()!).ToArray();
        return (duration, codecs);
    }

    public Task DisposeAsync()
    {
        try { Directory.Delete(Root, true); } catch (IOException) { }
        return Task.CompletedTask;
    }
}

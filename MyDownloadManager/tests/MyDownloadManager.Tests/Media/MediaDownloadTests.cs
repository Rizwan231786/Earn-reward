using System.Security.Cryptography;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;
using MyDownloadManager.Media;
using MyDownloadManager.Tests.Infrastructure;

namespace MyDownloadManager.Tests.Media;

public sealed class MediaDownloadTests(MediaFixture media) : IClassFixture<MediaFixture>, IAsyncLifetime
{
    private TestServer _server = null!;
    private readonly TempDir _dir = new();

    public async Task InitializeAsync()
    {
        _server = await TestServer.StartAsync();
        if (media.Available) _server.AddDirectory("m", media.Root);
    }

    public async Task DisposeAsync() { await _server.DisposeAsync(); _dir.Dispose(); }

    private async Task<DownloadItem> RunMediaAsync(string path, DownloadKind kind, Func<string?>? ffmpeg = null, MediaSelection? selection = null, RecordingObserver? observer = null)
    {
        using var engine = new MediaDownloadEngine(TestUtil.FastOptions(4), ffmpeg);
        var item = new DownloadItem { Url = _server.Url("m/" + path).AbsoluteUri, TargetDirectory = _dir.Path, Kind = kind, MediaSelection = selection?.ToJson() };
        await engine.RunAsync(item, new DownloadContext { Observer = observer ?? new RecordingObserver() }, CancellationToken.None);
        return item;
    }

    private static void AssertPlayable(string file, params string[] codecs)
    {
        var (duration, actual) = MediaFixture.Probe(file);
        Assert.InRange(duration, MediaFixture.Duration - 0.6, MediaFixture.Duration + 0.6);
        foreach (var c in codecs) Assert.Contains(c, actual);
    }

    [FfmpegFact]
    public async Task Hls_TsMasterPlaylist_PicksBestVariantAndRemuxesToMp4()
    {
        var item = await RunMediaAsync("hls_ts/master.m3u8", DownloadKind.Hls);
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.EndsWith(".mp4", item.FileName);
        AssertPlayable(item.FullPath, "h264", "aac");
        Assert.True(_server.RequestCount("m/hls_ts/hi/seg_000.ts") > 0);
        Assert.Equal(0, _server.RequestCount("m/hls_ts/lo/seg_000.ts"));
        Assert.Empty(Directory.GetDirectories(_dir.Path)); // work folder cleaned up
    }

    [FfmpegFact]
    public async Task Hls_SelectedVariantIsUsed()
    {
        await RunMediaAsync("hls_ts/master.m3u8", DownloadKind.Hls, selection: new MediaSelection { VideoId = "0" });
        Assert.True(_server.RequestCount("m/hls_ts/lo/seg_000.ts") > 0);
        Assert.Equal(0, _server.RequestCount("m/hls_ts/hi/seg_000.ts"));
    }

    [FfmpegFact]
    public async Task Hls_WithoutFfmpeg_ConcatenatesSegmentsByteExact()
    {
        var item = await RunMediaAsync("hls_ts/hi/index.m3u8", DownloadKind.Hls, ffmpeg: () => null);
        Assert.EndsWith(".ts", item.FileName);
        var segDir = Path.Combine(media.Root, "hls_ts", "hi");
        var expected = Directory.GetFiles(segDir, "seg_*.ts").Order(StringComparer.Ordinal).SelectMany(File.ReadAllBytes).ToArray();
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(expected)), TestUtil.FileSha256(item.FullPath));
        AssertPlayable(item.FullPath, "h264", "aac");
    }

    [FfmpegFact]
    public async Task Hls_Fmp4_WithInitSegment()
    {
        var item = await RunMediaAsync("hls_fmp4/index.m3u8", DownloadKind.Hls);
        AssertPlayable(item.FullPath, "h264", "aac");
    }

    [FfmpegFact]
    public async Task Hls_Aes128_IsDecrypted()
    {
        var item = await RunMediaAsync("hls_aes/index.m3u8", DownloadKind.Hls);
        AssertPlayable(item.FullPath, "h264", "aac");
        Assert.Equal(1, _server.RequestCount("m/hls_aes/key.bin")); // key fetched once and cached
    }

    [FfmpegFact]
    public async Task Dash_SeparateAudioVideo_AreMergedWithFfmpeg()
    {
        var item = await RunMediaAsync("dash/manifest.mpd", DownloadKind.Dash);
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal("dash.mp4", item.FileName); // generic "manifest" name → parent folder name
        AssertPlayable(item.FullPath, "h264", "aac");
    }

    [FfmpegFact]
    public async Task Dash_WithoutFfmpeg_ExplainsRequirement()
    {
        var ex = await Assert.ThrowsAsync<DownloadException>(() => RunMediaAsync("dash/manifest.mpd", DownloadKind.Dash, ffmpeg: () => null));
        Assert.Contains("FFmpeg", ex.Message);
    }

    [FfmpegFact]
    public async Task Media_PauseAndResume_SkipsCompletedSegments()
    {
        _server.AddDirectory("slow", Path.Combine(media.Root, "hls_ts", "hi"), new ServeOptions { DelayPerChunkMs = 60 });
        var item = new DownloadItem { Url = _server.Url("slow/index.m3u8").AbsoluteUri, TargetDirectory = _dir.Path, Kind = DownloadKind.Hls, MaxConnections = 2 };
        using var cts = new CancellationTokenSource();
        var totalSegments = Directory.GetFiles(Path.Combine(media.Root, "hls_ts", "hi"), "seg_*.ts").Length;
        // Pause as soon as at least one segment file has been finalized (not after N bytes: with parallel
        // connections and encoder-dependent segment sizes, N bytes may be spread over unfinished segments).
        var obs = new RecordingObserver
        {
            ProgressHook = _ =>
            {
                var w = item.TempFileName is null ? null : Path.Combine(_dir.Path, item.TempFileName + ".work");
                if (w is not null && Directory.Exists(w) && Directory.GetFiles(w, "t0_*.seg").Length > 0) cts.Cancel();
            },
        };
        using (var engine = new MediaDownloadEngine(TestUtil.FastOptions(2)))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.RunAsync(item, new DownloadContext { Observer = obs }, cts.Token));
        var work = Path.Combine(_dir.Path, item.TempFileName + ".work");
        // Segments whose file was finalized (renamed from .part) before the pause must never be fetched again.
        var completed = Directory.GetFiles(work, "t0_*.seg")
            .Select(f => int.Parse(Path.GetFileNameWithoutExtension(f)[3..]))
            .ToDictionary(i => $"slow/seg_{i:D3}.ts", i => _server.RequestCount($"slow/seg_{i:D3}.ts"));
        Assert.NotEmpty(completed);
        Assert.True(completed.Count < totalSegments, "the download should have been interrupted part-way");

        using (var engine = new MediaDownloadEngine(TestUtil.FastOptions(4)))
            await engine.RunAsync(item, new DownloadContext(), CancellationToken.None);
        foreach (var (path, before) in completed) Assert.Equal(before, _server.RequestCount(path));
        AssertPlayable(item.FullPath, "h264", "aac");
    }

    [FfmpegFact]
    public async Task DirectMp4AndWebm_DownloadByteExact()
    {
        using var engine = new HttpDownloadEngine(TestUtil.FastOptions(4));
        foreach (var name in new[] { "clip.mp4", "clip.webm" })
        {
            var item = TestUtil.Item(_server.Url("m/direct/" + name), _dir.Path);
            await engine.RunAsync(item, new DownloadContext(), CancellationToken.None);
            Assert.Equal(TestUtil.FileSha256(Path.Combine(media.Root, "direct", name)), TestUtil.FileSha256(item.FullPath));
            Assert.Equal(FileCategories.Video, item.Category);
        }
        AssertPlayable(Path.Combine(_dir.Path, "clip.webm"), "vp9", "opus");
    }

    [FfmpegFact]
    public async Task Inspect_ListsVariants()
    {
        using var client = new HttpClient();
        var resolver = new MediaResolver(client, TestUtil.FastOptions());
        var info = await resolver.InspectAsync(new DownloadItem { Url = _server.Url("m/hls_ts/master.m3u8").AbsoluteUri, TargetDirectory = _dir.Path }, CancellationToken.None);
        Assert.Equal(MediaFormat.Hls, info.Format);
        Assert.Equal(2, info.Variants.Count);
        Assert.Null(info.BlockReason);
        Assert.InRange(info.DurationSeconds!.Value, 5.5, 6.5);

        var dash = await resolver.InspectAsync(new DownloadItem { Url = _server.Url("m/dash/manifest.mpd").AbsoluteUri, TargetDirectory = _dir.Path }, CancellationToken.None);
        Assert.Equal(MediaFormat.Dash, dash.Format);
        Assert.Single(dash.Variants);
        Assert.Single(dash.AudioRenditions);
    }

    [Fact]
    public async Task DrmProtectedStream_IsRefusedWithExplanation()
    {
        _server.Add("drm/index.m3u8", new BytesContent("""
            #EXTM3U
            #EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://some-key",KEYFORMAT="com.apple.streamingkeydelivery"
            #EXTINF:1,
            a.ts
            #EXT-X-ENDLIST
            """u8.ToArray()));
        using var engine = new MediaDownloadEngine(TestUtil.FastOptions(), () => null);
        var item = new DownloadItem { Url = _server.Url("drm/index.m3u8").AbsoluteUri, TargetDirectory = _dir.Path, Kind = DownloadKind.Hls };
        var ex = await Assert.ThrowsAsync<DownloadException>(() => engine.RunAsync(item, new DownloadContext(), CancellationToken.None));
        Assert.Contains("DRM", ex.Message);
        Assert.Contains("does not circumvent", ex.Message);
        Assert.Equal(0, _server.RequestCount("drm/a.ts"));
    }

    [Fact]
    public async Task LiveStream_IsRefused()
    {
        _server.Add("live/index.m3u8", new BytesContent("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n"u8.ToArray()));
        using var engine = new MediaDownloadEngine(TestUtil.FastOptions(), () => null);
        var item = new DownloadItem { Url = _server.Url("live/index.m3u8").AbsoluteUri, TargetDirectory = _dir.Path, Kind = DownloadKind.Hls };
        var ex = await Assert.ThrowsAsync<DownloadException>(() => engine.RunAsync(item, new DownloadContext(), CancellationToken.None));
        Assert.Contains("live stream", ex.Message);
    }

    [Fact]
    public async Task KeyRequiringAuthorization_IsNotBypassed()
    {
        _server.Add("auth/index.m3u8", new BytesContent("""
            #EXTM3U
            #EXT-X-KEY:METHOD=AES-128,URI="/auth/key"
            #EXTINF:1,
            a.ts
            #EXT-X-ENDLIST
            """u8.ToArray()));
        _server.Add("auth/a.ts", BytesContent.Random(32, 1));
        _server.Add("auth/key", BytesContent.Random(16, 2), new ServeOptions { RequireCookie = "session=ok" });
        using var engine = new MediaDownloadEngine(TestUtil.FastOptions(), () => null);
        var item = new DownloadItem { Url = _server.Url("auth/index.m3u8").AbsoluteUri, TargetDirectory = _dir.Path, Kind = DownloadKind.Hls };
        var ex = await Assert.ThrowsAsync<DownloadException>(() => engine.RunAsync(item, new DownloadContext(), CancellationToken.None));
        Assert.Contains("not available to this session", ex.Message);
    }
}

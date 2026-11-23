using System.Diagnostics;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;
using MyDownloadManager.Tests.Infrastructure;

namespace MyDownloadManager.Tests.Engine;

public sealed class DownloadEngineTests : IAsyncLifetime
{
    private TestServer _server = null!;
    private readonly TempDir _dir = new();

    public async Task InitializeAsync() => _server = await TestServer.StartAsync();
    public async Task DisposeAsync() { await _server.DisposeAsync(); _dir.Dispose(); }

    private async Task<DownloadItem> RunAsync(Uri url, EngineOptions? options = null, Action<DownloadItem>? configure = null, RecordingObserver? observer = null)
    {
        using var engine = new HttpDownloadEngine(options ?? TestUtil.FastOptions());
        var item = TestUtil.Item(url, _dir.Path);
        configure?.Invoke(item);
        await engine.RunAsync(item, new DownloadContext { Observer = observer ?? new RecordingObserver() }, CancellationToken.None);
        return item;
    }

    private void AssertNoTempFiles() =>
        Assert.Empty(Directory.GetFiles(_dir.Path, "*" + DownloadRun.TempExtension));

    [Fact]
    public async Task SingleConnection_DownloadsExactBytes()
    {
        var content = BytesContent.Random(3 * 1024 * 1024 + 17, 1);
        var url = _server.Add("single.bin", content);
        var item = await RunAsync(url, TestUtil.FastOptions(connections: 1));

        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal("single.bin", item.FileName);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Equal(1, _server.RequestCount("single.bin"));
        AssertNoTempFiles();
    }

    [Fact]
    public async Task MultiConnection_UsesParallelRangesAndHashMatches()
    {
        var content = BytesContent.Random(8 * 1024 * 1024 + 3, 2);
        var url = _server.Add("multi.bin", content, new ServeOptions { DelayPerChunkMs = 1 });
        var observer = new RecordingObserver();
        var item = await RunAsync(url, TestUtil.FastOptions(connections: 6), observer: observer);

        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.True(item.SupportsRanges);
        Assert.True(_server.RequestCount("multi.bin") >= 6, "expected one request per segment");
        Assert.True(observer.MaxActiveConnections > 1, $"expected parallel connections, saw {observer.MaxActiveConnections}");
        Assert.Contains(_server.Requests, r => r.Path == "/multi.bin" && r.Range is not null && !r.Range.StartsWith("bytes=0-", StringComparison.Ordinal));
        AssertNoTempFiles();
    }

    [Fact]
    public async Task ServerWithoutRangeSupport_FallsBackToSingleConnection()
    {
        var content = BytesContent.Random(2 * 1024 * 1024, 3);
        var url = _server.Add("norange.bin", content, new ServeOptions { SupportRanges = false });
        var observer = new RecordingObserver();
        var item = await RunAsync(url, TestUtil.FastOptions(connections: 8), observer: observer);

        Assert.False(item.SupportsRanges);
        Assert.Equal(1, _server.RequestCount("norange.bin")); // probe response body is reused, no second request
        Assert.True(observer.MaxActiveConnections <= 1);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
    }

    [Fact]
    public async Task ChunkedResponseWithUnknownLength_Completes()
    {
        var content = BytesContent.Random(1_500_000, 4);
        var url = _server.Add("chunked.bin", content, new ServeOptions { SupportRanges = false, Chunked = true });
        var item = await RunAsync(url);

        Assert.Equal(content.Length, item.TotalBytes);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
    }

    [Fact]
    public async Task FollowsRedirectChain()
    {
        var content = BytesContent.Random(700_000, 5);
        _server.Add("target.zip", content);
        var item = await RunAsync(_server.Url("redirect/3/target.zip"));

        Assert.EndsWith("/target.zip", item.ResolvedUrl);
        Assert.Equal("target.zip", item.FileName);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Equal(FileCategories.Compressed, item.Category);
    }

    [Fact]
    public async Task TooManyRedirects_Fails()
    {
        _server.Add("t.bin", BytesContent.Random(10, 6));
        var ex = await Assert.ThrowsAsync<DownloadException>(() => RunAsync(_server.Url("redirect/15/t.bin")));
        Assert.Contains("redirect", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RedirectToUnsafeScheme_IsRejected()
    {
        var ex = await Assert.ThrowsAsync<DownloadException>(() => RunAsync(_server.Url("redirect-abs/file__/etc/passwd")));
        Assert.Contains("Unsafe redirect", ex.Message);
    }

    [Fact]
    public async Task InterruptedConnections_AreRetriedAndResumedWithRanges()
    {
        var content = BytesContent.Random(4 * 1024 * 1024, 7);
        var url = _server.Add("flaky.bin", content, new ServeOptions { FailAfterBytes = 300_000, FailCount = 4 });
        var observer = new RecordingObserver();
        var item = await RunAsync(url, TestUtil.FastOptions(connections: 2), observer: observer);

        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Contains(observer.Logs, l => l.Contains("Retry", StringComparison.Ordinal));
        Assert.True(_server.RequestCount("flaky.bin") > 2);
    }

    [Fact]
    public async Task InterruptedConnection_WithoutRanges_RestartsFromZero()
    {
        var content = BytesContent.Random(1024 * 1024, 8);
        var url = _server.Add("flaky-norange.bin", content, new ServeOptions { SupportRanges = false, FailAfterBytes = 200_000, FailCount = 2 });
        var item = await RunAsync(url);

        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Equal(3, _server.RequestCount("flaky-norange.bin"));
        Assert.DoesNotContain(_server.Requests, r => r.Path == "/flaky-norange.bin" && r.Range is not null && r.Range != "bytes=0-");
    }

    [Fact]
    public async Task PersistentFailure_GivesUpAfterMaxRetries()
    {
        var url = _server.Add("broken.bin", BytesContent.Random(1024 * 1024, 9), new ServeOptions { FailAfterBytes = 1000, FailCount = 1000 });
        var opts = TestUtil.FastOptions(1);
        opts.MaxRetries = 2;
        var ex = await Assert.ThrowsAsync<DownloadException>(() => RunAsync(url, opts));
        Assert.False(ex.IsTransient);
        Assert.Contains("Gave up", ex.Message);
    }

    [Fact]
    public async Task PauseThenResume_ProducesIdenticalFile()
    {
        var content = BytesContent.Random(3 * 1024 * 1024, 10);
        var url = _server.Add("pause.bin", content, new ServeOptions { DelayPerChunkMs = 5 });
        var item = TestUtil.Item(url, _dir.Path);
        using var cts = new CancellationTokenSource();
        var observer = new RecordingObserver { };
        observer.ProgressHook = p => { if (p.DownloadedBytes > 600_000) cts.Cancel(); };

        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(4)))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.RunAsync(item, new DownloadContext { Observer = observer }, cts.Token));

        Assert.NotEqual(DownloadStatus.Completed, item.Status);
        Assert.NotNull(item.TempFileName);
        Assert.True(File.Exists(Path.Combine(_dir.Path, item.TempFileName!)));
        var partial = item.Segments.Sum(s => s.Downloaded);
        Assert.InRange(partial, 1, content.Length - 1);
        var requestsBefore = _server.Requests.Count;

        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(4)))
            await engine.RunAsync(item, new DownloadContext(), CancellationToken.None);

        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        var resumed = _server.Requests.Skip(requestsBefore).Where(r => r.Range is not null && r.Range != "bytes=0-").ToList();
        Assert.NotEmpty(resumed);
        Assert.All(resumed, r => Assert.Equal(content.ETag, r.IfRange));
        AssertNoTempFiles();
    }

    [Fact]
    public async Task RecoveryAfterCrash_FromLastCheckpointOnly()
    {
        // Simulates an app/PC crash: only the last persisted checkpoint survives, in-memory state is lost.
        var content = BytesContent.Random(4 * 1024 * 1024, 11);
        var url = _server.Add("crash.bin", content, new ServeOptions { DelayPerChunkMs = 4 });
        var item = TestUtil.Item(url, _dir.Path);
        using var cts = new CancellationTokenSource();
        var observer = new RecordingObserver();
        observer.ProgressHook = p => { if (p.DownloadedBytes > 1_500_000) cts.Cancel(); };
        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(3)))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.RunAsync(item, new DownloadContext { Observer = observer }, cts.Token));

        // Pick an *earlier* checkpoint than the final one to model a crash between checkpoints.
        var checkpoints = observer.Checkpoints.ToArray();
        Assert.True(checkpoints.Length >= 2);
        var older = checkpoints[checkpoints.Length / 2];
        var recovered = new DownloadItem
        {
            Id = item.Id, Url = item.Url, TargetDirectory = item.TargetDirectory, FileName = item.FileName,
            TempFileName = item.TempFileName, TotalBytes = item.TotalBytes, ETag = item.ETag, LastModified = item.LastModified,
            SupportsRanges = item.SupportsRanges, Segments = older.Segments, DownloadedBytes = older.Downloaded,
        };
        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(3)))
            await engine.RunAsync(recovered, new DownloadContext(), CancellationToken.None);

        Assert.Equal(content.Sha256(), TestUtil.FileSha256(recovered.FullPath));
    }

    [Fact]
    public async Task ResumeAfterRemoteFileChanged_RestartsAndGetsNewContent()
    {
        var v1 = BytesContent.Random(2 * 1024 * 1024, 12);
        var url = _server.Add("changing.bin", v1, new ServeOptions { DelayPerChunkMs = 5 });
        var item = TestUtil.Item(url, _dir.Path);
        using var cts = new CancellationTokenSource();
        var observer = new RecordingObserver { ProgressHook = p => { if (p.DownloadedBytes > 400_000) cts.Cancel(); } };
        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(2)))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.RunAsync(item, new DownloadContext { Observer = observer }, cts.Token));

        var v2 = BytesContent.Random(2 * 1024 * 1024, 13); // same size, different ETag
        _server.Add("changing.bin", v2);
        var obs2 = new RecordingObserver();
        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(2)))
            await engine.RunAsync(item, new DownloadContext { Observer = obs2 }, CancellationToken.None);

        Assert.Equal(v2.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Contains(obs2.Logs, l => l.Contains("ETag changed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task NotFound_FailsWithoutLeavingFiles()
    {
        var ex = await Assert.ThrowsAsync<DownloadException>(() => RunAsync(_server.Url("missing.bin")));
        Assert.Contains("404", ex.Message);
        Assert.False(ex.IsTransient);
        Assert.Empty(Directory.GetFiles(_dir.Path));
    }

    [Fact]
    public async Task ServerError_IsRetriedThenReported()
    {
        var opts = TestUtil.FastOptions();
        opts.MaxRetries = 1;
        var ex = await Assert.ThrowsAsync<DownloadException>(() => RunAsync(_server.Url("status/503"), opts));
        Assert.Contains("503", ex.Message);
        Assert.Equal(2, _server.RequestCount("status/503"));
    }

    [Theory]
    [InlineData("file:///etc/passwd")]
    [InlineData("javascript:alert(1)")]
    [InlineData("ftp://example.com/x")]
    [InlineData("not a url")]
    public async Task InvalidUrls_AreRejected(string url)
    {
        using var engine = new HttpDownloadEngine(TestUtil.FastOptions());
        var item = new DownloadItem { Url = url, TargetDirectory = _dir.Path };
        await Assert.ThrowsAsync<DownloadException>(() => engine.RunAsync(item, new DownloadContext(), CancellationToken.None));
    }

    [Fact]
    public async Task BasicAuth_SentToSameOriginOnly()
    {
        var content = BytesContent.Random(100_000, 14);
        _server.Add("secure.bin", content, new ServeOptions { RequireBasicAuth = "alice:s3cret" });
        var item = await RunAsync(_server.Url("secure.bin"), configure: i => { i.UserName = "alice"; i.Password = "s3cret"; });
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));

        await Assert.ThrowsAsync<DownloadException>(() => RunAsync(_server.Url("secure.bin")));

        // Cross-origin redirect (127.0.0.1 → localhost): credentials and cookies must be stripped.
        _server.Add("public.bin", content);
        var crossTarget = $"http__localhost:{_server.BaseUri.Port}/public.bin";
        await RunAsync(_server.Url("redirect-abs/" + crossTarget), configure: i =>
        {
            i.UserName = "alice"; i.Password = "s3cret"; i.Cookies = "session=abc";
            i.FileName = "cross.bin";
        });
        var crossRequests = _server.Requests.Where(r => r.Path == "/public.bin").ToList();
        Assert.NotEmpty(crossRequests);
        Assert.All(crossRequests, r => { Assert.Null(r.Authorization); Assert.Null(r.Cookie); });
    }

    [Fact]
    public async Task Cookies_AreForwardedToOrigin()
    {
        var content = BytesContent.Random(50_000, 15);
        var url = _server.Add("cookie.bin", content, new ServeOptions { RequireCookie = "token=xyz" });
        await Assert.ThrowsAsync<DownloadException>(() => RunAsync(url));
        var item = await RunAsync(url, configure: i => { i.Cookies = "token=xyz; other=1"; i.FileName = "c.bin"; });
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
    }

    [Fact]
    public async Task ContentDisposition_IsSanitizedAndStaysInFolder()
    {
        var content = BytesContent.Random(1000, 16);
        var url = _server.Add("dl", content, new ServeOptions { ContentDisposition = "attachment; filename=\"../../evil:name?.exe\"" });
        var item = await RunAsync(url);
        Assert.Equal("evil_name_.exe", item.FileName);
        Assert.Equal(Path.GetFullPath(_dir.Path), Path.GetDirectoryName(item.FullPath));
        Assert.Equal(FileCategories.Programs, item.Category);
    }

    [Fact]
    public async Task ContentDispositionUtf8_FileNameStarIsUsed()
    {
        var url = _server.Add("x", BytesContent.Random(10, 17), new ServeOptions { ContentDisposition = "attachment; filename=\"fallback.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" });
        var item = await RunAsync(url);
        Assert.Equal("résumé.pdf", item.FileName);
    }

    [Fact]
    public async Task ExistingFile_IsNeverOverwritten()
    {
        var content = BytesContent.Random(5000, 18);
        var url = _server.Add("dup.txt", content);
        await File.WriteAllTextAsync(Path.Combine(_dir.Path, "dup.txt"), "keep me");
        var a = await RunAsync(url);
        var b = await RunAsync(url);
        Assert.Equal("dup (1).txt", a.FileName);
        Assert.Equal("dup (2).txt", b.FileName);
        Assert.Equal("keep me", await File.ReadAllTextAsync(Path.Combine(_dir.Path, "dup.txt")));
    }

    [Fact]
    public async Task ExpectedChecksum_MatchAndMismatch()
    {
        var content = BytesContent.Random(300_000, 19);
        var url = _server.Add("sum.bin", content);
        var ok = await RunAsync(url, configure: i => i.ExpectedChecksum = "sha256:" + content.Sha256());
        Assert.Equal(DownloadStatus.Completed, ok.Status);

        var ex = await Assert.ThrowsAsync<DownloadException>(() =>
            RunAsync(url, configure: i => { i.ExpectedChecksum = "sha256:" + new string('0', 64); i.FileName = "bad.bin"; }));
        Assert.Contains("Integrity check failed", ex.Message);
        Assert.False(File.Exists(Path.Combine(_dir.Path, "bad.bin")));
        AssertNoTempFiles();
    }

    [Fact]
    public async Task ZeroLengthFile_Completes()
    {
        var url = _server.Add("empty.txt", new BytesContent([]));
        var item = await RunAsync(url);
        Assert.Equal(0, item.TotalBytes);
        Assert.Equal(0, new FileInfo(item.FullPath).Length);
    }

    [Fact]
    public async Task SpeedLimit_IsEnforced()
    {
        var content = BytesContent.Random(768 * 1024, 20);
        var url = _server.Add("slow.bin", content);
        using var engine = new HttpDownloadEngine(TestUtil.FastOptions(4));
        var item = TestUtil.Item(url, _dir.Path);
        var sw = Stopwatch.StartNew();
        await engine.RunAsync(item, new DownloadContext { DownloadLimiter = new RateLimiter(256 * 1024) }, CancellationToken.None);
        sw.Stop();
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        // 768 KB at 256 KB/s with a 64 KB burst ≈ 2.75 s minimum.
        Assert.True(sw.Elapsed > TimeSpan.FromSeconds(2.2), $"took only {sw.Elapsed}");
    }

    [Fact]
    public async Task WeakETag_FallsBackToLastModifiedForIfRange()
    {
        var content = BytesContent.Random(1024 * 1024, 21);
        var url = _server.Add("weak.bin", content, new ServeOptions { WeakETag = true });
        var item = await RunAsync(url);
        Assert.Null(item.ETag);
        Assert.NotNull(item.LastModified);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Contains(_server.Requests, r => r.Path == "/weak.bin" && r.IfRange == content.LastModified.ToString("R"));
    }

    [Fact]
    [Trait("Category", "Large")]
    public async Task LargeFile_Over4GB_MultiConnection()
    {
        if (Environment.GetEnvironmentVariable("MDM_SKIP_LARGE") == "1") return;
        var content = new GeneratedContent(4L * 1024 * 1024 * 1024 + 12345, 0xC0FFEE);
        var url = _server.Add("huge.bin", content);
        var opts = TestUtil.FastOptions(8);
        opts.MinSegmentSize = 8 * 1024 * 1024;
        opts.BufferSize = 256 * 1024;
        opts.CheckpointInterval = TimeSpan.FromSeconds(2);
        var item = await RunAsync(url, opts);
        Assert.Equal(content.Length, new FileInfo(item.FullPath).Length);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        File.Delete(item.FullPath);
    }
}

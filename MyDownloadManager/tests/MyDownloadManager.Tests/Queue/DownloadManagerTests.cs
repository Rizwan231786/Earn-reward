using Microsoft.Data.Sqlite;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Persistence;
using MyDownloadManager.Tests.Infrastructure;

namespace MyDownloadManager.Tests.Queue;

public sealed class DownloadManagerTests : IAsyncLifetime
{
    private TestServer _server = null!;
    private readonly TempDir _dir = new();
    private readonly List<IAsyncDisposable> _disposables = [];
    private string Downloads => Path.Combine(_dir.Path, "downloads");

    public async Task InitializeAsync() => _server = await TestServer.StartAsync();

    public async Task DisposeAsync()
    {
        foreach (var d in _disposables) await d.DisposeAsync();
        await _server.DisposeAsync();
        SqliteConnection.ClearAllPools();
        _dir.Dispose();
    }

    private (DownloadManager Manager, SqliteDownloadRepository Repo) CreateManager(Action<AppSettings>? configure = null)
    {
        var db = new SqliteDatabase(Path.Combine(_dir.Path, "mdm.db"));
        var repo = new SqliteDownloadRepository(db, SecretProtectorFactory.Create(_dir.Path));
        var settings = new AppSettings { DefaultDownloadDirectory = Downloads, MaxConcurrentDownloads = 3 };
        configure?.Invoke(settings);
        var engine = new HttpDownloadEngine(TestUtil.FastOptions(4));
        var manager = new DownloadManager(engine, repo, settings, new SqliteEventLog(db));
        _disposables.Add(manager);
        return (manager, repo);
    }

    private static async Task WaitUntil(Func<bool> condition, int timeoutMs = 20000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task Add_DownloadsIntoCategoryFolderAndPersists()
    {
        var content = BytesContent.Random(1024 * 1024, 100);
        var url = _server.Add("music/song.mp3", content);
        var (m, repo) = CreateManager();
        await m.InitializeAsync(startTimer: false);

        var item = await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri });
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(20));

        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal(Path.Combine(Downloads, FileCategories.Music), item.TargetDirectory);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        await WaitUntil(() => repo.GetAsync(item.Id).Result?.Status == DownloadStatus.Completed);
    }

    [Fact]
    public async Task ConcurrencyLimit_IsRespected()
    {
        var (m, _) = CreateManager(s => s.MaxConcurrentDownloads = 2);
        await m.InitializeAsync(startTimer: false);
        var maxRunning = 0;
        m.ItemChanged += _ => maxRunning = Math.Max(maxRunning, m.ActiveCount);
        var items = new List<DownloadItem>();
        for (var i = 0; i < 5; i++)
        {
            var url = _server.Add($"c{i}.bin", BytesContent.Random(300_000, 200 + i), new ServeOptions { DelayPerChunkMs = 3 });
            items.Add(await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri }));
        }
        Assert.True(m.ActiveCount <= 2);
        foreach (var it in items) await m.WaitForIdleAsync(it.Id, TimeSpan.FromSeconds(30));
        Assert.All(items, i => Assert.Equal(DownloadStatus.Completed, i.Status));
        Assert.InRange(maxRunning, 1, 2);
    }

    [Fact]
    public async Task PauseResume_ThroughManager()
    {
        var content = BytesContent.Random(4 * 1024 * 1024, 101);
        var url = _server.Add("pr.bin", content, new ServeOptions { DelayPerChunkMs = 25 });
        var (m, repo) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var item = await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri });
        await WaitUntil(() => item.DownloadedBytes > 300_000);
        Assert.NotEqual(DownloadStatus.Completed, item.Status);

        await m.PauseAsync(item.Id);
        Assert.Equal(DownloadStatus.Paused, item.Status);
        var persisted = await repo.GetAsync(item.Id);
        Assert.Equal(DownloadStatus.Paused, persisted!.Status);
        Assert.NotEmpty(persisted.Segments);
        Assert.True(persisted.Segments.Sum(s => s.Downloaded) > 0);

        await m.StartAsync(item.Id);
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(30));
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
    }

    [Fact]
    public async Task Cancel_DeletesPartialData()
    {
        var url = _server.Add("cancel.bin", BytesContent.Random(4 * 1024 * 1024, 102), new ServeOptions { DelayPerChunkMs = 30 });
        var (m, _) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var item = await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri });
        await WaitUntil(() => item.DownloadedBytes > 100_000);
        Assert.NotEqual(DownloadStatus.Completed, item.Status);
        var temp = Path.Combine(item.TargetDirectory, item.TempFileName!);
        Assert.True(File.Exists(temp));

        await m.CancelAsync(item.Id);
        Assert.Equal(DownloadStatus.Cancelled, item.Status);
        Assert.False(File.Exists(temp));
        Assert.Empty(item.Segments);
    }

    [Fact]
    public async Task Remove_WithDeleteFile()
    {
        var url = _server.Add("rm.txt", BytesContent.Random(1000, 103));
        var (m, repo) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var item = await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri });
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(10));
        Assert.True(File.Exists(item.FullPath));

        await m.RemoveAsync(item.Id, deleteFile: true);
        Assert.False(File.Exists(item.FullPath));
        Assert.Empty(m.Items);
        Assert.Null(await repo.GetAsync(item.Id));
    }

    [Fact]
    public async Task GracefulShutdown_ResumesOnNextLaunch()
    {
        var content = BytesContent.Random(4 * 1024 * 1024, 104);
        var url = _server.Add("shutdown.bin", content, new ServeOptions { DelayPerChunkMs = 25 });
        var (m1, _) = CreateManager();
        await m1.InitializeAsync(startTimer: false);
        var item = await m1.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri });
        await WaitUntil(() => item.DownloadedBytes > 500_000);
        Assert.NotEqual(DownloadStatus.Completed, item.Status);
        await m1.DisposeAsync(); // app exit
        SqliteConnection.ClearAllPools();

        var (m2, _) = CreateManager();
        await m2.InitializeAsync(startTimer: false);
        var restored = m2.Find(item.Id)!;
        Assert.True(restored.Segments.Sum(s => s.Downloaded) > 0);
        await m2.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(30));
        Assert.Equal(DownloadStatus.Completed, restored.Status);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(restored.FullPath));
        // The second session resumed instead of starting over: it issued at least one mid-file range request.
        Assert.Contains(_server.Requests, r => r.Path == "/shutdown.bin" && r.Range is { } rg && rg != "bytes=0-" && !rg.StartsWith("bytes=0-", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CrashRecovery_ItemLeftInDownloadingState_IsResumed()
    {
        // Produce a partial download exactly as a crash would leave it: temp file + checkpoint + "Downloading" status.
        var content = BytesContent.Random(4 * 1024 * 1024, 105);
        var url = _server.Add("crash2.bin", content, new ServeOptions { DelayPerChunkMs = 20 });
        Directory.CreateDirectory(Downloads);
        var item = TestUtil.Item(url, Downloads);
        var observer = new RecordingObserver();
        using var cts = new CancellationTokenSource();
        observer.ProgressHook = p => { if (p.DownloadedBytes > 800_000) cts.Cancel(); };
        using (var engine = new HttpDownloadEngine(TestUtil.FastOptions(3)))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.RunAsync(item, new DownloadContext { Observer = observer }, cts.Token));
        var checkpoint = observer.Checkpoints.First(c => c.Downloaded > 0);
        item.Status = DownloadStatus.Downloading;

        var (_, repo) = CreateManager();
        await repo.UpsertAsync(item, checkpoint.Segments);
        SqliteConnection.ClearAllPools();

        var (m, _) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var restored = m.Find(item.Id)!;
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(30));
        Assert.Equal(DownloadStatus.Completed, restored.Status);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(restored.FullPath));
    }

    [Fact]
    public async Task FailedDownload_ReportsErrorAndCanBeRetried()
    {
        var (m, _) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var item = await m.AddAsync(new AddDownloadRequest { Url = _server.Url("later.bin").AbsoluteUri });
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(10));
        Assert.Equal(DownloadStatus.Failed, item.Status);
        Assert.Contains("404", item.ErrorMessage);

        var content = BytesContent.Random(10_000, 106);
        _server.Add("later.bin", content);
        await m.StartAsync(item.Id);
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(10));
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Null(item.ErrorMessage);
    }

    [Fact]
    public async Task InvalidRequests_AreRejected()
    {
        var (m, _) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        await Assert.ThrowsAsync<ArgumentException>(() => m.AddAsync(new AddDownloadRequest { Url = "file:///etc/passwd" }));
        await Assert.ThrowsAsync<ArgumentException>(() => m.AddAsync(new AddDownloadRequest { Url = "https://x.com/a", TargetDirectory = "relative/dir" }));
        Assert.Empty(m.Items);
    }

    [Fact]
    public async Task BatchAdd_AndPausedAdd()
    {
        var (m, _) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var urls = Enumerable.Range(0, 3).Select(i => _server.Add($"batch{i}.dat", BytesContent.Random(5000, 300 + i))).ToList();
        var items = await m.AddBatchAsync(urls.Select(u => new AddDownloadRequest { Url = u.AbsoluteUri, StartImmediately = false }));
        Assert.All(items, i => Assert.Equal(DownloadStatus.Paused, i.Status));
        await m.StartAllAsync();
        foreach (var i in items) await m.WaitForIdleAsync(i.Id, TimeSpan.FromSeconds(10));
        Assert.All(items, i => Assert.Equal(DownloadStatus.Completed, i.Status));
        Assert.Equal([0, 1, 2], items.Select(i => i.QueueOrder));
    }

    [Theory]
    [InlineData("01:00", "05:00", "03:00", true)]
    [InlineData("01:00", "05:00", "05:00", false)]
    [InlineData("23:00", "06:00", "02:00", true)]
    [InlineData("23:00", "06:00", "12:00", false)]
    public void ScheduleWindow(string start, string stop, string now, bool expected) =>
        Assert.Equal(expected, DownloadManager.IsWithinWindow(TimeOnly.Parse(start), TimeOnly.Parse(stop), TimeOnly.Parse(now)));

    [Fact]
    public async Task ScheduledDownload_StartsWhenDue()
    {
        var url = _server.Add("sched.bin", BytesContent.Random(5000, 107));
        var (m, _) = CreateManager();
        await m.InitializeAsync(startTimer: false);
        var at = DateTimeOffset.Now.AddHours(2);
        var item = await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri, ScheduledAt = at });
        Assert.Equal(DownloadStatus.Scheduled, item.Status);

        m.Tick(at.AddMinutes(-1));
        Assert.Equal(DownloadStatus.Scheduled, item.Status);
        m.Tick(at.AddSeconds(1));
        await m.WaitForIdleAsync(item.Id, TimeSpan.FromSeconds(10));
        Assert.Equal(DownloadStatus.Completed, item.Status);
    }

    [Fact]
    public async Task ScheduleWindow_StartsQueueAndPausesAtStop()
    {
        var now = DateTimeOffset.Now;
        var start = TimeOnly.FromDateTime(now.LocalDateTime.AddMinutes(-10));
        var stop = TimeOnly.FromDateTime(now.LocalDateTime.AddMinutes(10));
        var url = _server.Add("window.bin", BytesContent.Random(2 * 1024 * 1024, 108), new ServeOptions { DelayPerChunkMs = 10 });
        var (m, _) = CreateManager(s => { s.ScheduleStart = start; s.ScheduleStop = stop; });
        await m.InitializeAsync(startTimer: false);
        var item = await m.AddAsync(new AddDownloadRequest { Url = url.AbsoluteUri, UseSchedule = true });
        Assert.Equal(DownloadStatus.Scheduled, item.Status);

        m.Tick(now);
        await WaitUntil(() => item.DownloadedBytes > 50_000);
        m.Tick(now.AddMinutes(20)); // past stop time
        await WaitUntil(() => item.Status == DownloadStatus.Scheduled);
        Assert.Equal(0, m.ActiveCount);
    }

    [Fact]
    public async Task GlobalSpeedLimit_AppliesAcrossDownloads()
    {
        var (m, _) = CreateManager(s => s.GlobalSpeedLimit = 300 * 1024);
        await m.InitializeAsync(startTimer: false);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var a = await m.AddAsync(new AddDownloadRequest { Url = _server.Add("g1.bin", BytesContent.Random(450 * 1024, 109)).AbsoluteUri });
        var b = await m.AddAsync(new AddDownloadRequest { Url = _server.Add("g2.bin", BytesContent.Random(450 * 1024, 110)).AbsoluteUri });
        await m.WaitForIdleAsync(a.Id, TimeSpan.FromSeconds(30));
        await m.WaitForIdleAsync(b.Id, TimeSpan.FromSeconds(30));
        Assert.True(sw.Elapsed.TotalSeconds > 2.3, $"900 KB at 300 KB/s finished in {sw.Elapsed}");
    }
}

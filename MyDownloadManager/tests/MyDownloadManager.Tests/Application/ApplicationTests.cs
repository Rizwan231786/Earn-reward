using System.Collections.Concurrent;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using MyDownloadManager.Application;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Integration;
using MyDownloadManager.Tests.Infrastructure;
using MyDownloadManager.Tests.Media;

namespace MyDownloadManager.Tests.Application;

public sealed class FakeUi : IUserInteraction
{
    public ConcurrentQueue<(IReadOnlyList<string> Urls, string? Referrer)> Dialogs { get; } = new();
    public ConcurrentQueue<(string Title, string Message)> Notifications { get; } = new();
    public int Activations;
    public void ShowAddDialog(IReadOnlyList<string> urls, string? referrer = null) => Dialogs.Enqueue((urls, referrer));
    public void Notify(string title, string message) => Notifications.Enqueue((title, message));
    public void ActivateMainWindow() => Interlocked.Increment(ref Activations);
}

/// <summary>Full-stack tests: real DI composition, SQLite, engines, manager and the browser request handler.</summary>
public sealed class ApplicationTests(MediaFixture media) : IClassFixture<MediaFixture>, IAsyncLifetime
{
    private readonly TempDir _dir = new();
    private readonly FakeUi _ui = new();
    private TestServer _server = null!;
    private ServiceProvider _sp = null!;
    private DownloadManager Manager => _sp.GetRequiredService<DownloadManager>();
    private BrowserRequestHandler Handler => _sp.GetRequiredService<BrowserRequestHandler>();

    public async Task InitializeAsync()
    {
        _server = await TestServer.StartAsync();
        if (media.Available) _server.AddDirectory("m", media.Root);
        var services = new ServiceCollection();
        services.AddMyDownloadManager(new AppPaths(Path.Combine(_dir.Path, "data")));
        services.AddSingleton<IUserInteraction>(_ui);
        _sp = services.BuildServiceProvider();
        var settings = _sp.GetRequiredService<SettingsService>();
        var s = settings.Current;
        s.DefaultDownloadDirectory = Path.Combine(_dir.Path, "Downloads");
        s.ProxyMode = ProxyMode.None;
        await settings.SaveAsync(s);
        await Manager.InitializeAsync(startTimer: false);
    }

    public async Task DisposeAsync()
    {
        await Manager.DisposeAsync();
        await _sp.DisposeAsync();
        await _server.DisposeAsync();
        SqliteConnection.ClearAllPools();
        _dir.Dispose();
    }

    [Fact]
    public async Task BrowserDownload_WithCookies_IsAddedAndCompleted()
    {
        var content = BytesContent.Random(2 * 1024 * 1024, 500);
        var url = _server.Add("files/setup.exe", content, new ServeOptions { RequireCookie = "sid=42" });
        var reply = await Handler.HandleAsync(new BrowserMessage
        {
            Type = MessageTypes.Download, Url = url.AbsoluteUri, Cookies = "sid=42; theme=dark", Referrer = _server.Url("page").AbsoluteUri,
        }, CancellationToken.None);
        Assert.True(reply.Ok, reply.Error);
        var id = reply.Data!.Value.GetProperty("id").GetGuid();
        await Manager.WaitForIdleAsync(id, TimeSpan.FromSeconds(30));
        var item = Manager.Find(id)!;
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal(Path.Combine(_dir.Path, "Downloads", FileCategories.Programs, "setup.exe"), item.FullPath);
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(item.FullPath));
        Assert.Contains(_ui.Notifications, n => n.Title == "Download added");
    }

    [Fact]
    public async Task ThroughIpc_EndToEnd()
    {
        var pipe = "mdm-app-" + Guid.NewGuid().ToString("N");
        await using var server = new IpcServer(Handler.HandleAsync, pipe);
        server.Start();
        var content = BytesContent.Random(300_000, 501);
        var url = _server.Add("ipc.zip", content);
        var reply = await IpcClient.SendAsync(new BrowserMessage { Type = "download", Url = url.AbsoluteUri }, TimeSpan.FromSeconds(5), pipeName: pipe);
        Assert.True(reply.Ok, reply.Error);
        var id = reply.Data!.Value.GetProperty("id").GetGuid();
        await Manager.WaitForIdleAsync(id, TimeSpan.FromSeconds(30));
        Assert.Equal(content.Sha256(), TestUtil.FileSha256(Manager.Find(id)!.FullPath));

        var ping = await IpcClient.SendAsync(new BrowserMessage { Type = "ping" }, TimeSpan.FromSeconds(5), pipeName: pipe);
        Assert.True(ping.Ok);
        Assert.Equal(BrowserRequestHandler.Version, ping.Version);
    }

    [Fact]
    public async Task DisabledIntegration_RefusesDownloads()
    {
        var settings = _sp.GetRequiredService<SettingsService>();
        var s = settings.Current;
        s.BrowserIntegrationEnabled = false;
        await settings.SaveAsync(s);
        var reply = await Handler.HandleAsync(new BrowserMessage { Type = "download", Url = _server.Url("x.zip").AbsoluteUri }, CancellationToken.None);
        Assert.False(reply.Ok);
        Assert.Empty(Manager.Items);
    }

    [Fact]
    public async Task Batch_OpensConfirmationDialogInsteadOfDownloading()
    {
        var reply = await Handler.HandleAsync(new BrowserMessage { Type = "batch", Urls = ["https://a.example/1.zip", "https://a.example/2.zip"], Referrer = "https://a.example/" }, CancellationToken.None);
        Assert.True(reply.Ok);
        var dialog = Assert.Single(_ui.Dialogs);
        Assert.Equal(2, dialog.Urls.Count);
        Assert.Empty(Manager.Items);
    }

    [FfmpegFact]
    public async Task MediaMessage_Hls_DownloadsAndMerges()
    {
        var reply = await Handler.HandleAsync(new BrowserMessage
        {
            Type = "media", Url = _server.Url("m/hls_ts/master.m3u8").AbsoluteUri, MediaKind = "hls", PageTitle = "My Test Video: Part 1",
        }, CancellationToken.None);
        Assert.True(reply.Ok, reply.Error);
        var id = reply.Data!.Value.GetProperty("id").GetGuid();
        await Manager.WaitForIdleAsync(id, TimeSpan.FromSeconds(60));
        var item = Manager.Find(id)!;
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal("My Test Video_ Part 1.mp4", item.FileName);
        Assert.Equal(Path.Combine(_dir.Path, "Downloads", FileCategories.Video), item.TargetDirectory);
        var (duration, codecs) = MediaFixture.Probe(item.FullPath);
        Assert.InRange(duration, 5.4, 6.6);
        Assert.Contains("h264", codecs);
    }

    [Fact]
    public async Task MediaMessage_Drm_IsRefusedAndExplained()
    {
        _server.Add("drm.mpd", new BytesContent("""
            <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><Period>
              <AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
                <Representation id="v" bandwidth="1"><SegmentTemplate media="$Number$.m4s" duration="1"/></Representation></AdaptationSet>
            </Period></MPD>
            """u8.ToArray()));
        var reply = await Handler.HandleAsync(new BrowserMessage { Type = "media", Url = _server.Url("drm.mpd").AbsoluteUri, MediaKind = "dash" }, CancellationToken.None);
        Assert.False(reply.Ok);
        Assert.Contains("Widevine", reply.Error);
        Assert.Contains(_ui.Notifications, n => n.Message.Contains("does not circumvent", StringComparison.Ordinal));
        Assert.Empty(Manager.Items);
    }

    [Fact]
    public async Task SettingsChanges_ApplyToRunningServices()
    {
        var settings = _sp.GetRequiredService<SettingsService>();
        var s = settings.Current;
        s.MaxConcurrentDownloads = 7;
        s.GlobalSpeedLimit = 12345;
        await settings.SaveAsync(s);
        Assert.Equal(7, Manager.Settings.MaxConcurrentDownloads);
        Assert.Equal(12345, Manager.Settings.GlobalSpeedLimit);
        var reloaded = await _sp.GetRequiredService<MyDownloadManager.Core.Abstractions.ISettingsStore>().LoadAsync();
        Assert.Equal(7, reloaded.MaxConcurrentDownloads);
    }

    [Fact]
    public async Task Container_DisposesCleanlyLikeTheAppOnExit()
    {
        // Regression: the app used ServiceProvider.Dispose(), which throws for IAsyncDisposable-only services
        // (IpcServer, DownloadManager) — every app exit crashed. The app now disposes the container asynchronously.
        async Task<ServiceProvider> Compose(string name)
        {
            var services = new ServiceCollection();
            services.AddMyDownloadManager(new AppPaths(Path.Combine(_dir.Path, name)));
            services.AddSingleton<IUserInteraction>(_ui);
            var provider = services.BuildServiceProvider();
            provider.GetRequiredService<IpcServer>();
            await provider.GetRequiredService<DownloadManager>().InitializeAsync(startTimer: false);
            return provider;
        }

        var broken = await Compose("old-path");
        Assert.Throws<InvalidOperationException>(() => broken.Dispose());

        var fixedPath = await Compose("new-path");
        var ipc = fixedPath.GetRequiredService<IpcServer>();
        await fixedPath.GetRequiredService<DownloadManager>().DisposeAsync();
        await fixedPath.DisposeAsync();
        await ipc.DisposeAsync(); // idempotent
    }

    [Fact]
    public void ClipboardFilter_OffersDownloadableLinksOnce()
    {
        var f = new ClipboardUrlFilter();
        var s = new AppSettings();
        var text = "see https://x.com/a/file.zip and https://x.com/page.html and https://cdn.x.com/v/master.m3u8?t=1";
        Assert.Equal(["https://x.com/a/file.zip", "https://cdn.x.com/v/master.m3u8?t=1"], f.Filter(text, s));
        Assert.Empty(f.Filter(text, s)); // already offered
        Assert.Empty(f.Filter("file:///C:/secret.zip javascript:alert(1)", s));
    }

    [Fact]
    public void FileLogger_WritesStructuredLines()
    {
        var logs = Path.Combine(_dir.Path, "logs-test");
        using (var provider = new FileLoggerProvider(logs))
        {
            provider.CreateLogger("Test.Category").Log(Microsoft.Extensions.Logging.LogLevel.Warning, default, "hello\nworld", new InvalidOperationException("boom"), (st, _) => st);
        }
        var line = File.ReadAllText(Directory.GetFiles(logs).Single());
        Assert.Contains("WRN [Test.Category] hello world | InvalidOperationException: boom", line);
    }
}

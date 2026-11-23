using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine.Http;

namespace MyDownloadManager.Engine;

/// <summary>Per-run collaborators supplied by the download manager.</summary>
public sealed class DownloadContext
{
    public IDownloadObserver Observer { get; init; } = NullObserver.Instance;
    /// <summary>Limiter shared by all downloads (global speed limit).</summary>
    public RateLimiter? GlobalLimiter { get; init; }
    /// <summary>Limiter for this download only (per-download speed limit).</summary>
    public RateLimiter? DownloadLimiter { get; init; }
}

public interface IDownloadEngine
{
    /// <summary>
    /// Downloads (or resumes) <paramref name="item"/> to completion. On success the item is Completed and the file is
    /// in place. Throws <see cref="OperationCanceledException"/> when <paramref name="ct"/> is cancelled (pause/cancel)
    /// after persisting a consistent checkpoint, and <see cref="DownloadException"/> on permanent failure.
    /// </summary>
    Task RunAsync(DownloadItem item, DownloadContext context, CancellationToken ct);
}

/// <summary>Multi-connection HTTP/HTTPS download engine.</summary>
public sealed class HttpDownloadEngine : IDownloadEngine, IDisposable
{
    private HttpClient _client;
    private readonly HttpMessageHandler? _handlerOverride;
    private readonly ILogger _logger;

    public HttpDownloadEngine(EngineOptions options, ILogger<HttpDownloadEngine>? logger = null, HttpMessageHandler? handler = null)
    {
        Options = options;
        _handlerOverride = handler;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
        _client = HttpClientProvider.Create(options, handler);
    }

    public EngineOptions Options { get; private set; }

    internal HttpClient Client => _client;
    internal ILogger Logger => _logger;

    /// <summary>Applies new options. Network settings (proxy/timeouts) affect downloads started afterwards.</summary>
    public void Reconfigure(EngineOptions options)
    {
        Options = options;
        if (_handlerOverride is not null) return;
        var old = _client;
        _client = HttpClientProvider.Create(options);
        // Running downloads keep a reference to the old client; dispose it once they are likely done.
        _ = Task.Delay(TimeSpan.FromMinutes(10)).ContinueWith(_ => old.Dispose(), TaskScheduler.Default);
    }

    public Task RunAsync(DownloadItem item, DownloadContext context, CancellationToken ct) =>
        new DownloadRun(this, _client, Options, item, context).ExecuteAsync(ct);

    public void Dispose() => _client.Dispose();
}

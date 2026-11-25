using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;

namespace MyDownloadManager.Tests.Infrastructure;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "mdm-tests", Guid.NewGuid().ToString("N"));
    public TempDir() => Directory.CreateDirectory(Path);
    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Observer that records everything, used to assert engine behaviour.</summary>
public sealed class RecordingObserver : IDownloadObserver
{
    public ConcurrentQueue<DownloadStatus> Statuses { get; } = new();
    public ConcurrentQueue<string> Logs { get; } = new();
    public ConcurrentQueue<(List<DownloadSegment> Segments, long Downloaded)> Checkpoints { get; } = new();
    public int MaxActiveConnections;
    public long LastDownloaded;
    public Action<DownloadProgress>? ProgressHook { get; set; }

    public void OnStatusChanged(DownloadItem item, DownloadStatus status) => Statuses.Enqueue(status);
    public void OnLog(LogLevel level, string message) => Logs.Enqueue($"{level}: {message}");
    public void OnProgress(DownloadProgress p)
    {
        Interlocked.Exchange(ref LastDownloaded, p.DownloadedBytes);
        int cur;
        while ((cur = Volatile.Read(ref MaxActiveConnections)) < p.ActiveConnections &&
               Interlocked.CompareExchange(ref MaxActiveConnections, p.ActiveConnections, cur) != cur) { }
        ProgressHook?.Invoke(p);
    }
    public Task OnCheckpointAsync(DownloadItem item, IReadOnlyList<DownloadSegment> segments, long downloadedBytes)
    {
        Checkpoints.Enqueue((segments.Select(s => s.Clone()).ToList(), downloadedBytes));
        return Task.CompletedTask;
    }
}

public static class TestUtil
{
    public static EngineOptions FastOptions(int connections = 4) => new()
    {
        MaxConnections = connections,
        MinSegmentSize = 64 * 1024,
        RetryBaseDelay = TimeSpan.FromMilliseconds(20),
        RetryMaxDelay = TimeSpan.FromMilliseconds(200),
        ReadTimeout = TimeSpan.FromSeconds(10),
        CheckpointInterval = TimeSpan.FromMilliseconds(200),
        MaxRetries = 5,
        ProxyMode = ProxyMode.None,
    };

    public static string FileSha256(string path)
    {
        using var fs = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(fs));
    }

    public static DownloadItem Item(Uri url, string dir, string? fileName = null) =>
        new() { Url = url.AbsoluteUri, TargetDirectory = dir, FileName = fileName ?? "" };
}

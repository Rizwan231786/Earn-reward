using Microsoft.Extensions.Logging;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Engine;

/// <summary>Immutable progress snapshot published to the UI a few times per second.</summary>
public sealed record DownloadProgress(
    Guid Id,
    long DownloadedBytes,
    long? TotalBytes,
    double BytesPerSecond,
    TimeSpan? Eta,
    int ActiveConnections,
    IReadOnlyList<DownloadSegment> Segments)
{
    public double Fraction => TotalBytes is > 0 ? Math.Clamp((double)DownloadedBytes / TotalBytes.Value, 0, 1) : 0;
}

/// <summary>Receives engine callbacks. Implementations must be thread-safe and fast.</summary>
public interface IDownloadObserver
{
    void OnStatusChanged(DownloadItem item, DownloadStatus status) { }
    void OnProgress(DownloadProgress progress) { }
    /// <summary>Called after file data up to the snapshot has been flushed to disk; persist the snapshot here.</summary>
    Task OnCheckpointAsync(DownloadItem item, IReadOnlyList<DownloadSegment> segments, long downloadedBytes) => Task.CompletedTask;
    void OnLog(LogLevel level, string message) { }
}

public sealed class NullObserver : IDownloadObserver
{
    public static readonly NullObserver Instance = new();
}

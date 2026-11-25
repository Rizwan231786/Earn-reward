using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Engine.Queue;

/// <summary>Everything needed to create a download (from the UI, clipboard, batch import or browser extension).</summary>
public sealed class AddDownloadRequest
{
    public required string Url { get; init; }
    public string? FileName { get; init; }
    /// <summary>Null = default folder (with category sub-folder when enabled).</summary>
    public string? TargetDirectory { get; init; }
    public string? Referrer { get; init; }
    public IReadOnlyDictionary<string, string>? Headers { get; init; }
    public string? Cookies { get; init; }
    public string? UserName { get; init; }
    public string? Password { get; init; }
    public string? UserAgent { get; init; }
    public string? ExpectedChecksum { get; init; }
    public DownloadKind Kind { get; init; } = DownloadKind.File;
    public string? MediaSelection { get; init; }
    public int MaxConnections { get; init; }
    public long SpeedLimit { get; init; }
    /// <summary>Start right away (subject to the concurrency limit). False = add paused.</summary>
    public bool StartImmediately { get; init; } = true;
    /// <summary>Add to the scheduled queue (starts inside the schedule window or at <see cref="ScheduledAt"/>).</summary>
    public bool UseSchedule { get; init; }
    public DateTimeOffset? ScheduledAt { get; init; }
}

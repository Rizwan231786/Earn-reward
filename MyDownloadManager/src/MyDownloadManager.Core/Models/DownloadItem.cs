namespace MyDownloadManager.Core.Models;

/// <summary>Lifecycle state of a download.</summary>
public enum DownloadStatus
{
    Queued = 0,
    Scheduled = 1,
    Connecting = 2,
    Downloading = 3,
    Paused = 4,
    Merging = 5,
    Verifying = 6,
    Completed = 7,
    Failed = 8,
    Cancelled = 9,
}

/// <summary>What kind of resource the download represents.</summary>
public enum DownloadKind
{
    /// <summary>A plain HTTP(S) file.</summary>
    File = 0,
    /// <summary>An HLS (.m3u8) media playlist that is fetched segment by segment.</summary>
    Hls = 1,
    /// <summary>A DASH (.mpd) manifest; audio/video representations merged with FFmpeg.</summary>
    Dash = 2,
}

public static class DownloadStatusExtensions
{
    public static bool IsActive(this DownloadStatus s) =>
        s is DownloadStatus.Connecting or DownloadStatus.Downloading or DownloadStatus.Merging or DownloadStatus.Verifying;

    public static bool IsFinished(this DownloadStatus s) =>
        s is DownloadStatus.Completed or DownloadStatus.Cancelled;

    public static bool CanStart(this DownloadStatus s) =>
        s is DownloadStatus.Queued or DownloadStatus.Scheduled or DownloadStatus.Paused or DownloadStatus.Failed;
}

/// <summary>
/// A byte range of the target file downloaded by a single connection.
/// <see cref="End"/> is inclusive. Thread-safety is provided by the engine which owns the instance while running.
/// </summary>
public sealed class DownloadSegment
{
    public int Index { get; set; }
    public long Start { get; set; }
    public long End { get; set; }
    public long Downloaded { get; set; }

    public long Length => End - Start + 1;
    public long Remaining => Math.Max(0, Length - Downloaded);
    public long NextOffset => Start + Downloaded;
    public bool IsComplete => Downloaded >= Length;

    public DownloadSegment Clone() => new() { Index = Index, Start = Start, End = End, Downloaded = Downloaded };
    public override string ToString() => $"#{Index} [{Start}-{End}] {Downloaded}/{Length}";
}

/// <summary>
/// Persistent description of a download. Credentials and cookies are kept here in memory only;
/// the persistence layer stores them encrypted through <see cref="Abstractions.ISecretProtector"/>.
/// </summary>
public sealed class DownloadItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Url { get; set; }
    /// <summary>URL after redirects (used for segment requests).</summary>
    public string? ResolvedUrl { get; set; }
    public string? Referrer { get; set; }
    public string FileName { get; set; } = "";
    public required string TargetDirectory { get; set; }
    public string Category { get; set; } = FileCategories.General;
    public DownloadKind Kind { get; set; } = DownloadKind.File;
    public DownloadStatus Status { get; set; } = DownloadStatus.Queued;

    /// <summary>Total length in bytes, or null when the server does not report it.</summary>
    public long? TotalBytes { get; set; }
    public long DownloadedBytes { get; set; }
    public bool? SupportsRanges { get; set; }
    public string? ETag { get; set; }
    public string? LastModified { get; set; }
    public string? ContentType { get; set; }

    /// <summary>Maximum parallel connections for this download (1..32). 0 = use global default.</summary>
    public int MaxConnections { get; set; }
    /// <summary>Per-download speed limit in bytes/second. 0 = unlimited.</summary>
    public long SpeedLimit { get; set; }

    public Dictionary<string, string> Headers { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public string? Cookies { get; set; }
    public string? UserName { get; set; }
    public string? Password { get; set; }
    public string? UserAgent { get; set; }

    /// <summary>Optional expected checksum, e.g. "sha256:abcd...". Verified after completion.</summary>
    public string? ExpectedChecksum { get; set; }

    /// <summary>Relative name of the in-progress temp file inside <see cref="TargetDirectory"/>.</summary>
    public string? TempFileName { get; set; }

    public List<DownloadSegment> Segments { get; set; } = [];

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
    public DateTimeOffset? ScheduledAt { get; set; }
    public string? ErrorMessage { get; set; }
    public int QueueOrder { get; set; }

    /// <summary>For HLS/DASH downloads: the selected variant/representation description (JSON).</summary>
    public string? MediaSelection { get; set; }

    public string FullPath => Path.Combine(TargetDirectory, FileName);
}

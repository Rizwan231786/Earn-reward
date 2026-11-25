using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Core.Abstractions;

/// <summary>Encrypts secrets (passwords, cookies, proxy credentials) at rest. Windows implementation uses DPAPI.</summary>
public interface ISecretProtector
{
    string Protect(string plaintext);
    string Unprotect(string protectedText);
}

/// <summary>Persistent store of downloads and their resume metadata.</summary>
public interface IDownloadRepository
{
    Task<IReadOnlyList<DownloadItem>> GetAllAsync(CancellationToken ct = default);
    Task<DownloadItem?> GetAsync(Guid id, CancellationToken ct = default);
    /// <summary>Inserts or replaces the item and its segment table (<paramref name="segments"/> or, when null, item.Segments).
    /// Pass a snapshot while the item is being downloaded, because the live list is mutated by the engine.</summary>
    Task UpsertAsync(DownloadItem item, IReadOnlyList<DownloadSegment>? segments = null, CancellationToken ct = default);
    Task DeleteAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Persistent key/value settings store.</summary>
public interface ISettingsStore
{
    Task<AppSettings> LoadAsync(CancellationToken ct = default);
    Task SaveAsync(AppSettings settings, CancellationToken ct = default);
}

/// <summary>Append-only log of user-visible events (shown on the Logs page).</summary>
public interface IEventLog
{
    Task AppendAsync(string level, string message, Guid? downloadId = null, CancellationToken ct = default);
    Task<IReadOnlyList<LogEntry>> GetRecentAsync(int max, CancellationToken ct = default);
}

public sealed record LogEntry(long Id, DateTimeOffset Timestamp, string Level, string Message, Guid? DownloadId);

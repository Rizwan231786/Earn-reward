using System.Text;
using Microsoft.Data.Sqlite;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Persistence;
using MyDownloadManager.Tests.Infrastructure;

namespace MyDownloadManager.Tests.Persistence;

public sealed class PersistenceTests : IDisposable
{
    private readonly TempDir _dir = new();
    private string DbPath => Path.Combine(_dir.Path, "mdm.db");

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        _dir.Dispose();
    }

    private (SqliteDatabase Db, SqliteDownloadRepository Repo) Create()
    {
        var db = new SqliteDatabase(DbPath);
        return (db, new SqliteDownloadRepository(db, SecretProtectorFactory.Create(_dir.Path)));
    }

    [Fact]
    public async Task Download_RoundTripsAllFieldsAndSegments()
    {
        var (_, repo) = Create();
        var item = new DownloadItem
        {
            Url = "https://example.com/a.zip", ResolvedUrl = "https://cdn.example.com/a.zip", Referrer = "https://example.com/",
            FileName = "a.zip", TargetDirectory = _dir.Path, Category = FileCategories.Compressed, Kind = DownloadKind.Hls,
            Status = DownloadStatus.Paused, TotalBytes = 123456789012, DownloadedBytes = 5000, SupportsRanges = true,
            ETag = "\"abc\"", LastModified = "Wed, 01 Jan 2026 00:00:00 GMT", ContentType = "application/zip",
            MaxConnections = 6, SpeedLimit = 1000, Cookies = "sid=secret-cookie", UserName = "bob", Password = "p@ss-secret",
            UserAgent = "UA", ExpectedChecksum = "sha256:00", TempFileName = "a.zip.1234.mdmpart",
            ScheduledAt = DateTimeOffset.UtcNow.AddHours(1), ErrorMessage = "err", QueueOrder = 7, MediaSelection = "{\"v\":1}",
            Headers = new(StringComparer.OrdinalIgnoreCase) { ["Authorization"] = "Bearer header-secret", ["X-Test"] = "1" },
            Segments = [new() { Index = 0, Start = 0, End = 99, Downloaded = 50 }, new() { Index = 1, Start = 100, End = 199, Downloaded = 100 }],
        };
        await repo.UpsertAsync(item);

        var loaded = await repo.GetAsync(item.Id);
        Assert.NotNull(loaded);
        Assert.Equal(item.Url, loaded.Url);
        Assert.Equal(item.ResolvedUrl, loaded.ResolvedUrl);
        Assert.Equal(item.TotalBytes, loaded.TotalBytes);
        Assert.Equal(item.Kind, loaded.Kind);
        Assert.Equal(item.Status, loaded.Status);
        Assert.Equal(item.Cookies, loaded.Cookies);
        Assert.Equal(item.Password, loaded.Password);
        Assert.Equal("Bearer header-secret", loaded.Headers["authorization"]);
        Assert.Equal(item.ScheduledAt!.Value.ToUnixTimeMilliseconds(), loaded.ScheduledAt!.Value.ToUnixTimeMilliseconds());
        Assert.Equal(item.MediaSelection, loaded.MediaSelection);
        Assert.Equal(2, loaded.Segments.Count);
        Assert.Equal(150, loaded.Segments.Sum(s => s.Downloaded));

        // Update replaces the segment table.
        loaded.Segments.RemoveAt(1);
        loaded.Status = DownloadStatus.Completed;
        await repo.UpsertAsync(loaded);
        var all = await repo.GetAllAsync();
        Assert.Single(all);
        Assert.Single(all[0].Segments);
        Assert.Equal(DownloadStatus.Completed, all[0].Status);

        await repo.DeleteAsync(item.Id);
        Assert.Empty(await repo.GetAllAsync());
    }

    [Fact]
    public async Task Secrets_AreNotStoredInPlaintext()
    {
        var (_, repo) = Create();
        await repo.UpsertAsync(new DownloadItem
        {
            Url = "https://example.com/x", TargetDirectory = _dir.Path, Password = "TOP-SECRET-PASSWORD", Cookies = "COOKIE-SECRET",
            Headers = new() { ["Authorization"] = "HEADER-SECRET" },
        });
        SqliteConnection.ClearAllPools();
        var raw = Encoding.UTF8.GetString(await File.ReadAllBytesAsync(DbPath)) +
                  (File.Exists(DbPath + "-wal") ? Encoding.UTF8.GetString(await File.ReadAllBytesAsync(DbPath + "-wal")) : "");
        Assert.DoesNotContain("TOP-SECRET-PASSWORD", raw);
        Assert.DoesNotContain("COOKIE-SECRET", raw);
        Assert.DoesNotContain("HEADER-SECRET", raw);
    }

    [Fact]
    public async Task UndecryptableSecrets_AreDroppedNotFatal()
    {
        var (db, repo) = Create();
        var item = new DownloadItem { Url = "https://example.com/x", TargetDirectory = _dir.Path, Password = "pw" };
        await repo.UpsertAsync(item);
        File.Delete(Path.Combine(_dir.Path, "secret.key")); // a different key = a different Windows account
        var other = new SqliteDownloadRepository(db, SecretProtectorFactory.Create(_dir.Path));
        var loaded = await other.GetAsync(item.Id);
        Assert.NotNull(loaded);
        Assert.Null(loaded.Password);
    }

    [Fact]
    public async Task Settings_RoundTrip_WithEncryptedProxyPassword()
    {
        var db = new SqliteDatabase(DbPath);
        var store = new SqliteSettingsStore(db, SecretProtectorFactory.Create(_dir.Path));
        var defaults = await store.LoadAsync();
        Assert.Equal(8, defaults.MaxConnectionsPerDownload);

        var s = new AppSettings
        {
            MaxConnectionsPerDownload = 16, GlobalSpeedLimit = 1234, ProxyMode = ProxyMode.Manual, ProxyAddress = "proxy:8080",
            ProxyUserName = "u", ProxyPassword = "proxy-secret-pw", ScheduleStart = new TimeOnly(1, 30), ScheduleStop = new TimeOnly(6, 0),
            MonitorClipboard = true, DefaultDownloadDirectory = _dir.Path,
        };
        await store.SaveAsync(s);
        var loaded = await store.LoadAsync();
        Assert.Equal(16, loaded.MaxConnectionsPerDownload);
        Assert.Equal(ProxyMode.Manual, loaded.ProxyMode);
        Assert.Equal("proxy-secret-pw", loaded.ProxyPassword);
        Assert.Equal(new TimeOnly(1, 30), loaded.ScheduleStart);
        Assert.True(loaded.MonitorClipboard);

        await using var c = db.Open();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT value FROM settings WHERE key='app'";
        Assert.DoesNotContain("proxy-secret-pw", (string)(await cmd.ExecuteScalarAsync())!);
    }

    [Fact]
    public async Task EventLog_AppendsAndReadsNewestFirst()
    {
        var log = new SqliteEventLog(new SqliteDatabase(DbPath));
        var id = Guid.NewGuid();
        await log.AppendAsync("Info", "first");
        await log.AppendAsync("Error", "second", id);
        var entries = await log.GetRecentAsync(10);
        Assert.Equal(["second", "first"], entries.Select(e => e.Message));
        Assert.Equal(id, entries[0].DownloadId);
    }

    [Fact]
    public void NewerSchema_IsRejected()
    {
        _ = new SqliteDatabase(DbPath);
        using (var c = new SqliteConnection($"Data Source={DbPath}"))
        {
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "PRAGMA user_version=99;";
            cmd.ExecuteNonQuery();
        }
        SqliteConnection.ClearAllPools();
        var ex = Assert.Throws<InvalidOperationException>(() => new SqliteDatabase(DbPath));
        Assert.Contains("newer", ex.Message);
    }
}

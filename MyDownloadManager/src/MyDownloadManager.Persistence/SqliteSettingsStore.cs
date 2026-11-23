using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using MyDownloadManager.Core.Abstractions;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Persistence;

/// <summary>Stores <see cref="AppSettings"/> as JSON; the proxy password is encrypted under its own key.</summary>
public sealed class SqliteSettingsStore(SqliteDatabase db, ISecretProtector protector) : ISettingsStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false, Converters = { new JsonStringEnumConverter() } };

    public async Task<AppSettings> LoadAsync(CancellationToken ct = default)
    {
        await using var c = db.Open();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT key, value FROM settings WHERE key IN ('app', 'proxy_password');";
        string? app = null, pw = null;
        await using (var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false))
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                if (r.GetString(0) == "app") app = r.GetString(1); else pw = r.GetString(1);
            }
        AppSettings settings;
        try { settings = app is null ? new AppSettings() : JsonSerializer.Deserialize<AppSettings>(app, Json) ?? new AppSettings(); }
        catch (JsonException) { settings = new AppSettings(); }
        try { settings.ProxyPassword = pw is null ? null : protector.Unprotect(pw); }
        catch (Exception e) when (e is CryptographicException or FormatException) { settings.ProxyPassword = null; }
        return settings;
    }

    public async Task SaveAsync(AppSettings settings, CancellationToken ct = default)
    {
        var copy = settings.Clone();
        var pw = copy.ProxyPassword;
        copy.ProxyPassword = null;
        await using var c = db.Open();
        await using var tx = await c.BeginTransactionAsync(ct).ConfigureAwait(false);
        await using var cmd = c.CreateCommand();
        cmd.Transaction = (Microsoft.Data.Sqlite.SqliteTransaction)tx;
        cmd.CommandText = "INSERT INTO settings(key, value) VALUES ('app', $v) ON CONFLICT(key) DO UPDATE SET value=excluded.value;";
        cmd.Parameters.AddWithValue("$v", JsonSerializer.Serialize(copy, Json));
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        cmd.Parameters.Clear();
        if (string.IsNullOrEmpty(pw)) cmd.CommandText = "DELETE FROM settings WHERE key='proxy_password';";
        else
        {
            cmd.CommandText = "INSERT INTO settings(key, value) VALUES ('proxy_password', $v) ON CONFLICT(key) DO UPDATE SET value=excluded.value;";
            cmd.Parameters.AddWithValue("$v", protector.Protect(pw));
        }
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        await tx.CommitAsync(ct).ConfigureAwait(false);
    }
}

/// <summary>User-visible event log persisted in SQLite, capped at <see cref="MaxRows"/> entries.</summary>
public sealed class SqliteEventLog(SqliteDatabase db) : IEventLog
{
    public const int MaxRows = 5000;
    private int _writes;

    public async Task AppendAsync(string level, string message, Guid? downloadId = null, CancellationToken ct = default)
    {
        await using var c = db.Open();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO event_log(ts, level, message, download_id) VALUES ($ts, $l, $m, $d);";
        cmd.Parameters.AddWithValue("$ts", DateTimeOffset.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$l", level);
        cmd.Parameters.AddWithValue("$m", message.Length > 4000 ? message[..4000] : message);
        cmd.Parameters.AddWithValue("$d", downloadId is { } id ? id.ToString() : DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        if (Interlocked.Increment(ref _writes) % 200 == 0)
        {
            cmd.Parameters.Clear();
            cmd.CommandText = $"DELETE FROM event_log WHERE id <= (SELECT MAX(id) FROM event_log) - {MaxRows};";
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
    }

    public async Task<IReadOnlyList<LogEntry>> GetRecentAsync(int max, CancellationToken ct = default)
    {
        await using var c = db.Open();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, ts, level, message, download_id FROM event_log ORDER BY id DESC LIMIT $n;";
        cmd.Parameters.AddWithValue("$n", max);
        var list = new List<LogEntry>();
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
            list.Add(new LogEntry(r.GetInt64(0), DateTimeOffset.Parse(r.GetString(1), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
                r.GetString(2), r.GetString(3), r.IsDBNull(4) ? null : Guid.Parse(r.GetString(4))));
        return list;
    }
}

using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using MyDownloadManager.Core.Abstractions;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Persistence;

/// <summary>SQLite implementation of <see cref="IDownloadRepository"/>. Secrets (headers, cookies, password) are encrypted.</summary>
public sealed class SqliteDownloadRepository(SqliteDatabase db, ISecretProtector protector) : IDownloadRepository
{
    private const string Columns = """
        id, url, resolved_url, referrer, file_name, target_dir, category, kind, status, total_bytes, downloaded_bytes,
        supports_ranges, etag, last_modified, content_type, max_connections, speed_limit, headers_enc, cookies_enc,
        user_name, password_enc, user_agent, expected_checksum, temp_file_name, created_at, completed_at, scheduled_at,
        error_message, queue_order, media_selection
        """;

    public async Task<IReadOnlyList<DownloadItem>> GetAllAsync(CancellationToken ct = default)
    {
        await using var c = db.Open();
        var items = new Dictionary<string, DownloadItem>();
        var ordered = new List<DownloadItem>();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = $"SELECT {Columns} FROM downloads ORDER BY queue_order, created_at;";
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                var item = Read(r);
                items[item.Id.ToString()] = item;
                ordered.Add(item);
            }
        }
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT download_id, idx, start_offset, end_offset, downloaded FROM segments ORDER BY download_id, idx;";
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
                if (items.TryGetValue(r.GetString(0), out var item))
                    item.Segments.Add(new DownloadSegment { Index = r.GetInt32(1), Start = r.GetInt64(2), End = r.GetInt64(3), Downloaded = r.GetInt64(4) });
        }
        return ordered;
    }

    public async Task<DownloadItem?> GetAsync(Guid id, CancellationToken ct = default)
    {
        await using var c = db.Open();
        DownloadItem? item = null;
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = $"SELECT {Columns} FROM downloads WHERE id=$id;";
            cmd.Parameters.AddWithValue("$id", id.ToString());
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            if (await r.ReadAsync(ct).ConfigureAwait(false)) item = Read(r);
        }
        if (item is null) return null;
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT idx, start_offset, end_offset, downloaded FROM segments WHERE download_id=$id ORDER BY idx;";
            cmd.Parameters.AddWithValue("$id", id.ToString());
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
                item.Segments.Add(new DownloadSegment { Index = r.GetInt32(0), Start = r.GetInt64(1), End = r.GetInt64(2), Downloaded = r.GetInt64(3) });
        }
        return item;
    }

    public async Task UpsertAsync(DownloadItem item, IReadOnlyList<DownloadSegment>? segments = null, CancellationToken ct = default)
    {
        segments ??= item.Segments.ToList();
        await using var c = db.Open();
        await using var tx = (SqliteTransaction)await c.BeginTransactionAsync(ct).ConfigureAwait(false);
        await using (var cmd = c.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = $"""
                INSERT INTO downloads ({Columns}) VALUES (
                  $id, $url, $resolved_url, $referrer, $file_name, $target_dir, $category, $kind, $status, $total_bytes, $downloaded_bytes,
                  $supports_ranges, $etag, $last_modified, $content_type, $max_connections, $speed_limit, $headers_enc, $cookies_enc,
                  $user_name, $password_enc, $user_agent, $expected_checksum, $temp_file_name, $created_at, $completed_at, $scheduled_at,
                  $error_message, $queue_order, $media_selection)
                ON CONFLICT(id) DO UPDATE SET
                  url=excluded.url, resolved_url=excluded.resolved_url, referrer=excluded.referrer, file_name=excluded.file_name,
                  target_dir=excluded.target_dir, category=excluded.category, kind=excluded.kind, status=excluded.status,
                  total_bytes=excluded.total_bytes, downloaded_bytes=excluded.downloaded_bytes, supports_ranges=excluded.supports_ranges,
                  etag=excluded.etag, last_modified=excluded.last_modified, content_type=excluded.content_type,
                  max_connections=excluded.max_connections, speed_limit=excluded.speed_limit, headers_enc=excluded.headers_enc,
                  cookies_enc=excluded.cookies_enc, user_name=excluded.user_name, password_enc=excluded.password_enc,
                  user_agent=excluded.user_agent, expected_checksum=excluded.expected_checksum, temp_file_name=excluded.temp_file_name,
                  created_at=excluded.created_at, completed_at=excluded.completed_at, scheduled_at=excluded.scheduled_at,
                  error_message=excluded.error_message, queue_order=excluded.queue_order, media_selection=excluded.media_selection;
                """;
            var p = cmd.Parameters;
            p.AddWithValue("$id", item.Id.ToString());
            p.AddWithValue("$url", item.Url);
            p.AddWithValue("$resolved_url", Db(item.ResolvedUrl));
            p.AddWithValue("$referrer", Db(item.Referrer));
            p.AddWithValue("$file_name", item.FileName);
            p.AddWithValue("$target_dir", item.TargetDirectory);
            p.AddWithValue("$category", item.Category);
            p.AddWithValue("$kind", (int)item.Kind);
            p.AddWithValue("$status", (int)item.Status);
            p.AddWithValue("$total_bytes", item.TotalBytes is { } t ? t : DBNull.Value);
            p.AddWithValue("$downloaded_bytes", item.DownloadedBytes);
            p.AddWithValue("$supports_ranges", item.SupportsRanges is { } sr ? (sr ? 1 : 0) : DBNull.Value);
            p.AddWithValue("$etag", Db(item.ETag));
            p.AddWithValue("$last_modified", Db(item.LastModified));
            p.AddWithValue("$content_type", Db(item.ContentType));
            p.AddWithValue("$max_connections", item.MaxConnections);
            p.AddWithValue("$speed_limit", item.SpeedLimit);
            p.AddWithValue("$headers_enc", item.Headers.Count == 0 ? DBNull.Value : protector.Protect(JsonSerializer.Serialize(item.Headers)));
            p.AddWithValue("$cookies_enc", string.IsNullOrEmpty(item.Cookies) ? DBNull.Value : protector.Protect(item.Cookies));
            p.AddWithValue("$user_name", Db(item.UserName));
            p.AddWithValue("$password_enc", string.IsNullOrEmpty(item.Password) ? DBNull.Value : protector.Protect(item.Password));
            p.AddWithValue("$user_agent", Db(item.UserAgent));
            p.AddWithValue("$expected_checksum", Db(item.ExpectedChecksum));
            p.AddWithValue("$temp_file_name", Db(item.TempFileName));
            p.AddWithValue("$created_at", item.CreatedAt.ToString("O"));
            p.AddWithValue("$completed_at", item.CompletedAt is { } ca ? ca.ToString("O") : DBNull.Value);
            p.AddWithValue("$scheduled_at", item.ScheduledAt is { } sa ? sa.ToString("O") : DBNull.Value);
            p.AddWithValue("$error_message", Db(item.ErrorMessage));
            p.AddWithValue("$queue_order", item.QueueOrder);
            p.AddWithValue("$media_selection", Db(item.MediaSelection));
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        await using (var del = c.CreateCommand())
        {
            del.Transaction = tx;
            del.CommandText = "DELETE FROM segments WHERE download_id=$id;";
            del.Parameters.AddWithValue("$id", item.Id.ToString());
            await del.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        if (segments.Count > 0)
        {
            await using var ins = c.CreateCommand();
            ins.Transaction = tx;
            ins.CommandText = "INSERT INTO segments (download_id, idx, start_offset, end_offset, downloaded) VALUES ($id, $idx, $s, $e, $d);";
            var pid = ins.Parameters.Add("$id", SqliteType.Text);
            var pidx = ins.Parameters.Add("$idx", SqliteType.Integer);
            var ps = ins.Parameters.Add("$s", SqliteType.Integer);
            var pe = ins.Parameters.Add("$e", SqliteType.Integer);
            var pd = ins.Parameters.Add("$d", SqliteType.Integer);
            pid.Value = item.Id.ToString();
            foreach (var s in segments)
            {
                pidx.Value = s.Index; ps.Value = s.Start; pe.Value = s.End; pd.Value = s.Downloaded;
                await ins.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
        }
        await tx.CommitAsync(ct).ConfigureAwait(false);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await using var c = db.Open();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM downloads WHERE id=$id;";
        cmd.Parameters.AddWithValue("$id", id.ToString());
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    private DownloadItem Read(SqliteDataReader r)
    {
        string? S(int i) => r.IsDBNull(i) ? null : r.GetString(i);
        DateTimeOffset? D(int i) => r.IsDBNull(i) ? null : DateTimeOffset.Parse(r.GetString(i), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);

        var item = new DownloadItem
        {
            Id = Guid.Parse(r.GetString(0)),
            Url = r.GetString(1),
            ResolvedUrl = S(2),
            Referrer = S(3),
            FileName = r.GetString(4),
            TargetDirectory = r.GetString(5),
            Category = r.GetString(6),
            Kind = (DownloadKind)r.GetInt32(7),
            Status = (DownloadStatus)r.GetInt32(8),
            TotalBytes = r.IsDBNull(9) ? null : r.GetInt64(9),
            DownloadedBytes = r.GetInt64(10),
            SupportsRanges = r.IsDBNull(11) ? null : r.GetInt64(11) != 0,
            ETag = S(12),
            LastModified = S(13),
            ContentType = S(14),
            MaxConnections = r.GetInt32(15),
            SpeedLimit = r.GetInt64(16),
            UserName = S(19),
            UserAgent = S(21),
            ExpectedChecksum = S(22),
            TempFileName = S(23),
            CreatedAt = D(24) ?? DateTimeOffset.UtcNow,
            CompletedAt = D(25),
            ScheduledAt = D(26),
            ErrorMessage = S(27),
            QueueOrder = r.GetInt32(28),
            MediaSelection = S(29),
        };
        // A secret that cannot be decrypted (e.g. DB copied to another Windows account) is dropped, not fatal.
        try { if (S(17) is { } h) item.Headers = new Dictionary<string, string>(JsonSerializer.Deserialize<Dictionary<string, string>>(protector.Unprotect(h)) ?? [], StringComparer.OrdinalIgnoreCase); }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException) { }
        try { if (S(18) is { } ck) item.Cookies = protector.Unprotect(ck); }
        catch (Exception e) when (e is CryptographicException or FormatException) { }
        try { if (S(20) is { } pw) item.Password = protector.Unprotect(pw); }
        catch (Exception e) when (e is CryptographicException or FormatException) { }
        return item;
    }

    private static object Db(string? s) => s is null ? DBNull.Value : s;
}

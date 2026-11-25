using Microsoft.Data.Sqlite;

namespace MyDownloadManager.Persistence;

/// <summary>Owns the SQLite file, connection creation and schema migrations.</summary>
public sealed class SqliteDatabase
{
    public const int SchemaVersion = 1;
    private readonly string _connectionString;

    public SqliteDatabase(string databasePath)
    {
        DatabasePath = Path.GetFullPath(databasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(DatabasePath)!);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = true,
            DefaultTimeout = 30,
        }.ToString();
        Migrate();
    }

    public string DatabasePath { get; }

    public SqliteConnection Open()
    {
        var c = new SqliteConnection(_connectionString);
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;";
        cmd.ExecuteNonQuery();
        return c;
    }

    private void Migrate()
    {
        using var c = Open();
        using (var wal = c.CreateCommand())
        {
            // WAL + NORMAL: the DB is always consistent after a crash; at worst the last checkpoint is lost, which is
            // safe because checkpoints only ever under-report progress.
            wal.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;";
            wal.ExecuteNonQuery();
        }
        long version;
        using (var v = c.CreateCommand()) { v.CommandText = "PRAGMA user_version;"; version = (long)v.ExecuteScalar()!; }
        if (version > SchemaVersion)
            throw new InvalidOperationException($"Database schema v{version} is newer than this app (v{SchemaVersion}). Please update MyDownloadManager.");
        if (version >= SchemaVersion) return;

        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                resolved_url TEXT,
                referrer TEXT,
                file_name TEXT NOT NULL,
                target_dir TEXT NOT NULL,
                category TEXT NOT NULL,
                kind INTEGER NOT NULL,
                status INTEGER NOT NULL,
                total_bytes INTEGER,
                downloaded_bytes INTEGER NOT NULL,
                supports_ranges INTEGER,
                etag TEXT,
                last_modified TEXT,
                content_type TEXT,
                max_connections INTEGER NOT NULL,
                speed_limit INTEGER NOT NULL,
                headers_enc TEXT,
                cookies_enc TEXT,
                user_name TEXT,
                password_enc TEXT,
                user_agent TEXT,
                expected_checksum TEXT,
                temp_file_name TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                scheduled_at TEXT,
                error_message TEXT,
                queue_order INTEGER NOT NULL,
                media_selection TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_downloads_status ON downloads(status);
            CREATE TABLE IF NOT EXISTS segments (
                download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
                idx INTEGER NOT NULL,
                start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL,
                downloaded INTEGER NOT NULL,
                PRIMARY KEY (download_id, idx)
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS event_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                download_id TEXT
            );
            """;
        cmd.ExecuteNonQuery();
        cmd.CommandText = $"PRAGMA user_version={SchemaVersion};";
        cmd.ExecuteNonQuery();
        tx.Commit();
    }
}

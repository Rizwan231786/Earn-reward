namespace MyDownloadManager.Core.Models;

public enum ProxyMode { System = 0, None = 1, Manual = 2 }

/// <summary>User-configurable application settings. Persisted as JSON in SQLite (secrets encrypted separately).</summary>
public sealed class AppSettings
{
    public string DefaultDownloadDirectory { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

    /// <summary>When true, files are placed in a sub-folder named after their category.</summary>
    public bool UseCategoryFolders { get; set; } = true;

    public int MaxConnectionsPerDownload { get; set; } = 8;
    public int MaxConcurrentDownloads { get; set; } = 3;
    public int MaxRetries { get; set; } = 8;
    /// <summary>Global speed limit in bytes/second, 0 = unlimited.</summary>
    public long GlobalSpeedLimit { get; set; }
    public int ConnectTimeoutSeconds { get; set; } = 30;
    public int ReadTimeoutSeconds { get; set; } = 60;
    public string UserAgent { get; set; } = "MyDownloadManager/1.0";

    public ProxyMode ProxyMode { get; set; } = ProxyMode.System;
    public string? ProxyAddress { get; set; }
    public string? ProxyUserName { get; set; }
    /// <summary>Stored encrypted by the settings store; plaintext only in memory.</summary>
    public string? ProxyPassword { get; set; }

    public bool MonitorClipboard { get; set; }
    public bool MinimizeToTray { get; set; } = true;
    public bool StartWithWindows { get; set; }
    public bool ShowCompletionNotification { get; set; } = true;

    /// <summary>Browser integration: intercept browser downloads of these extensions (empty = all).</summary>
    public string InterceptExtensions { get; set; } =
        "zip rar 7z gz tar iso exe msi apk dmg pdf mp3 mp4 mkv webm avi mov flac m4a";
    public long InterceptMinimumBytes { get; set; } = 1024 * 1024;
    public bool BrowserIntegrationEnabled { get; set; } = true;

    /// <summary>Optional explicit path to ffmpeg.exe. Empty = bundled copy next to the app, then PATH.</summary>
    public string? FfmpegPath { get; set; }

    /// <summary>Daily queue schedule (local time). Null = queue runs whenever started.</summary>
    public TimeOnly? ScheduleStart { get; set; }
    public TimeOnly? ScheduleStop { get; set; }

    public AppSettings Clone() => (AppSettings)MemberwiseClone();
}

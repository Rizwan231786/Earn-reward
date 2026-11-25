using System.Net;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Engine;

/// <summary>Runtime configuration of the download engine (derived from <see cref="AppSettings"/>).</summary>
public sealed class EngineOptions
{
    public int MaxConnections { get; set; } = 8;
    public int MaxRetries { get; set; } = 8;
    /// <summary>Segments are never split smaller than this.</summary>
    public long MinSegmentSize { get; set; } = 1024 * 1024;
    public int BufferSize { get; set; } = 64 * 1024;
    public TimeSpan ConnectTimeout { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>Abort a connection when no data arrives for this long.</summary>
    public TimeSpan ReadTimeout { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>How often progress counters are flushed to disk and persisted.</summary>
    public TimeSpan CheckpointInterval { get; set; } = TimeSpan.FromSeconds(2);
    public TimeSpan RetryBaseDelay { get; set; } = TimeSpan.FromSeconds(1);
    public TimeSpan RetryMaxDelay { get; set; } = TimeSpan.FromSeconds(30);
    public int MaxRedirects { get; set; } = 10;
    public string UserAgent { get; set; } = "MyDownloadManager/1.0";
    /// <summary>Enable dynamic segmentation: idle connections split the largest remaining segment.</summary>
    public bool DynamicSegmentation { get; set; } = true;

    public ProxyMode ProxyMode { get; set; } = ProxyMode.System;
    public string? ProxyAddress { get; set; }
    public NetworkCredential? ProxyCredentials { get; set; }

    public static EngineOptions FromSettings(AppSettings s) => new()
    {
        MaxConnections = Math.Clamp(s.MaxConnectionsPerDownload, 1, 32),
        MaxRetries = Math.Clamp(s.MaxRetries, 0, 100),
        ConnectTimeout = TimeSpan.FromSeconds(Math.Clamp(s.ConnectTimeoutSeconds, 5, 300)),
        ReadTimeout = TimeSpan.FromSeconds(Math.Clamp(s.ReadTimeoutSeconds, 5, 600)),
        UserAgent = string.IsNullOrWhiteSpace(s.UserAgent) ? "MyDownloadManager/1.0" : s.UserAgent,
        ProxyMode = s.ProxyMode,
        ProxyAddress = s.ProxyAddress,
        ProxyCredentials = string.IsNullOrEmpty(s.ProxyUserName) ? null : new NetworkCredential(s.ProxyUserName, s.ProxyPassword),
    };
}

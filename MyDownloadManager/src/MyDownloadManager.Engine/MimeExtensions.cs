namespace MyDownloadManager.Engine;

/// <summary>Best-effort file extension for a MIME type, used only when neither header nor URL provides one.</summary>
internal static class MimeExtensions
{
    private static readonly Dictionary<string, string> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        ["application/zip"] = ".zip", ["application/pdf"] = ".pdf", ["application/x-7z-compressed"] = ".7z",
        ["application/vnd.rar"] = ".rar", ["application/x-rar-compressed"] = ".rar", ["application/gzip"] = ".gz",
        ["application/x-msdownload"] = ".exe", ["application/x-msi"] = ".msi", ["application/json"] = ".json",
        ["text/plain"] = ".txt", ["text/html"] = ".html", ["text/csv"] = ".csv",
        ["image/png"] = ".png", ["image/jpeg"] = ".jpg", ["image/gif"] = ".gif", ["image/webp"] = ".webp",
        ["audio/mpeg"] = ".mp3", ["audio/mp4"] = ".m4a", ["audio/ogg"] = ".ogg", ["audio/webm"] = ".weba",
        ["video/mp4"] = ".mp4", ["video/webm"] = ".webm", ["video/x-matroska"] = ".mkv", ["video/quicktime"] = ".mov",
        ["video/mp2t"] = ".ts",
    };

    public static string For(string? mediaType) =>
        mediaType is not null && Map.TryGetValue(mediaType, out var e) ? e : "";
}

namespace MyDownloadManager.Core.Models;

/// <summary>Maps file extensions to user-visible categories (used for sorting and default folders).</summary>
public static class FileCategories
{
    public const string General = "General";
    public const string Compressed = "Compressed";
    public const string Documents = "Documents";
    public const string Music = "Music";
    public const string Video = "Video";
    public const string Programs = "Programs";
    public const string Images = "Images";

    public static IReadOnlyList<string> All { get; } = [General, Compressed, Documents, Music, Video, Programs, Images];

    private static readonly Dictionary<string, string> Map = Build();

    private static Dictionary<string, string> Build()
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        void Add(string cat, params string[] exts) { foreach (var e in exts) d["." + e] = cat; }
        Add(Compressed, "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "lz", "lzma");
        Add(Documents, "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "txt", "rtf", "epub", "csv", "md");
        Add(Music, "mp3", "aac", "m4a", "flac", "wav", "ogg", "oga", "opus", "wma", "aiff");
        Add(Video, "mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "flv", "mpg", "mpeg", "ts", "3gp", "m3u8", "mpd");
        Add(Programs, "exe", "msi", "msix", "appx", "bat", "apk", "dmg", "pkg", "deb", "rpm", "appimage");
        Add(Images, "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico", "heic", "avif");
        return d;
    }

    public static string FromFileName(string? fileName)
    {
        if (string.IsNullOrEmpty(fileName)) return General;
        var ext = Path.GetExtension(fileName);
        return ext.Length > 0 && Map.TryGetValue(ext, out var c) ? c : General;
    }
}

using System.Text;

namespace MyDownloadManager.Core.Security;

/// <summary>
/// Produces Windows-safe file names from untrusted input (server headers, URLs, browser messages).
/// Rules are Windows' rules regardless of the OS we run on, so behaviour is identical in tests and production.
/// </summary>
public static class FileNameSanitizer
{
    public const int MaxFileNameLength = 180;
    private static readonly char[] Invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
    };

    public static string Sanitize(string? name, string fallback = "download")
    {
        if (string.IsNullOrWhiteSpace(name)) return fallback;

        // Strip any directory components an attacker might have supplied ("../../evil.exe", "C:\x").
        var lastSep = name.LastIndexOfAny(['/', '\\']);
        if (lastSep >= 0) name = name[(lastSep + 1)..];

        var sb = new StringBuilder(name.Length);
        foreach (var ch in name)
        {
            if (char.IsControl(ch) || Array.IndexOf(Invalid, ch) >= 0) sb.Append('_');
            // Bidi override characters can disguise extensions ("evil\u202Etxt.exe").
            else if (ch is '\u202A' or '\u202B' or '\u202C' or '\u202D' or '\u202E' or '\u2066' or '\u2067' or '\u2068' or '\u2069' or '\u200E' or '\u200F') continue;
            else sb.Append(ch);
        }

        var result = sb.ToString().Trim().TrimEnd('.', ' ');
        result = result.TrimStart('.', ' ');
        if (result.Length == 0) return fallback;

        var stem = Path.GetFileNameWithoutExtension(result);
        var ext = Path.GetExtension(result);
        var stemBase = stem.Split('.')[0];
        if (Reserved.Contains(stemBase) || Reserved.Contains(stem)) stem = "_" + stem;

        if (ext.Length > 20) { stem += ext; ext = ""; }
        var maxStem = MaxFileNameLength - ext.Length;
        if (stem.Length > maxStem) stem = stem[..maxStem].TrimEnd('.', ' ');
        if (stem.Length == 0) stem = fallback;
        return stem + ext;
    }

    /// <summary>Derives a file name from the last path segment of a URL.</summary>
    public static string FromUrl(Uri uri, string fallback = "download")
    {
        var seg = uri.Segments.Length > 0 ? uri.Segments[^1] : "";
        try { seg = Uri.UnescapeDataString(seg); } catch (UriFormatException) { }
        seg = seg.Trim('/');
        return Sanitize(string.IsNullOrEmpty(seg) ? (string.IsNullOrEmpty(uri.Host) ? fallback : uri.Host) : seg, fallback);
    }

    /// <summary>Returns a name not present in <paramref name="exists"/>: "file.zip" → "file (1).zip" …</summary>
    public static string MakeUnique(string fileName, Func<string, bool> exists)
    {
        if (!exists(fileName)) return fileName;
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var ext = Path.GetExtension(fileName);
        for (var i = 1; i < 10_000; i++)
        {
            var candidate = $"{stem} ({i}){ext}";
            if (!exists(candidate)) return candidate;
        }
        return $"{stem} ({Guid.NewGuid():N}){ext}";
    }
}

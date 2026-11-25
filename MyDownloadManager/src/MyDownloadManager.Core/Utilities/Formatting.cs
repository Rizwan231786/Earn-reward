using System.Globalization;

namespace MyDownloadManager.Core.Utilities;

public static class Formatting
{
    private static readonly string[] Units = ["B", "KB", "MB", "GB", "TB"];

    public static string Bytes(long? bytes)
    {
        if (bytes is null or < 0) return "Unknown";
        double v = bytes.Value;
        var u = 0;
        while (v >= 1024 && u < Units.Length - 1) { v /= 1024; u++; }
        return u == 0 ? $"{bytes} B" : v.ToString(v >= 100 ? "0" : v >= 10 ? "0.0" : "0.00", CultureInfo.InvariantCulture) + " " + Units[u];
    }

    public static string Speed(double bytesPerSecond) =>
        bytesPerSecond <= 0 ? "" : Bytes((long)bytesPerSecond) + "/s";

    public static string Eta(TimeSpan? eta)
    {
        if (eta is null) return "";
        var t = eta.Value;
        if (t.TotalDays >= 1) return $"{(int)t.TotalDays}d {t.Hours}h";
        if (t.TotalHours >= 1) return $"{(int)t.TotalHours}h {t.Minutes:00}m";
        if (t.TotalMinutes >= 1) return $"{t.Minutes}m {t.Seconds:00}s";
        return $"{Math.Max(0, t.Seconds)}s";
    }

    /// <summary>Parses "500K", "2M", "1.5MB", "0" into bytes/second. Returns false on garbage.</summary>
    public static bool TryParseSize(string? s, out long bytes)
    {
        bytes = 0;
        if (string.IsNullOrWhiteSpace(s)) return false;
        s = s.Trim().ToUpperInvariant().Replace("/S", "").Replace("B", "").Trim();
        long mult = 1;
        if (s.EndsWith('K')) { mult = 1024; s = s[..^1]; }
        else if (s.EndsWith('M')) { mult = 1024 * 1024; s = s[..^1]; }
        else if (s.EndsWith('G')) { mult = 1024L * 1024 * 1024; s = s[..^1]; }
        if (!double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) || v < 0) return false;
        bytes = (long)(v * mult);
        return true;
    }
}

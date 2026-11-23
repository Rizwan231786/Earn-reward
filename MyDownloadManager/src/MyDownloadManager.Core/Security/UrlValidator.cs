using System.Diagnostics.CodeAnalysis;

namespace MyDownloadManager.Core.Security;

/// <summary>
/// Validates URLs accepted from users, the clipboard and the browser extension.
/// Only absolute http/https URLs with a host are allowed; everything else (file:, javascript:, data:, ftp:, UNC, ...)
/// is rejected so that untrusted input can never make the app touch local files or execute anything.
/// </summary>
public static class UrlValidator
{
    public const int MaxUrlLength = 8192;

    public static bool TryValidate(string? input, [NotNullWhen(true)] out Uri? uri, out string? error)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(input)) { error = "URL is empty."; return false; }
        var s = input.Trim();
        if (s.Length > MaxUrlLength) { error = "URL is too long."; return false; }
        if (s.Any(c => char.IsControl(c))) { error = "URL contains control characters."; return false; }
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u)) { error = "Not a valid absolute URL."; return false; }
        if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps)
        { error = $"Unsupported scheme '{u.Scheme}'. Only http and https are allowed."; return false; }
        if (string.IsNullOrEmpty(u.Host)) { error = "URL has no host."; return false; }
        if (u.IsUnc || u.IsFile) { error = "Local or UNC paths are not allowed."; return false; }
        uri = u; error = null; return true;
    }

    public static bool IsValid(string? input) => TryValidate(input, out _, out _);

    /// <summary>Extracts candidate URLs from free text (clipboard / batch paste), one per token.</summary>
    public static IReadOnlyList<Uri> ExtractUrls(string? text)
    {
        var result = new List<Uri>();
        if (string.IsNullOrWhiteSpace(text)) return result;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in text.Split([' ', '\t', '\r', '\n', '"', '\'', '<', '>'], StringSplitOptions.RemoveEmptyEntries))
        {
            var token = raw.TrimStart('(', '[').TrimEnd(',', ';', ')', ']', '.');
            if (!token.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !token.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) continue;
            if (TryValidate(token, out var u, out _) && seen.Add(u.AbsoluteUri)) result.Add(u);
        }
        return result;
    }

    /// <summary>True when two URIs share scheme, host and port (credentials may only be sent to the same origin).</summary>
    public static bool SameOrigin(Uri a, Uri b) =>
        string.Equals(a.Scheme, b.Scheme, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(a.IdnHost, b.IdnHost, StringComparison.OrdinalIgnoreCase) &&
        a.Port == b.Port;

    /// <summary>Returns the URL with any user-info and query removed — safe to write into logs.</summary>
    public static string Redact(string? url)
    {
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var u)) return "<invalid-url>";
        var b = new UriBuilder(u) { UserName = "", Password = "" };
        var hasQuery = b.Query.Length > 1;
        b.Query = "";
        return b.Uri.GetLeftPart(UriPartial.Path) + (hasQuery ? "?…" : "");
    }
}

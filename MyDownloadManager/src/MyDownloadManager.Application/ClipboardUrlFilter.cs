using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;

namespace MyDownloadManager.Application;

/// <summary>
/// Decides which URLs copied to the clipboard look like downloads worth offering (file types from the
/// interception list, or HLS/DASH manifests). Ordinary web page links are ignored. Remembers what it already offered.
/// </summary>
public sealed class ClipboardUrlFilter
{
    private readonly LinkedList<string> _recent = new();
    private readonly HashSet<string> _recentSet = new(StringComparer.Ordinal);

    public IReadOnlyList<string> Filter(string? text, AppSettings settings)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > 1_000_000) return [];
        var exts = new HashSet<string>(
            settings.InterceptExtensions.Split([' ', ',', ';'], StringSplitOptions.RemoveEmptyEntries).Select(e => "." + e.TrimStart('.').ToLowerInvariant()));
        exts.Add(".m3u8");
        exts.Add(".mpd");
        var result = new List<string>();
        foreach (var uri in UrlValidator.ExtractUrls(text))
        {
            var ext = Path.GetExtension(uri.AbsolutePath).ToLowerInvariant();
            if (!exts.Contains(ext)) continue;
            var url = uri.AbsoluteUri;
            if (_recentSet.Contains(url)) continue;
            Remember(url);
            result.Add(url);
        }
        return result;
    }

    private void Remember(string url)
    {
        _recent.AddFirst(url);
        _recentSet.Add(url);
        while (_recent.Count > 200)
        {
            _recentSet.Remove(_recent.Last!.Value);
            _recent.RemoveLast();
        }
    }
}

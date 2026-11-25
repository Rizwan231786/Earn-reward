using System.Net;
using MyDownloadManager.Core.Security;

namespace MyDownloadManager.Engine.Http;

/// <summary>Metadata extracted from a response's headers.</summary>
public sealed record ResponseInfo(
    HttpStatusCode Status,
    long? TotalLength,
    bool RangeAccepted,
    long? RangeStart,
    string? StrongETag,
    string? LastModified,
    string? ContentType,
    string? SuggestedFileName)
{
    /// <summary>Validator usable in If-Range: a strong ETag, otherwise Last-Modified.</summary>
    public string? Validator => StrongETag ?? LastModified;

    public static ResponseInfo From(HttpResponseMessage resp)
    {
        var content = resp.Content.Headers;
        long? total = null;
        long? rangeStart = null;
        var partial = resp.StatusCode == HttpStatusCode.PartialContent;
        if (partial && content.ContentRange is { } cr)
        {
            total = cr.Length;
            rangeStart = cr.From;
        }
        else if (!partial && content.ContentLength is { } len && content.ContentEncoding.Count == 0)
        {
            total = len;
        }

        var etag = resp.Headers.ETag;
        var strong = etag is { IsWeak: false } ? etag.Tag : null;
        var lm = content.LastModified?.ToString("R");

        string? name = null;
        var cd = content.ContentDisposition;
        if (cd is not null)
        {
            name = cd.FileNameStar;
            if (string.IsNullOrWhiteSpace(name)) name = cd.FileName?.Trim('"');
        }
        if (!string.IsNullOrWhiteSpace(name)) name = FileNameSanitizer.Sanitize(name);

        return new ResponseInfo(resp.StatusCode, total, partial, rangeStart, strong, lm,
            content.ContentType?.MediaType, string.IsNullOrWhiteSpace(name) ? null : name);
    }
}

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;

namespace MyDownloadManager.Engine.Http;

/// <summary>
/// Creates requests for a download and follows redirects manually. Sensitive headers (Authorization, Cookie)
/// are only attached when the request goes to the same origin as the URL the user/browser supplied.
/// </summary>
public sealed class RequestBuilder
{
    private static readonly HashSet<string> Forbidden = new(StringComparer.OrdinalIgnoreCase)
    {
        "Host", "Content-Length", "Transfer-Encoding", "Connection", "Range", "If-Range", "Accept-Encoding",
        "Upgrade", "Expect", "Keep-Alive", "TE", "Trailer", "Proxy-Authorization", "Proxy-Connection",
    };
    private static readonly HashSet<string> Sensitive = new(StringComparer.OrdinalIgnoreCase) { "Authorization", "Cookie" };

    private readonly HttpClient _client;
    private readonly DownloadItem _item;
    private readonly Uri _origin;
    private readonly string _userAgent;
    private readonly int _maxRedirects;

    public RequestBuilder(HttpClient client, DownloadItem item, EngineOptions options)
    {
        _client = client;
        _item = item;
        if (!UrlValidator.TryValidate(item.Url, out var origin, out var err)) throw new DownloadException(err!, false);
        _origin = origin;
        _userAgent = string.IsNullOrWhiteSpace(item.UserAgent) ? options.UserAgent : item.UserAgent!;
        _maxRedirects = options.MaxRedirects;
    }

    public Uri Origin => _origin;

    public HttpRequestMessage Create(Uri uri, long? rangeFrom = null, long? rangeTo = null, string? ifRange = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, uri) { Version = HttpVersion.Version11, VersionPolicy = HttpVersionPolicy.RequestVersionOrHigher };
        req.Headers.TryAddWithoutValidation("User-Agent", _userAgent);
        req.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("identity"));
        req.Headers.Accept.ParseAdd("*/*");
        if (!string.IsNullOrEmpty(_item.Referrer) && UrlValidator.TryValidate(_item.Referrer, out var refUri, out _))
            req.Headers.Referrer = refUri;

        var sameOrigin = UrlValidator.SameOrigin(uri, _origin);
        foreach (var (name, value) in _item.Headers)
        {
            if (!IsSafeHeader(name, value) || Forbidden.Contains(name) || name.Equals("User-Agent", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Referer", StringComparison.OrdinalIgnoreCase)) continue;
            if (Sensitive.Contains(name) && !sameOrigin) continue;
            req.Headers.TryAddWithoutValidation(name, value);
        }
        if (sameOrigin)
        {
            if (!string.IsNullOrEmpty(_item.Cookies) && IsSafeValue(_item.Cookies) && !req.Headers.Contains("Cookie"))
                req.Headers.TryAddWithoutValidation("Cookie", _item.Cookies);
            if (!string.IsNullOrEmpty(_item.UserName) && !req.Headers.Contains("Authorization"))
            {
                var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_item.UserName}:{_item.Password}"));
                req.Headers.Authorization = new AuthenticationHeaderValue("Basic", token);
            }
        }

        if (rangeFrom is not null)
        {
            req.Headers.Range = new RangeHeaderValue(rangeFrom, rangeTo);
            if (!string.IsNullOrEmpty(ifRange))
            {
                if (ifRange.StartsWith('"')) req.Headers.IfRange = new RangeConditionHeaderValue(new EntityTagHeaderValue(ifRange));
                else if (DateTimeOffset.TryParse(ifRange, out var lm)) req.Headers.IfRange = new RangeConditionHeaderValue(lm);
            }
        }
        return req;
    }

    /// <summary>Sends a GET (optionally ranged), following up to N redirects. Returns the final response and URI.</summary>
    public async Task<(HttpResponseMessage Response, Uri FinalUri)> SendAsync(Uri start, long? rangeFrom, long? rangeTo, string? ifRange, CancellationToken ct)
    {
        var uri = start;
        for (var hop = 0; ; hop++)
        {
            using var req = Create(uri, rangeFrom, rangeTo, ifRange);
            HttpResponseMessage resp;
            try
            {
                resp = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            }
            catch (HttpRequestException ex)
            {
                throw new DownloadException($"Connection failed: {ex.Message}", isTransient: true, inner: ex);
            }

            var code = (int)resp.StatusCode;
            if (code is 301 or 302 or 303 or 307 or 308)
            {
                var loc = resp.Headers.Location;
                resp.Dispose();
                if (loc is null) throw new DownloadException("Redirect without a Location header.", false);
                if (hop >= _maxRedirects) throw new DownloadException($"Too many redirects (> {_maxRedirects}).", false);
                var next = loc.IsAbsoluteUri ? loc : new Uri(uri, loc);
                if (!UrlValidator.TryValidate(next.AbsoluteUri, out var valid, out var err))
                    throw new DownloadException($"Unsafe redirect target rejected: {err}", false);
                uri = valid;
                continue;
            }
            return (resp, uri);
        }
    }

    private static bool IsSafeHeader(string name, string value)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 256) return false;
        foreach (var c in name)
            if (c <= 32 || c >= 127 || "()<>@,;:\\\"/[]?={}".Contains(c)) return false;
        return IsSafeValue(value);
    }

    private static bool IsSafeValue(string value) => value.Length <= 16 * 1024 && value.IndexOfAny(['\r', '\n', '\0']) < 0;
}

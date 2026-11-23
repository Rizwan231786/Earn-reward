using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MyDownloadManager.Tests.Infrastructure;

/// <summary>Behaviour switches for a served file.</summary>
public sealed class ServeOptions
{
    public bool SupportRanges { get; set; } = true;
    /// <summary>Send no Content-Length (chunked transfer encoding) for full responses.</summary>
    public bool Chunked { get; set; }
    /// <summary>Abort the connection after this many body bytes, for the first <see cref="FailCount"/> requests.</summary>
    public long FailAfterBytes { get; set; } = -1;
    public int FailCount { get; set; }
    /// <summary>Artificial delay per 16 KB chunk, to make downloads slow enough to pause.</summary>
    public int DelayPerChunkMs { get; set; }
    public string? ContentDisposition { get; set; }
    public string? RequireBasicAuth { get; set; }
    public string? RequireCookie { get; set; }
    public bool WeakETag { get; set; }
    public string ContentType { get; set; } = "application/octet-stream";
}

/// <summary>
/// In-process Kestrel HTTP server on 127.0.0.1 with hand-written Range handling so tests control every edge case.
/// </summary>
public sealed class TestServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly ConcurrentDictionary<string, (TestContent Content, ServeOptions Options)> _files = new();
    private readonly ConcurrentDictionary<string, int> _requestCounts = new();
    private readonly ConcurrentDictionary<string, int> _failuresServed = new();
    public ConcurrentQueue<(string Path, string? Range, string? Authorization, string? Cookie, string? IfRange)> Requests { get; } = new();

    public Uri BaseUri { get; }

    private TestServer(WebApplication app, Uri baseUri)
    {
        _app = app;
        BaseUri = baseUri;
    }

    public static async Task<TestServer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(o => o.Limits.MaxResponseBufferSize = 64 * 1024);
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        TestServer? server = null;
        app.Run(ctx => server!.HandleAsync(ctx));
        await app.StartAsync();
        var addr = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        server = new TestServer(app, new Uri(addr.Replace("[::]", "127.0.0.1") + "/"));
        return server;
    }

    public Uri Add(string path, TestContent content, ServeOptions? options = null)
    {
        _files[path.TrimStart('/')] = (content, options ?? new ServeOptions());
        _failuresServed.TryRemove(path.TrimStart('/'), out _);
        return new Uri(BaseUri, path.TrimStart('/'));
    }

    public Uri Url(string relative) => new(BaseUri, relative.TrimStart('/'));
    public int RequestCount(string path) => _requestCounts.GetValueOrDefault(path.TrimStart('/'));

    private async Task HandleAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path.Value!.TrimStart('/');
        var req = ctx.Request;
        Requests.Enqueue(("/" + path, req.Headers.Range.ToString().NullIfEmpty(), req.Headers.Authorization.ToString().NullIfEmpty(),
            req.Headers.Cookie.ToString().NullIfEmpty(), req.Headers.IfRange.ToString().NullIfEmpty()));
        _requestCounts.AddOrUpdate(path, 1, (_, n) => n + 1);

        // /redirect/{n}/{target...}: n hops of 302 then the target path.
        if (path.StartsWith("redirect/", StringComparison.Ordinal))
        {
            var rest = path["redirect/".Length..];
            var slash = rest.IndexOf('/');
            var n = int.Parse(rest[..slash]);
            var target = rest[(slash + 1)..];
            ctx.Response.StatusCode = 302;
            ctx.Response.Headers.Location = n > 1 ? $"/redirect/{n - 1}/{target}" : "/" + target;
            return;
        }
        if (path.StartsWith("redirect-abs/", StringComparison.Ordinal))
        {
            ctx.Response.StatusCode = 307;
            ctx.Response.Headers.Location = path["redirect-abs/".Length..].Replace("__", "://");
            return;
        }
        if (path.StartsWith("status/", StringComparison.Ordinal))
        {
            ctx.Response.StatusCode = int.Parse(path["status/".Length..]);
            return;
        }

        if (!_files.TryGetValue(path, out var entry)) { ctx.Response.StatusCode = 404; return; }
        var (content, opt) = entry;

        if (opt.RequireBasicAuth is not null)
        {
            var expected = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(opt.RequireBasicAuth));
            if (req.Headers.Authorization != expected)
            {
                ctx.Response.StatusCode = 401;
                ctx.Response.Headers.WWWAuthenticate = "Basic realm=\"test\"";
                return;
            }
        }
        if (opt.RequireCookie is not null && !req.Headers.Cookie.ToString().Contains(opt.RequireCookie, StringComparison.Ordinal))
        {
            ctx.Response.StatusCode = 403;
            return;
        }

        var etag = opt.WeakETag ? "W/" + content.ETag : content.ETag;
        ctx.Response.Headers.ETag = etag;
        ctx.Response.Headers.LastModified = content.LastModified.ToString("R");
        ctx.Response.ContentType = opt.ContentType;
        if (opt.ContentDisposition is not null) ctx.Response.Headers.ContentDisposition = opt.ContentDisposition;

        long start = 0, end = content.Length - 1;
        var partial = false;
        if (opt.SupportRanges)
        {
            ctx.Response.Headers.AcceptRanges = "bytes";
            var rangeHeader = req.Headers.Range.ToString();
            var ifRange = req.Headers.IfRange.ToString();
            var ifRangeOk = string.IsNullOrEmpty(ifRange) || ifRange == content.ETag || ifRange == content.LastModified.ToString("R");
            if (!string.IsNullOrEmpty(rangeHeader) && ifRangeOk && RangeHeaderValue.TryParse(rangeHeader, out var range) && range.Ranges.Count == 1)
            {
                var r = range.Ranges.First();
                start = r.From ?? 0;
                end = Math.Min(r.To ?? content.Length - 1, content.Length - 1);
                if (start >= content.Length || start > end)
                {
                    ctx.Response.StatusCode = 416;
                    ctx.Response.Headers.ContentRange = $"bytes */{content.Length}";
                    return;
                }
                partial = true;
            }
        }

        ctx.Response.StatusCode = partial ? 206 : 200;
        var length = end - start + 1;
        if (partial) ctx.Response.Headers.ContentRange = $"bytes {start}-{end}/{content.Length}";
        if (!(opt.Chunked && !partial)) ctx.Response.ContentLength = content.Length == 0 ? 0 : length;
        if (content.Length == 0) return;

        var failNow = opt.FailAfterBytes >= 0 && _failuresServed.AddOrUpdate(path, 1, (_, n) => n + 1) <= opt.FailCount;
        var buf = new byte[16 * 1024];
        long sent = 0;
        var ct = ctx.RequestAborted;
        try
        {
            while (sent < length)
            {
                var n = (int)Math.Min(buf.Length, length - sent);
                if (failNow && sent + n > opt.FailAfterBytes) n = (int)(opt.FailAfterBytes - sent);
                if (n > 0)
                {
                    content.Fill(start + sent, buf.AsSpan(0, n));
                    await ctx.Response.Body.WriteAsync(buf.AsMemory(0, n), ct);
                    sent += n;
                }
                if (failNow && sent >= opt.FailAfterBytes)
                {
                    await ctx.Response.Body.FlushAsync(ct);
                    await Task.Delay(20, ct);
                    ctx.Abort();
                    return;
                }
                if (opt.DelayPerChunkMs > 0) await Task.Delay(opt.DelayPerChunkMs, ct);
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}

internal static class StringExt
{
    public static string? NullIfEmpty(this string s) => string.IsNullOrEmpty(s) ? null : s;
}

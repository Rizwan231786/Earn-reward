using System.Net;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.Engine.Http;

/// <summary>Builds the shared <see cref="HttpClient"/> used by the engine.</summary>
public static class HttpClientProvider
{
    public static HttpClient Create(EngineOptions options, HttpMessageHandler? handlerOverride = null)
    {
        var handler = handlerOverride ?? CreateHandler(options);
        return new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public static SocketsHttpHandler CreateHandler(EngineOptions options)
    {
        var h = new SocketsHttpHandler
        {
            // Redirects are followed manually so every hop is validated and credentials never leak cross-origin.
            AllowAutoRedirect = false,
            // Cookies come from the browser per download and are sent explicitly, never shared across downloads.
            UseCookies = false,
            // Byte ranges refer to the encoded entity; decompression would corrupt segmented downloads.
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = options.ConnectTimeout,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(60),
            MaxConnectionsPerServer = 64,
            EnableMultipleHttp2Connections = true,
        };
        switch (options.ProxyMode)
        {
            case ProxyMode.None:
                h.UseProxy = false;
                break;
            case ProxyMode.Manual when !string.IsNullOrWhiteSpace(options.ProxyAddress):
                var addr = options.ProxyAddress!.Contains("://", StringComparison.Ordinal) ? options.ProxyAddress : "http://" + options.ProxyAddress;
                h.Proxy = new WebProxy(new Uri(addr)) { Credentials = options.ProxyCredentials };
                h.UseProxy = true;
                break;
            default:
                h.UseProxy = true; // system proxy (WinINet/IE settings on Windows)
                h.DefaultProxyCredentials = options.ProxyCredentials ?? CredentialCache.DefaultCredentials;
                break;
        }
        return h;
    }
}

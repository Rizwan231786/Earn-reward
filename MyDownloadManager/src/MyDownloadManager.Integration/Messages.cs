using System.Text.Json;
using System.Text.Json.Serialization;
using MyDownloadManager.Core.Security;

namespace MyDownloadManager.Integration;

/// <summary>Message types exchanged between the browser extension, the native host and the app.</summary>
public static class MessageTypes
{
    public const string Ping = "ping";                 // health check; reply says whether the app is running
    public const string Download = "download";         // a single file download (link click / intercepted download)
    public const string Batch = "batch";               // several links ("download all links")
    public const string Media = "media";               // a detected media resource (mp4/webm/hls/dash)
    public const string Inspect = "inspect";           // list qualities of an HLS/DASH stream
    public const string GetConfig = "config";          // interception settings for the extension
    public const string Activate = "activate";         // second app instance → bring window to front
    public const string AddUrls = "add-urls";          // second app instance → command line URLs

    public static readonly IReadOnlySet<string> All = new HashSet<string> { Ping, Download, Batch, Media, Inspect, GetConfig, Activate, AddUrls };
}

/// <summary>A request from the browser extension (relayed by the native host) or from another app instance.</summary>
public sealed class BrowserMessage
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("url")] public string? Url { get; set; }
    [JsonPropertyName("urls")] public List<string>? Urls { get; set; }
    [JsonPropertyName("referrer")] public string? Referrer { get; set; }
    [JsonPropertyName("pageUrl")] public string? PageUrl { get; set; }
    [JsonPropertyName("pageTitle")] public string? PageTitle { get; set; }
    [JsonPropertyName("fileName")] public string? FileName { get; set; }
    [JsonPropertyName("cookies")] public string? Cookies { get; set; }
    [JsonPropertyName("userAgent")] public string? UserAgent { get; set; }
    [JsonPropertyName("headers")] public Dictionary<string, string>? Headers { get; set; }
    [JsonPropertyName("fileSize")] public long? FileSize { get; set; }
    [JsonPropertyName("mime")] public string? Mime { get; set; }
    /// <summary>For media: "direct", "hls" or "dash".</summary>
    [JsonPropertyName("mediaKind")] public string? MediaKind { get; set; }
    [JsonPropertyName("selection")] public string? Selection { get; set; }
    [JsonPropertyName("browser")] public string? Browser { get; set; }
    [JsonPropertyName("silent")] public bool Silent { get; set; }
}

/// <summary>Reply sent back to the extension.</summary>
public sealed class HostResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("appRunning")] public bool AppRunning { get; set; } = true;
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("data")] public JsonElement? Data { get; set; }

    public static HostResponse Success(object? data = null) => new()
    {
        Ok = true,
        Data = data is null ? null : JsonSerializer.SerializeToElement(data, Json.Options),
    };
    public static HostResponse Fail(string error) => new() { Ok = false, Error = error };
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        MaxDepth = 16,
    };
}

/// <summary>Validates untrusted messages before the app acts on them.</summary>
public static class MessageValidator
{
    public const int MaxUrls = 2000;
    public const int MaxHeaders = 32;
    public const int MaxFieldLength = 8192;
    public const int MaxCookieLength = 64 * 1024;

    private static readonly HashSet<string> AllowedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Accept", "Accept-Language", "Origin", "Authorization", "X-Requested-With",
    };

    public static bool TryValidate(BrowserMessage m, out string? error)
    {
        error = null;
        if (!MessageTypes.All.Contains(m.Type)) { error = $"Unknown message type '{m.Type}'."; return false; }
        if (TooLong(m.FileName) || TooLong(m.Referrer) || TooLong(m.PageUrl) || TooLong(m.PageTitle) || TooLong(m.UserAgent) || TooLong(m.Mime) || TooLong(m.Selection))
        { error = "A field exceeds the maximum length."; return false; }
        if (m.Cookies is { Length: > MaxCookieLength }) { error = "Cookie header too long."; return false; }
        if (m.Cookies is not null && m.Cookies.IndexOfAny(['\r', '\n', '\0']) >= 0) { error = "Invalid cookie header."; return false; }
        if (m.Referrer is not null && !UrlValidator.IsValid(m.Referrer)) m.Referrer = null;
        if (m.Headers is not null)
        {
            if (m.Headers.Count > MaxHeaders) { error = "Too many headers."; return false; }
            m.Headers = m.Headers
                .Where(h => AllowedHeaders.Contains(h.Key) && h.Value.Length <= MaxFieldLength && h.Value.IndexOfAny(['\r', '\n', '\0']) < 0)
                .ToDictionary(h => h.Key, h => h.Value, StringComparer.OrdinalIgnoreCase);
        }
        switch (m.Type)
        {
            case MessageTypes.Download:
            case MessageTypes.Media:
            case MessageTypes.Inspect:
                if (!UrlValidator.TryValidate(m.Url, out _, out var urlErr)) { error = urlErr; return false; }
                if (m.MediaKind is not (null or "direct" or "hls" or "dash")) { error = "Invalid media kind."; return false; }
                break;
            case MessageTypes.Batch:
            case MessageTypes.AddUrls:
                if (m.Urls is null || m.Urls.Count == 0) { error = "No URLs."; return false; }
                if (m.Urls.Count > MaxUrls) { error = $"At most {MaxUrls} URLs per request."; return false; }
                m.Urls = m.Urls.Where(UrlValidator.IsValid).Distinct(StringComparer.Ordinal).ToList();
                if (m.Urls.Count == 0) { error = "No valid http(s) URLs."; return false; }
                break;
        }
        return true;

        static bool TooLong(string? s) => s is { Length: > MaxFieldLength };
    }
}

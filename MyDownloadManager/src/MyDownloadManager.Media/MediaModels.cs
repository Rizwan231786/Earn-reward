using System.Text.Json;
using System.Text.Json.Serialization;

namespace MyDownloadManager.Media;

/// <summary>Byte range inside a resource (HLS EXT-X-BYTERANGE / DASH indexRange). <see cref="Length"/> bytes from <see cref="Offset"/>.</summary>
public sealed record ByteRange(long Offset, long Length);

/// <summary>HLS AES-128 key reference (standard HLS clear-key encryption — not DRM).</summary>
public sealed record SegmentKey(Uri KeyUri, byte[]? IV);

/// <summary>One downloadable media segment.</summary>
public sealed record MediaSegment(Uri Uri, ByteRange? Range = null, SegmentKey? Key = null, long Sequence = 0, double Duration = 0);

/// <summary>An elementary track (video+audio muxed, video only or audio only) as an ordered list of segments.</summary>
public sealed class MediaTrack
{
    public required string Name { get; init; }          // "video", "audio", "main"
    public MediaSegment? Init { get; init; }              // fMP4 initialization segment
    public required IReadOnlyList<MediaSegment> Segments { get; init; }
    /// <summary>"ts" for MPEG-TS segments, "mp4" for fragmented MP4 / CMAF, "webm" for WebM.</summary>
    public string Container { get; init; } = "ts";
}

/// <summary>A selectable quality level (HLS variant stream or DASH video representation).</summary>
public sealed record MediaVariant(
    string Id,
    long Bandwidth,
    int? Width,
    int? Height,
    string? Codecs,
    Uri? PlaylistUri,
    string? AudioGroup)
{
    public string Label =>
        (Height is { } h ? $"{h}p" : "audio/other") + (Bandwidth > 0 ? $" · {Bandwidth / 1000} kbps" : "") +
        (string.IsNullOrEmpty(Codecs) ? "" : $" · {Codecs}");
}

/// <summary>Result of inspecting a manifest URL.</summary>
public sealed class MediaInfo
{
    public required MediaFormat Format { get; init; }
    public List<MediaVariant> Variants { get; init; } = [];
    public List<MediaVariant> AudioRenditions { get; init; } = [];
    public bool IsLive { get; init; }
    public bool IsDrmProtected { get; init; }
    public string? DrmSystem { get; init; }
    public double? DurationSeconds { get; init; }

    /// <summary>User-facing reason why this stream cannot be downloaded, or null when it can.</summary>
    public string? BlockReason =>
        IsDrmProtected ? $"This stream is protected by DRM ({DrmSystem ?? "encrypted media"}). MyDownloadManager does not circumvent DRM or other access controls."
        : IsLive ? "This is a live stream. Only on-demand (VOD) streams with a complete playlist can be downloaded."
        : null;
}

public enum MediaFormat { Hls, Dash, Direct }

/// <summary>User's choice of tracks for an HLS/DASH download, stored as JSON in DownloadItem.MediaSelection.</summary>
public sealed class MediaSelection
{
    /// <summary>Variant id (HLS: index in master playlist; DASH: Representation@id). Null = best quality.</summary>
    public string? VideoId { get; set; }
    /// <summary>Audio rendition / representation id. Null = best / default.</summary>
    public string? AudioId { get; set; }
    /// <summary>Output container: "mp4" (default) or "mkv".</summary>
    public string Container { get; set; } = "mp4";

    private static readonly JsonSerializerOptions Json = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    public string ToJson() => JsonSerializer.Serialize(this, Json);
    public static MediaSelection Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new MediaSelection();
        try { return JsonSerializer.Deserialize<MediaSelection>(json, Json) ?? new MediaSelection(); }
        catch (JsonException) { return new MediaSelection(); }
    }
}

/// <summary>Thrown when a manifest cannot be parsed or uses unsupported features.</summary>
public sealed class MediaFormatException(string message) : Exception(message);

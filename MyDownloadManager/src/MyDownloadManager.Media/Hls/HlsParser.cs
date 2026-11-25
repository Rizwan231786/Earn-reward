using System.Globalization;
using System.Text.RegularExpressions;

namespace MyDownloadManager.Media.Hls;

public sealed class HlsMasterPlaylist
{
    public List<MediaVariant> Variants { get; } = [];
    /// <summary>EXT-X-MEDIA TYPE=AUDIO renditions that have their own playlist URI.</summary>
    public List<(MediaVariant Variant, string GroupId, bool IsDefault, string? Language)> Audio { get; } = [];
    public string? DrmSystem { get; set; }
}

public sealed class HlsMediaPlaylist
{
    public List<MediaSegment> Segments { get; } = [];
    public MediaSegment? Init { get; set; }
    public bool HasEndList { get; set; }
    public string? DrmSystem { get; set; }
    public double TotalDuration => Segments.Sum(s => s.Duration);
}

/// <summary>Parser for HLS playlists (RFC 8216). Supports master + media playlists, byte ranges, fMP4 init maps and
/// AES-128 clear-key encryption. SAMPLE-AES and key systems such as FairPlay/Widevine/PlayReady are reported as DRM.</summary>
public static partial class HlsParser
{
    [GeneratedRegex("""([A-Z0-9-]+)=("[^"]*"|[^,]*)""")]
    private static partial Regex AttributeRegex();

    public static bool IsMasterPlaylist(string text) => text.Contains("#EXT-X-STREAM-INF", StringComparison.Ordinal);

    public static Dictionary<string, string> ParseAttributes(string list)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in AttributeRegex().Matches(list)) d[m.Groups[1].Value] = m.Groups[2].Value.Trim('"');
        return d;
    }

    private static IEnumerable<string> Lines(string text)
    {
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim().TrimStart('﻿');
            if (line.Length > 0) yield return line;
        }
    }

    private static void EnsureHeader(string text)
    {
        if (!text.TrimStart('﻿', ' ', '\r', '\n', '\t').StartsWith("#EXTM3U", StringComparison.Ordinal))
            throw new MediaFormatException("Not an HLS playlist (missing #EXTM3U).");
    }

    public static HlsMasterPlaylist ParseMaster(string text, Uri baseUri)
    {
        EnsureHeader(text);
        var result = new HlsMasterPlaylist();
        Dictionary<string, string>? pending = null;
        var index = 0;
        foreach (var line in Lines(text))
        {
            if (line.StartsWith("#EXT-X-STREAM-INF:", StringComparison.Ordinal))
            {
                pending = ParseAttributes(line["#EXT-X-STREAM-INF:".Length..]);
            }
            else if (line.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal))
            {
                var a = ParseAttributes(line["#EXT-X-MEDIA:".Length..]);
                if (a.GetValueOrDefault("TYPE") == "AUDIO" && a.TryGetValue("URI", out var uri))
                {
                    var name = a.GetValueOrDefault("NAME") ?? a.GetValueOrDefault("LANGUAGE") ?? "audio";
                    result.Audio.Add((new MediaVariant($"a{result.Audio.Count}", 0, null, null, name, new Uri(baseUri, uri), a.GetValueOrDefault("GROUP-ID")),
                        a.GetValueOrDefault("GROUP-ID") ?? "", a.GetValueOrDefault("DEFAULT") == "YES", a.GetValueOrDefault("LANGUAGE")));
                }
            }
            else if (line.StartsWith("#EXT-X-SESSION-KEY:", StringComparison.Ordinal))
            {
                result.DrmSystem ??= DetectDrm(ParseAttributes(line["#EXT-X-SESSION-KEY:".Length..]));
            }
            else if (!line.StartsWith('#') && pending is not null)
            {
                int? w = null, h = null;
                if (pending.TryGetValue("RESOLUTION", out var res))
                {
                    var parts = res.Split('x');
                    if (parts.Length == 2 && int.TryParse(parts[0], out var pw) && int.TryParse(parts[1], out var ph)) { w = pw; h = ph; }
                }
                long.TryParse(pending.GetValueOrDefault("BANDWIDTH"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var bw);
                result.Variants.Add(new MediaVariant(index.ToString(CultureInfo.InvariantCulture), bw, w, h,
                    pending.GetValueOrDefault("CODECS"), new Uri(baseUri, line), pending.GetValueOrDefault("AUDIO")));
                index++;
                pending = null;
            }
        }
        if (result.Variants.Count == 0) throw new MediaFormatException("HLS master playlist contains no variant streams.");
        return result;
    }

    public static HlsMediaPlaylist ParseMedia(string text, Uri baseUri)
    {
        EnsureHeader(text);
        var result = new HlsMediaPlaylist();
        long sequence = 0;
        double duration = 0;
        ByteRange? range = null;
        long nextRangeOffset = 0;
        SegmentKey? key = null;
        foreach (var line in Lines(text))
        {
            if (line.StartsWith("#EXT-X-MEDIA-SEQUENCE:", StringComparison.Ordinal))
                long.TryParse(line["#EXT-X-MEDIA-SEQUENCE:".Length..], NumberStyles.Integer, CultureInfo.InvariantCulture, out sequence);
            else if (line.StartsWith("#EXTINF:", StringComparison.Ordinal))
            {
                var v = line["#EXTINF:".Length..].Split(',')[0];
                double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out duration);
            }
            else if (line.StartsWith("#EXT-X-BYTERANGE:", StringComparison.Ordinal))
                range = ParseByteRange(line["#EXT-X-BYTERANGE:".Length..], ref nextRangeOffset);
            else if (line.StartsWith("#EXT-X-KEY:", StringComparison.Ordinal))
            {
                var a = ParseAttributes(line["#EXT-X-KEY:".Length..]);
                var method = a.GetValueOrDefault("METHOD") ?? "NONE";
                if (method == "NONE") key = null;
                else if (method == "AES-128" && (a.GetValueOrDefault("KEYFORMAT") ?? "identity") == "identity" && a.TryGetValue("URI", out var keyUri))
                {
                    if (keyUri.StartsWith("skd:", StringComparison.OrdinalIgnoreCase) || keyUri.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                    { result.DrmSystem ??= "FairPlay"; continue; }
                    key = new SegmentKey(new Uri(baseUri, keyUri), a.TryGetValue("IV", out var iv) ? ParseIv(iv) : null);
                }
                else result.DrmSystem ??= DetectDrm(a) ?? $"HLS {method}";
            }
            else if (line.StartsWith("#EXT-X-MAP:", StringComparison.Ordinal))
            {
                var a = ParseAttributes(line["#EXT-X-MAP:".Length..]);
                if (!a.TryGetValue("URI", out var mapUri)) throw new MediaFormatException("EXT-X-MAP without URI.");
                ByteRange? mapRange = null;
                if (a.TryGetValue("BYTERANGE", out var br)) { var o = 0L; mapRange = ParseByteRange(br, ref o); }
                result.Init = new MediaSegment(new Uri(baseUri, mapUri), mapRange, key);
            }
            else if (line == "#EXT-X-ENDLIST") result.HasEndList = true;
            else if (!line.StartsWith('#'))
            {
                var uri = new Uri(baseUri, line);
                result.Segments.Add(new MediaSegment(uri, range, key, sequence, duration));
                sequence++;
                duration = 0;
                range = null;
            }
        }
        return result;
    }

    private static ByteRange ParseByteRange(string spec, ref long nextOffset)
    {
        var parts = spec.Trim('"').Split('@');
        var len = long.Parse(parts[0], CultureInfo.InvariantCulture);
        var off = parts.Length > 1 ? long.Parse(parts[1], CultureInfo.InvariantCulture) : nextOffset;
        nextOffset = off + len;
        return new ByteRange(off, len);
    }

    private static byte[] ParseIv(string iv)
    {
        var hex = iv.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? iv[2..] : iv;
        hex = hex.PadLeft(32, '0');
        if (hex.Length != 32) throw new MediaFormatException("Invalid AES IV.");
        return Convert.FromHexString(hex);
    }

    private static string? DetectDrm(Dictionary<string, string> a)
    {
        var method = a.GetValueOrDefault("METHOD") ?? "";
        var format = a.GetValueOrDefault("KEYFORMAT") ?? "";
        var uri = a.GetValueOrDefault("URI") ?? "";
        if (format.Contains("streamingkeydelivery", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("skd:", StringComparison.OrdinalIgnoreCase)) return "Apple FairPlay";
        if (format.Contains("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", StringComparison.OrdinalIgnoreCase)) return "Google Widevine";
        if (format.Contains("com.microsoft.playready", StringComparison.OrdinalIgnoreCase) || format.Contains("9a04f079", StringComparison.OrdinalIgnoreCase)) return "Microsoft PlayReady";
        if (method.StartsWith("SAMPLE-AES", StringComparison.OrdinalIgnoreCase)) return "HLS " + method;
        return method is "NONE" or "" ? null : $"HLS {method} ({format})";
    }
}

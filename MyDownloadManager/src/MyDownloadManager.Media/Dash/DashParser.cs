using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace MyDownloadManager.Media.Dash;

public sealed class DashRepresentation
{
    public required string Id { get; init; }
    public required string ContentType { get; init; } // "video" | "audio" | "text" | other
    public long Bandwidth { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public string? Codecs { get; init; }
    public string? MimeType { get; init; }
    public string? Language { get; init; }
    public required MediaTrack Track { get; init; }

    public MediaVariant ToVariant() => new(Id, Bandwidth, Width, Height, Codecs, null, null);
}

public sealed class DashManifest
{
    public bool IsLive { get; init; }
    public double? DurationSeconds { get; init; }
    public string? DrmSystem { get; set; }
    public List<DashRepresentation> Video { get; } = [];
    public List<DashRepresentation> Audio { get; } = [];
}

/// <summary>Parser for MPEG-DASH MPDs (static/VOD, single period). Any ContentProtection element is treated as DRM.</summary>
public static partial class DashParser
{
    private const int MaxSegments = 200_000;

    [GeneratedRegex(@"\$(RepresentationID|Number|Time|Bandwidth)(%0(\d+)d)?\$|\$\$")]
    private static partial Regex TemplateRegex();

    public static DashManifest Parse(string xml, Uri manifestUri)
    {
        XDocument doc;
        try
        {
            // DTD processing is prohibited (XXE / billion-laughs protection).
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            doc = XDocument.Load(reader);
        }
        catch (XmlException ex) { throw new MediaFormatException($"Invalid DASH manifest: {ex.Message}"); }

        var mpd = doc.Root ?? throw new MediaFormatException("Empty DASH manifest.");
        if (mpd.Name.LocalName != "MPD") throw new MediaFormatException("Not a DASH manifest (root is not MPD).");
        var ns = mpd.Name.Namespace;
        var isLive = string.Equals((string?)mpd.Attribute("type"), "dynamic", StringComparison.OrdinalIgnoreCase);
        var duration = ParseDuration((string?)mpd.Attribute("mediaPresentationDuration"));

        var periods = mpd.Elements(ns + "Period").ToList();
        if (periods.Count == 0) throw new MediaFormatException("DASH manifest has no Period.");
        var result = new DashManifest { IsLive = isLive, DurationSeconds = duration };
        if (periods.Count > 1 && !isLive)
            throw new MediaFormatException("Multi-period DASH manifests (e.g. with inserted ads) are not supported.");
        var period = periods[0];
        var periodDuration = ParseDuration((string?)period.Attribute("duration")) ?? duration;

        var mpdBase = ResolveBase(manifestUri, mpd, ns);
        var periodBase = ResolveBase(mpdBase, period, ns);

        foreach (var set in period.Elements(ns + "AdaptationSet"))
        {
            var setBase = ResolveBase(periodBase, set, ns);
            var setDrm = Drm(set, ns);
            foreach (var rep in set.Elements(ns + "Representation"))
            {
                var drm = setDrm ?? Drm(rep, ns);
                if (drm is not null) { result.DrmSystem ??= drm; continue; }

                var mime = (string?)rep.Attribute("mimeType") ?? (string?)set.Attribute("mimeType");
                var contentType = (string?)set.Attribute("contentType") ?? mime?.Split('/')[0] ?? "";
                if (contentType == "application" && ((string?)rep.Attribute("codecs") ?? "").StartsWith("stpp", StringComparison.Ordinal)) contentType = "text";
                var id = (string?)rep.Attribute("id") ?? Guid.NewGuid().ToString("N");
                var bw = long.TryParse((string?)rep.Attribute("bandwidth"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var b) ? b : 0;
                var repBase = ResolveBase(setBase, rep, ns);
                var container = mime?.Contains("webm", StringComparison.OrdinalIgnoreCase) == true ? "webm" : "mp4";
                if (contentType is not ("video" or "audio")) continue;

                var track = BuildTrack(contentType, rep, set, period, ns, repBase, id, bw, periodDuration, container, isLive);
                var dr = new DashRepresentation
                {
                    Id = id, ContentType = contentType, Bandwidth = bw,
                    Width = (int?)rep.Attribute("width") ?? (int?)set.Attribute("width"),
                    Height = (int?)rep.Attribute("height") ?? (int?)set.Attribute("height"),
                    Codecs = (string?)rep.Attribute("codecs") ?? (string?)set.Attribute("codecs"),
                    MimeType = mime, Language = (string?)set.Attribute("lang"), Track = track,
                };
                (contentType == "video" ? result.Video : result.Audio).Add(dr);
            }
        }
        if (result.Video.Count == 0 && result.Audio.Count == 0 && result.DrmSystem is null)
            throw new MediaFormatException("DASH manifest contains no audio or video representations.");
        return result;
    }

    private static string? Drm(XElement e, XNamespace ns)
    {
        var cp = e.Elements(ns + "ContentProtection").ToList();
        if (cp.Count == 0) return null;
        var ids = string.Join(" ", cp.Select(c => ((string?)c.Attribute("schemeIdUri") ?? "").ToLowerInvariant()));
        if (ids.Contains("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")) return "Google Widevine";
        if (ids.Contains("9a04f079-9840-4286-ab92-e65be0885f95")) return "Microsoft PlayReady";
        if (ids.Contains("94ce86fb-07ff-4f43-adb8-93d2fa968ca2")) return "Apple FairPlay";
        if (ids.Contains("e2719d58-a985-b3c9-781a-b030af78d30e")) return "ClearKey (EME)";
        return "Common Encryption (CENC)";
    }

    private static Uri ResolveBase(Uri parent, XElement e, XNamespace ns)
    {
        var b = e.Element(ns + "BaseURL")?.Value.Trim();
        return string.IsNullOrEmpty(b) ? parent : new Uri(parent, b);
    }

    private static double? ParseDuration(string? iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return null;
        try { return XmlConvert.ToTimeSpan(iso).TotalSeconds; } catch (FormatException) { return null; }
    }

    private static MediaTrack BuildTrack(string name, XElement rep, XElement set, XElement period, XNamespace ns, Uri baseUri,
        string repId, long bandwidth, double? periodDuration, string container, bool isLive)
    {
        // Inheritance: Representation > AdaptationSet > Period.
        var template = rep.Element(ns + "SegmentTemplate") ?? set.Element(ns + "SegmentTemplate") ?? period.Element(ns + "SegmentTemplate");
        var list = rep.Element(ns + "SegmentList") ?? set.Element(ns + "SegmentList");
        var segBase = rep.Element(ns + "SegmentBase") ?? set.Element(ns + "SegmentBase");

        if (template is not null)
        {
            string? Attr(string n) => (string?)rep.Element(ns + "SegmentTemplate")?.Attribute(n) ?? (string?)set.Element(ns + "SegmentTemplate")?.Attribute(n)
                ?? (string?)period.Element(ns + "SegmentTemplate")?.Attribute(n);
            var media = Attr("media") ?? throw new MediaFormatException("SegmentTemplate without @media.");
            var init = Attr("initialization");
            var timescale = long.TryParse(Attr("timescale"), out var ts) && ts > 0 ? ts : 1;
            var startNumber = long.TryParse(Attr("startNumber"), out var sn) ? sn : 1;
            var segments = new List<MediaSegment>();
            var timeline = (rep.Element(ns + "SegmentTemplate") ?? set.Element(ns + "SegmentTemplate") ?? template).Element(ns + "SegmentTimeline")
                           ?? template.Element(ns + "SegmentTimeline");
            if (timeline is not null)
            {
                long t = 0, number = startNumber;
                foreach (var s in timeline.Elements(ns + "S"))
                {
                    if (long.TryParse((string?)s.Attribute("t"), out var st)) t = st;
                    var d = long.Parse((string?)s.Attribute("d") ?? throw new MediaFormatException("SegmentTimeline S without @d."), CultureInfo.InvariantCulture);
                    var r = int.TryParse((string?)s.Attribute("r"), out var rr) ? rr : 0;
                    if (r < 0)
                    {
                        if (periodDuration is null) throw new MediaFormatException("Open-ended SegmentTimeline repeat without a known duration.");
                        r = (int)Math.Ceiling((periodDuration.Value * timescale - t) / d) - 1;
                    }
                    for (var i = 0; i <= r; i++)
                    {
                        segments.Add(new MediaSegment(new Uri(baseUri, Expand(media, repId, number, t, bandwidth)), Sequence: number, Duration: (double)d / timescale));
                        t += d; number++;
                        if (segments.Count > MaxSegments) throw new MediaFormatException("Too many segments in manifest.");
                    }
                }
            }
            else
            {
                var dur = long.TryParse(Attr("duration"), out var dd) && dd > 0 ? dd : throw new MediaFormatException("SegmentTemplate has neither SegmentTimeline nor @duration.");
                if (periodDuration is null) throw new MediaFormatException(isLive ? "Live DASH streams are not supported." : "DASH manifest has no duration.");
                var count = (long)Math.Ceiling(periodDuration.Value * timescale / dur - 1e-9);
                if (count > MaxSegments) throw new MediaFormatException("Too many segments in manifest.");
                for (long i = 0; i < count; i++)
                {
                    var number = startNumber + i;
                    segments.Add(new MediaSegment(new Uri(baseUri, Expand(media, repId, number, i * dur, bandwidth)), Sequence: number, Duration: (double)dur / timescale));
                }
            }
            return new MediaTrack
            {
                Name = name, Container = container, Segments = segments,
                Init = init is null ? null : new MediaSegment(new Uri(baseUri, Expand(init, repId, startNumber, 0, bandwidth))),
            };
        }

        if (list is not null)
        {
            var initEl = list.Element(ns + "Initialization");
            MediaSegment? init = null;
            if (initEl is not null)
                init = new MediaSegment(new Uri(baseUri, (string?)initEl.Attribute("sourceURL") ?? ""), ParseRange((string?)initEl.Attribute("range")));
            var segments = list.Elements(ns + "SegmentURL").Select((s, i) => new MediaSegment(
                new Uri(baseUri, (string?)s.Attribute("media") ?? ""), ParseRange((string?)s.Attribute("mediaRange")), Sequence: i)).ToList();
            return new MediaTrack { Name = name, Container = container, Init = init, Segments = segments };
        }

        // SegmentBase or a bare BaseURL: the representation is one self-contained file.
        _ = segBase;
        return new MediaTrack { Name = name, Container = container, Segments = [new MediaSegment(baseUri)] };
    }

    private static ByteRange? ParseRange(string? r)
    {
        if (string.IsNullOrWhiteSpace(r)) return null;
        var p = r.Split('-');
        var start = long.Parse(p[0], CultureInfo.InvariantCulture);
        var end = long.Parse(p[1], CultureInfo.InvariantCulture);
        return new ByteRange(start, end - start + 1);
    }

    internal static string Expand(string template, string repId, long number, long time, long bandwidth) =>
        TemplateRegex().Replace(template, m =>
        {
            if (m.Value == "$$") return "$";
            var value = m.Groups[1].Value switch
            {
                "RepresentationID" => repId,
                "Number" => Format(number, m.Groups[3].Value),
                "Time" => Format(time, m.Groups[3].Value),
                "Bandwidth" => Format(bandwidth, m.Groups[3].Value),
                _ => m.Value,
            };
            return value;
        });

    private static string Format(long v, string width) =>
        string.IsNullOrEmpty(width) ? v.ToString(CultureInfo.InvariantCulture) : v.ToString(CultureInfo.InvariantCulture).PadLeft(int.Parse(width, CultureInfo.InvariantCulture), '0');

    /// <summary>Detects whether text looks like an MPD (for content sniffing).</summary>
    public static bool LooksLikeMpd(string text) => text.Contains("<MPD", StringComparison.Ordinal);

    internal static string Describe(DashManifest m)
    {
        var sb = new StringBuilder();
        foreach (var v in m.Video) sb.Append(CultureInfo.InvariantCulture, $"V {v.Id} {v.Bandwidth} {v.Height}p {v.Track.Segments.Count} segs\n");
        foreach (var a in m.Audio) sb.Append(CultureInfo.InvariantCulture, $"A {a.Id} {a.Bandwidth} {a.Track.Segments.Count} segs\n");
        return sb.ToString();
    }
}

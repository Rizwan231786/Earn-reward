using System.Net;
using System.Text;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Http;
using MyDownloadManager.Media.Dash;
using MyDownloadManager.Media.Hls;

namespace MyDownloadManager.Media;

/// <summary>Resolved tracks for a media download.</summary>
public sealed record ResolvedMedia(MediaInfo Info, IReadOnlyList<MediaTrack> Tracks);

/// <summary>Fetches HLS/DASH manifests and turns them into downloadable tracks (respecting the user's selection).</summary>
public sealed class MediaResolver(HttpClient client, EngineOptions options)
{
    private const int MaxManifestBytes = 16 * 1024 * 1024;

    public static MediaFormat? DetectFormat(string url, string? contentType = null)
    {
        var ct = contentType?.ToLowerInvariant() ?? "";
        if (ct.Contains("mpegurl")) return MediaFormat.Hls;
        if (ct.Contains("dash+xml")) return MediaFormat.Dash;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return null;
        var path = u.AbsolutePath.ToLowerInvariant();
        if (path.EndsWith(".m3u8", StringComparison.Ordinal) || path.EndsWith(".m3u", StringComparison.Ordinal)) return MediaFormat.Hls;
        if (path.EndsWith(".mpd", StringComparison.Ordinal)) return MediaFormat.Dash;
        if (path.EndsWith(".mp4", StringComparison.Ordinal) || path.EndsWith(".webm", StringComparison.Ordinal) || path.EndsWith(".m4v", StringComparison.Ordinal)
            || path.EndsWith(".mov", StringComparison.Ordinal) || path.EndsWith(".mp3", StringComparison.Ordinal) || path.EndsWith(".m4a", StringComparison.Ordinal)
            || path.EndsWith(".ogg", StringComparison.Ordinal) || path.EndsWith(".ogv", StringComparison.Ordinal)) return MediaFormat.Direct;
        if (ct.StartsWith("video/", StringComparison.Ordinal) || ct.StartsWith("audio/", StringComparison.Ordinal)) return MediaFormat.Direct;
        return null;
    }

    public async Task<string> FetchTextAsync(DownloadItem item, Uri uri, CancellationToken ct)
    {
        var rb = new RequestBuilder(client, item, options);
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                var (resp, _) = await rb.SendAsync(uri, null, null, null, ct).ConfigureAwait(false);
                using (resp)
                {
                    if (resp.StatusCode != HttpStatusCode.OK) throw DownloadException.FromStatus(resp.StatusCode, resp.ReasonPhrase);
                    if (resp.Content.Headers.ContentLength > MaxManifestBytes) throw new DownloadException("Manifest is too large.", false);
                    await using var s = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                    using var ms = new MemoryStream();
                    var buf = new byte[81920];
                    int n;
                    while ((n = await s.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
                    {
                        ms.Write(buf, 0, n);
                        if (ms.Length > MaxManifestBytes) throw new DownloadException("Manifest is too large.", false);
                    }
                    return Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                }
            }
            catch (DownloadException ex) when (ex.IsTransient && attempt <= 3 && !ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(300 * attempt), ct).ConfigureAwait(false);
            }
            catch (IOException) when (attempt <= 3 && !ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(300 * attempt), ct).ConfigureAwait(false);
            }
        }
    }

    /// <summary>Inspects a manifest and lists the qualities (used by the UI and the browser extension).</summary>
    public async Task<MediaInfo> InspectAsync(DownloadItem item, CancellationToken ct) =>
        (await ResolveAsync(item, new MediaSelection(), ct).ConfigureAwait(false)).Info;

    public async Task<ResolvedMedia> ResolveAsync(DownloadItem item, MediaSelection selection, CancellationToken ct)
    {
        var uri = new Uri(item.Url);
        var text = await FetchTextAsync(item, uri, ct).ConfigureAwait(false);
        var isHls = item.Kind == DownloadKind.Hls || (item.Kind != DownloadKind.Dash && text.TrimStart('﻿', ' ', '\r', '\n').StartsWith("#EXTM3U", StringComparison.Ordinal));
        if (isHls) return await ResolveHlsAsync(item, uri, text, selection, ct).ConfigureAwait(false);
        if (item.Kind == DownloadKind.Dash || DashParser.LooksLikeMpd(text)) return ResolveDash(uri, text, selection);
        throw new MediaFormatException("The URL does not point to an HLS (.m3u8) or DASH (.mpd) manifest.");
    }

    private async Task<ResolvedMedia> ResolveHlsAsync(DownloadItem item, Uri uri, string text, MediaSelection selection, CancellationToken ct)
    {
        if (!HlsParser.IsMasterPlaylist(text))
        {
            var media = HlsParser.ParseMedia(text, uri);
            var info = new MediaInfo
            {
                Format = MediaFormat.Hls, IsLive = !media.HasEndList, IsDrmProtected = media.DrmSystem is not null,
                DrmSystem = media.DrmSystem, DurationSeconds = media.TotalDuration,
                Variants = [new MediaVariant("0", 0, null, null, null, uri, null)],
            };
            return new ResolvedMedia(info, [HlsTrack("main", media)]);
        }

        var master = HlsParser.ParseMaster(text, uri);
        var variant = master.Variants.FirstOrDefault(v => v.Id == selection.VideoId)
                      ?? master.Variants.OrderByDescending(v => v.Height ?? 0).ThenByDescending(v => v.Bandwidth).First();
        var variantPlaylist = HlsParser.ParseMedia(await FetchTextAsync(item, variant.PlaylistUri!, ct).ConfigureAwait(false), variant.PlaylistUri!);
        var tracks = new List<MediaTrack> { HlsTrack("video", variantPlaylist) };
        var drm = master.DrmSystem ?? variantPlaylist.DrmSystem;
        var live = !variantPlaylist.HasEndList;

        var groupAudio = master.Audio.Where(a => a.GroupId == variant.AudioGroup).ToList();
        if (groupAudio.Count > 0)
        {
            var chosen = groupAudio.FirstOrDefault(a => a.Variant.Id == selection.AudioId);
            if (chosen.Variant is null) chosen = groupAudio.FirstOrDefault(a => a.IsDefault);
            if (chosen.Variant is null) chosen = groupAudio[0];
            var audio = HlsParser.ParseMedia(await FetchTextAsync(item, chosen.Variant.PlaylistUri!, ct).ConfigureAwait(false), chosen.Variant.PlaylistUri!);
            drm ??= audio.DrmSystem;
            live |= !audio.HasEndList;
            tracks.Add(HlsTrack("audio", audio));
        }

        return new ResolvedMedia(new MediaInfo
        {
            Format = MediaFormat.Hls, Variants = master.Variants, AudioRenditions = master.Audio.Select(a => a.Variant).ToList(),
            IsLive = live, IsDrmProtected = drm is not null, DrmSystem = drm, DurationSeconds = variantPlaylist.TotalDuration,
        }, tracks);
    }

    private static MediaTrack HlsTrack(string name, HlsMediaPlaylist p)
    {
        var container = p.Init is not null ? "mp4" : "ts";
        if (p.Init is null && p.Segments.Count > 0)
        {
            var ext = Path.GetExtension(p.Segments[0].Uri.AbsolutePath).TrimStart('.').ToLowerInvariant();
            if (ext is "aac" or "mp3" or "ac3" or "ec3") container = ext;
        }
        return new MediaTrack { Name = name, Init = p.Init, Segments = p.Segments, Container = container };
    }

    private static ResolvedMedia ResolveDash(Uri uri, string text, MediaSelection selection)
    {
        var m = DashParser.Parse(text, uri);
        var info = new MediaInfo
        {
            Format = MediaFormat.Dash, IsLive = m.IsLive, DurationSeconds = m.DurationSeconds,
            IsDrmProtected = m.DrmSystem is not null && m.Video.Count == 0, DrmSystem = m.DrmSystem,
            Variants = m.Video.Select(v => v.ToVariant()).ToList(),
            AudioRenditions = m.Audio.Select(a => new MediaVariant(a.Id, a.Bandwidth, null, null, a.Codecs ?? a.Language, null, null)).ToList(),
        };
        var tracks = new List<MediaTrack>();
        var video = m.Video.FirstOrDefault(v => v.Id == selection.VideoId)
                    ?? m.Video.OrderByDescending(v => v.Height ?? 0).ThenByDescending(v => v.Bandwidth).FirstOrDefault();
        var audio = m.Audio.FirstOrDefault(a => a.Id == selection.AudioId) ?? m.Audio.OrderByDescending(a => a.Bandwidth).FirstOrDefault();
        if (video is not null) tracks.Add(video.Track);
        if (audio is not null) tracks.Add(audio.Track);
        return new ResolvedMedia(info, tracks);
    }
}

using System.Text.Json;
using Microsoft.Extensions.Logging;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Integration;
using MyDownloadManager.Media;

namespace MyDownloadManager.Application;

/// <summary>UI callbacks used by non-UI services (implemented by the WPF shell; faked in tests).</summary>
public interface IUserInteraction
{
    /// <summary>Opens the "Add downloads" dialog pre-filled with URLs; the user reviews and confirms.</summary>
    void ShowAddDialog(IReadOnlyList<string> urls, string? referrer = null);
    void Notify(string title, string message);
    void ActivateMainWindow();
}

/// <summary>
/// Handles requests from the browser extension (via native host) and from second app instances.
/// Messages arrive already validated by <see cref="MessageValidator"/>.
/// </summary>
public sealed class BrowserRequestHandler(
    DownloadManager manager,
    SettingsService settings,
    Func<MediaResolver> resolverFactory,
    IUserInteraction ui,
    ILogger<BrowserRequestHandler> logger)
{
    public static string Version => typeof(BrowserRequestHandler).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    public async Task<HostResponse> HandleAsync(BrowserMessage m, CancellationToken ct)
    {
        var s = settings.Current;
        switch (m.Type)
        {
            case MessageTypes.Ping:
                return new HostResponse { Ok = true, Version = Version };

            case MessageTypes.GetConfig:
                return HostResponse.Success(new
                {
                    enabled = s.BrowserIntegrationEnabled,
                    extensions = s.InterceptExtensions,
                    minSizeBytes = s.InterceptMinimumBytes,
                });

            case MessageTypes.Activate:
                ui.ActivateMainWindow();
                return HostResponse.Success();

            case MessageTypes.AddUrls:
            case MessageTypes.Batch:
                ui.ShowAddDialog(m.Urls!, m.Referrer);
                return HostResponse.Success(new { pending = m.Urls!.Count });

            case MessageTypes.Download:
            {
                if (!s.BrowserIntegrationEnabled) return HostResponse.Fail("Browser integration is disabled in MyDownloadManager settings.");
                var item = await manager.AddAsync(new AddDownloadRequest
                {
                    Url = m.Url!, FileName = m.FileName, Referrer = m.Referrer, Cookies = m.Cookies, UserAgent = m.UserAgent,
                    Headers = m.Headers,
                }, ct).ConfigureAwait(false);
                logger.LogInformation("Browser download added: {Url}", UrlValidator.Redact(m.Url));
                ui.Notify("Download added", string.IsNullOrEmpty(item.FileName) ? UrlValidator.Redact(item.Url) : item.FileName);
                return HostResponse.Success(new { id = item.Id });
            }

            case MessageTypes.Inspect:
            {
                var info = await InspectAsync(m, ct).ConfigureAwait(false);
                return HostResponse.Success(new
                {
                    format = info.Format.ToString().ToLowerInvariant(),
                    blocked = info.BlockReason,
                    duration = info.DurationSeconds,
                    variants = info.Variants.Select(v => new { id = v.Id, label = v.Label, height = v.Height, bandwidth = v.Bandwidth }),
                });
            }

            case MessageTypes.Media:
                return await AddMediaAsync(m, ct).ConfigureAwait(false);

            default:
                return HostResponse.Fail("Unsupported request.");
        }
    }

    private async Task<MediaInfo> InspectAsync(BrowserMessage m, CancellationToken ct)
    {
        var probe = new DownloadItem
        {
            Url = m.Url!, TargetDirectory = settings.Current.DefaultDownloadDirectory, Referrer = m.Referrer, Cookies = m.Cookies,
            UserAgent = m.UserAgent, Kind = m.MediaKind == "dash" ? DownloadKind.Dash : DownloadKind.Hls,
        };
        try { return await resolverFactory().InspectAsync(probe, ct).ConfigureAwait(false); }
        catch (MediaFormatException ex) { throw new InvalidOperationException(ex.Message); }
        catch (DownloadException ex) { throw new InvalidOperationException(ex.Message); }
    }

    private async Task<HostResponse> AddMediaAsync(BrowserMessage m, CancellationToken ct)
    {
        var format = m.MediaKind switch
        {
            "hls" => MediaFormat.Hls,
            "dash" => MediaFormat.Dash,
            "direct" => MediaFormat.Direct,
            _ => MediaResolver.DetectFormat(m.Url!, m.Mime) ?? MediaFormat.Direct,
        };
        var title = string.IsNullOrWhiteSpace(m.PageTitle) ? null : FileNameSanitizer.Sanitize(m.PageTitle, "video");

        if (format == MediaFormat.Direct)
        {
            var ext = Path.GetExtension(FileNameSanitizer.FromUrl(new Uri(m.Url!)));
            var item = await manager.AddAsync(new AddDownloadRequest
            {
                Url = m.Url!, Referrer = m.Referrer ?? m.PageUrl, Cookies = m.Cookies, UserAgent = m.UserAgent,
                FileName = title is not null && ext.Length is > 1 and <= 5 ? title + ext : null,
            }, ct).ConfigureAwait(false);
            ui.Notify("Video download added", item.FileName.Length > 0 ? item.FileName : UrlValidator.Redact(item.Url));
            return HostResponse.Success(new { id = item.Id });
        }

        MediaInfo info;
        try { info = await InspectAsync(m, ct).ConfigureAwait(false); }
        catch (InvalidOperationException ex)
        {
            ui.Notify("Cannot download this stream", ex.Message);
            return HostResponse.Fail(ex.Message);
        }
        if (info.BlockReason is { } reason)
        {
            ui.Notify("Cannot download this video", reason);
            return HostResponse.Fail(reason);
        }

        var selection = new MediaSelection();
        if (!string.IsNullOrWhiteSpace(m.Selection))
        {
            try { selection = JsonSerializer.Deserialize<MediaSelection>(m.Selection) ?? selection; } catch (JsonException) { }
        }
        var added = await manager.AddAsync(new AddDownloadRequest
        {
            Url = m.Url!, Referrer = m.Referrer ?? m.PageUrl, Cookies = m.Cookies, UserAgent = m.UserAgent,
            Kind = format == MediaFormat.Dash ? DownloadKind.Dash : DownloadKind.Hls,
            MediaSelection = selection.ToJson(),
            FileName = title is null ? null : title + ".mp4",
        }, ct).ConfigureAwait(false);
        var best = info.Variants.OrderByDescending(v => v.Height ?? 0).FirstOrDefault();
        ui.Notify("Video download added", $"{title ?? "Stream"}{(best?.Height is { } h ? $" ({h}p)" : "")}");
        return HostResponse.Success(new { id = added.Id, variants = info.Variants.Count });
    }
}

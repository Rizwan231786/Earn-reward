using MyDownloadManager.Core.Abstractions;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Media;

namespace MyDownloadManager.Application;

/// <summary>Holds the current settings and applies changes to the running services.</summary>
public sealed class SettingsService(ISettingsStore store, AppSettings initial)
{
    private AppSettings _current = initial.Clone();

    public event Action<AppSettings>? Changed;

    public AppSettings Current => _current.Clone();

    public async Task SaveAsync(AppSettings settings, CancellationToken ct = default)
    {
        await store.SaveAsync(settings, ct).ConfigureAwait(false);
        _current = settings.Clone();
        Changed?.Invoke(_current.Clone());
    }

    /// <summary>Wires settings changes to the engine and manager.</summary>
    public void Bind(HttpDownloadEngine http, MediaDownloadEngine media, DownloadManager manager)
    {
        Changed += s =>
        {
            var o = EngineOptions.FromSettings(s);
            http.Reconfigure(o);
            media.Reconfigure(o);
            manager.ApplySettings(s);
        };
    }
}

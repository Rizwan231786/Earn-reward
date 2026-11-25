using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MyDownloadManager.Core.Abstractions;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Integration;
using MyDownloadManager.Media;
using MyDownloadManager.Media.Ffmpeg;
using MyDownloadManager.Persistence;

namespace MyDownloadManager.Application;

/// <summary>Composition root shared by the WPF app and the integration tests.</summary>
public static class AppHost
{
    /// <summary>Registers all non-UI services. Settings are loaded synchronously from SQLite at startup.</summary>
    public static IServiceCollection AddMyDownloadManager(this IServiceCollection services, AppPaths paths, Action<ILoggingBuilder>? logging = null)
    {
        services.AddLogging(b =>
        {
            b.SetMinimumLevel(LogLevel.Information);
            b.AddProvider(new FileLoggerProvider(paths.LogsDirectory));
            logging?.Invoke(b);
        });
        services.AddSingleton(paths);
        services.AddSingleton(_ => new SqliteDatabase(paths.DatabasePath));
        services.AddSingleton(_ => SecretProtectorFactory.Create(paths.DataDirectory));
        services.AddSingleton<IDownloadRepository, SqliteDownloadRepository>();
        services.AddSingleton<ISettingsStore, SqliteSettingsStore>();
        services.AddSingleton<IEventLog, SqliteEventLog>();
        services.AddSingleton(sp => sp.GetRequiredService<ISettingsStore>().LoadAsync().GetAwaiter().GetResult());
        services.AddSingleton(sp => new SettingsService(sp.GetRequiredService<ISettingsStore>(), sp.GetRequiredService<AppSettings>()));
        services.AddSingleton(sp => new HttpDownloadEngine(EngineOptions.FromSettings(sp.GetRequiredService<SettingsService>().Current),
            sp.GetRequiredService<ILogger<HttpDownloadEngine>>()));
        services.AddSingleton(sp =>
        {
            var settings = sp.GetRequiredService<SettingsService>();
            return new MediaDownloadEngine(EngineOptions.FromSettings(settings.Current),
                () => FfmpegLocator.Find(string.IsNullOrWhiteSpace(settings.Current.FfmpegPath) ? null : settings.Current.FfmpegPath),
                sp.GetRequiredService<ILogger<MediaDownloadEngine>>());
        });
        services.AddSingleton(sp =>
        {
            var media = sp.GetRequiredService<MediaDownloadEngine>();
            var manager = new DownloadManager(
                sp.GetRequiredService<HttpDownloadEngine>(),
                sp.GetRequiredService<IDownloadRepository>(),
                sp.GetRequiredService<SettingsService>().Current,
                sp.GetRequiredService<IEventLog>(),
                new Dictionary<DownloadKind, IDownloadEngine> { [DownloadKind.Hls] = media, [DownloadKind.Dash] = media },
                sp.GetRequiredService<ILogger<DownloadManager>>());
            sp.GetRequiredService<SettingsService>().Bind(sp.GetRequiredService<HttpDownloadEngine>(), media, manager);
            return manager;
        });
        services.AddSingleton<Func<MediaResolver>>(sp => () =>
            new MediaResolver(new HttpClient(Engine.Http.HttpClientProvider.CreateHandler(EngineOptions.FromSettings(sp.GetRequiredService<SettingsService>().Current)))
                { Timeout = TimeSpan.FromSeconds(60) }, EngineOptions.FromSettings(sp.GetRequiredService<SettingsService>().Current)));
        services.AddSingleton<BrowserRequestHandler>();
        services.AddSingleton<ClipboardUrlFilter>();
        services.AddSingleton(sp => new IpcServer(sp.GetRequiredService<BrowserRequestHandler>().HandleAsync));
        return services;
    }
}

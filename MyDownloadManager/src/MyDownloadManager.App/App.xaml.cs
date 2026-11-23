using System.IO.Pipes;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MyDownloadManager.App.Services;
using MyDownloadManager.App.ViewModels;
using MyDownloadManager.App.Views;
using MyDownloadManager.Application;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Integration;

namespace MyDownloadManager.App;

public partial class App : System.Windows.Application
{
    private ServiceProvider? _services;
    private Mutex? _singleInstance;
    private ILogger<App>? _log;
    private bool _shuttingDown;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = e.Args;
        var background = args.Contains("--background");
        var smokeIndex = Array.IndexOf(args, "--smoke-test");
        var smokeOut = smokeIndex >= 0 && smokeIndex + 1 < args.Length ? args[smokeIndex + 1] : null;
        var urls = args.Where(UrlValidator.IsValid).ToList();

        var paths = new AppPaths();
        if (args.Contains("--register-browsers") || args.Contains("--unregister-browsers"))
        {
            using var sp = BuildServices(paths);
            var registrar = sp.GetRequiredService<NativeHostRegistrar>();
            if (args.Contains("--register-browsers")) registrar.Register(); else registrar.Unregister();
            Shutdown(0);
            return;
        }

        // Single instance per user: forward the request to the running instance and exit.
        _singleInstance = new Mutex(true, $@"Local\MyDownloadManager.SingleInstance.{Environment.UserName}", out var createdNew);
        if (!createdNew && smokeOut is null)
        {
            try
            {
                var msg = urls.Count > 0 ? new BrowserMessage { Type = MessageTypes.AddUrls, Urls = urls } : new BrowserMessage { Type = MessageTypes.Activate };
                await IpcClient.SendAsync(msg, TimeSpan.FromSeconds(3));
            }
            catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException) { /* other instance is starting up */ }
            Shutdown(0);
            return;
        }

        try
        {
            _services = BuildServices(paths);
            _log = _services.GetRequiredService<ILogger<App>>();
            HookExceptionHandlers();
            _log.LogInformation("MyDownloadManager {Version} starting (data: {Dir})", BrowserRequestHandler.Version, paths.DataDirectory);

            var manager = _services.GetRequiredService<DownloadManager>();
            await manager.InitializeAsync();

            try { _services.GetRequiredService<IpcServer>().Start(); }
            catch (IOException ex) { _log.LogWarning(ex, "Browser integration pipe unavailable"); }

            if (!string.Equals(Environment.GetEnvironmentVariable("MDM_SKIP_REGISTRATION"), "1", StringComparison.Ordinal))
                _ = Task.Run(() => _services.GetRequiredService<NativeHostRegistrar>().Register());

            var window = _services.GetRequiredService<MainWindow>();
            MainWindow = window;
            var tray = _services.GetRequiredService<TrayIconService>();
            WireTray(tray, window, manager);
            tray.Show();
            _services.GetRequiredService<ClipboardMonitor>().Attach(window);
            var vm = _services.GetRequiredService<MainViewModel>();
            vm.DownloadCompleted += d =>
            {
                if (_services.GetRequiredService<SettingsService>().Current.ShowCompletionNotification)
                    tray.Notify("Download complete", d.FileName, () => vm.OpenFileCommand.Execute(null));
            };
            window.Closed += (_, _) => { if (!_shuttingDown) ExitApp(); };

            if (!background || smokeOut is not null) window.Show();
            if (urls.Count > 0) _services.GetRequiredService<IDialogService>().ShowAddDownloads(urls);
            if (smokeOut is not null) await RunSmokeTestAsync(window, smokeOut);
        }
        catch (Exception ex)
        {
            _log?.LogCritical(ex, "Startup failed");
            MessageBox.Show($"MyDownloadManager could not start:\n\n{ex.Message}", "MyDownloadManager", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private static ServiceProvider BuildServices(AppPaths paths)
    {
        var services = new ServiceCollection();
        services.AddMyDownloadManager(paths);
        services.AddSingleton<TrayIconService>();
        services.AddSingleton<IDialogService, DialogService>();
        services.AddSingleton<IUserInteraction, WpfUserInteraction>();
        services.AddSingleton<ClipboardMonitor>();
        services.AddSingleton<NativeHostRegistrar>();
        services.AddSingleton<StartupRegistration>();
        services.AddSingleton<MainViewModel>();
        services.AddTransient<AddDownloadViewModel>();
        services.AddTransient<SettingsViewModel>();
        services.AddSingleton<MainWindow>();
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = false, ValidateScopes = true });
    }

    private void WireTray(TrayIconService tray, MainWindow window, DownloadManager manager)
    {
        var ui = _services!.GetRequiredService<IUserInteraction>();
        tray.OpenRequested += ui.ActivateMainWindow;
        tray.AddRequested += () => _services!.GetRequiredService<IDialogService>().ShowAddDownloads();
        tray.ResumeAllRequested += () => _ = manager.StartAllAsync();
        tray.PauseAllRequested += () => _ = manager.PauseAllAsync();
        tray.ExitRequested += ExitApp;
        var timer = new DispatcherTimer(TimeSpan.FromSeconds(2), DispatcherPriority.Background, (_, _) =>
            tray.SetTooltip($"MyDownloadManager — {manager.ActiveCount} active"), Dispatcher);
        timer.Start();
    }

    private void ExitApp()
    {
        if (_shuttingDown) return;
        _shuttingDown = true;
        if (MainWindow is MainWindow w) { w.AllowClose = true; w.Close(); }
        Shutdown(0);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _shuttingDown = true;
        if (_services is not null)
        {
            try
            {
                // Pauses running transfers with a final checkpoint; they resume automatically on next start.
                Task.Run(async () =>
                {
                    await _services.GetRequiredService<DownloadManager>().DisposeAsync();
                    await _services.GetRequiredService<IpcServer>().DisposeAsync();
                }).Wait(TimeSpan.FromSeconds(10));
            }
            catch (AggregateException ex) { _log?.LogError(ex, "Shutdown error"); }
            _services.GetService<ClipboardMonitor>()?.Dispose();
            _services.GetService<TrayIconService>()?.Dispose();
            _log?.LogInformation("MyDownloadManager stopped");
            _services.Dispose();
        }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }

    private void HookExceptionHandlers()
    {
        DispatcherUnhandledException += (_, args) =>
        {
            _log?.LogError(args.Exception, "Unhandled UI exception");
            MessageBox.Show(args.Exception.Message, "Unexpected error", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            _log?.LogError(args.Exception, "Unobserved task exception");
            args.SetObserved();
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            _log?.LogCritical(args.ExceptionObject as Exception, "Fatal unhandled exception");
    }

    /// <summary>
    /// Automated end-to-end check used by CI on Windows: real window, real database, IPC round-trip, optional real download
    /// (MDM_SMOKE_URL), screenshot. Writes "OK" or the failure to &lt;out&gt;.txt and exits with 0/1.
    /// </summary>
    private async Task RunSmokeTestAsync(Window window, string outPath)
    {
        var report = new List<string>();
        var code = 0;
        try
        {
            await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ContextIdle);
            report.Add($"window: {window.ActualWidth}x{window.ActualHeight}");

            var ping = await IpcClient.SendAsync(new BrowserMessage { Type = MessageTypes.Ping }, TimeSpan.FromSeconds(5));
            if (!ping.Ok) throw new InvalidOperationException("IPC ping failed");
            report.Add($"ipc: ok (version {ping.Version})");

            var manager = _services!.GetRequiredService<DownloadManager>();
            if (Environment.GetEnvironmentVariable("MDM_SMOKE_URL") is { Length: > 0 } url)
            {
                var dir = Path.Combine(Path.GetTempPath(), "mdm-smoke-downloads");
                var item = await manager.AddAsync(new AddDownloadRequest { Url = url, TargetDirectory = dir });
                await manager.WaitForIdleAsync(item.Id, TimeSpan.FromMinutes(5));
                if (item.Status != DownloadStatus.Completed) throw new InvalidOperationException($"download ended as {item.Status}: {item.ErrorMessage}");
                report.Add($"download: {item.FullPath} ({new FileInfo(item.FullPath).Length} bytes)");
                await Task.Delay(1500); // let the grid render the completed row
            }

            var bmp = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(window);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bmp));
            await using (var fs = File.Create(Path.ChangeExtension(outPath, ".png"))) encoder.Save(fs);
            report.Add("screenshot: saved");
            report.Insert(0, "OK");
        }
        catch (Exception ex)
        {
            code = 1;
            report.Insert(0, $"FAILED: {ex}");
        }
        await File.WriteAllLinesAsync(Path.ChangeExtension(outPath, ".txt"), report);
        _shuttingDown = true;
        Shutdown(code);
    }
}

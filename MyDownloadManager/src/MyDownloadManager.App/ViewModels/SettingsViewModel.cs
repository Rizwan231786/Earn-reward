using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MyDownloadManager.App.Services;
using MyDownloadManager.Application;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Core.Utilities;
using MyDownloadManager.Media.Ffmpeg;

namespace MyDownloadManager.App.ViewModels;

public sealed partial class SettingsViewModel : ObservableObject
{
    private readonly SettingsService _service;
    private readonly NativeHostRegistrar _registrar;
    private readonly StartupRegistration _startup;
    private readonly AppSettings _s;

    public SettingsViewModel(SettingsService service, NativeHostRegistrar registrar, StartupRegistration startup)
    {
        _service = service;
        _registrar = registrar;
        _startup = startup;
        _s = service.Current;
        _downloadFolder = _s.DefaultDownloadDirectory;
        _useCategoryFolders = _s.UseCategoryFolders;
        _maxConnections = _s.MaxConnectionsPerDownload;
        _maxConcurrent = _s.MaxConcurrentDownloads;
        _maxRetries = _s.MaxRetries;
        _speedLimit = _s.GlobalSpeedLimit > 0 ? (_s.GlobalSpeedLimit / 1024) + "K" : "";
        _connectTimeout = _s.ConnectTimeoutSeconds;
        _readTimeout = _s.ReadTimeoutSeconds;
        _userAgent = _s.UserAgent;
        _proxyMode = _s.ProxyMode;
        _proxyAddress = _s.ProxyAddress ?? "";
        _proxyUserName = _s.ProxyUserName ?? "";
        ProxyPassword = _s.ProxyPassword ?? "";
        _monitorClipboard = _s.MonitorClipboard;
        _minimizeToTray = _s.MinimizeToTray;
        _startWithWindows = _startup.IsEnabled;
        _showNotifications = _s.ShowCompletionNotification;
        _browserIntegration = _s.BrowserIntegrationEnabled;
        _interceptExtensions = _s.InterceptExtensions;
        _interceptMinMb = _s.InterceptMinimumBytes / 1048576.0;
        _ffmpegPath = _s.FfmpegPath ?? "";
        _useSchedule = _s.ScheduleStart is not null;
        _scheduleStart = (_s.ScheduleStart ?? new TimeOnly(2, 0)).ToString("HH:mm");
        _scheduleStop = (_s.ScheduleStop ?? new TimeOnly(7, 0)).ToString("HH:mm");
        RefreshBrowserStatus();
        DetectFfmpeg();
    }

    public event Action<bool>? CloseRequested;
    public IReadOnlyList<ProxyMode> ProxyModes { get; } = [ProxyMode.System, ProxyMode.None, ProxyMode.Manual];

    /// <summary>Set by the view from the PasswordBox.</summary>
    public string ProxyPassword { get; set; }

    [ObservableProperty] private string _downloadFolder;
    [ObservableProperty] private bool _useCategoryFolders;
    [ObservableProperty] private int _maxConnections;
    [ObservableProperty] private int _maxConcurrent;
    [ObservableProperty] private int _maxRetries;
    [ObservableProperty] private string _speedLimit;
    [ObservableProperty] private int _connectTimeout;
    [ObservableProperty] private int _readTimeout;
    [ObservableProperty] private string _userAgent;
    [ObservableProperty] private ProxyMode _proxyMode;
    [ObservableProperty] private string _proxyAddress;
    [ObservableProperty] private string _proxyUserName;
    [ObservableProperty] private bool _monitorClipboard;
    [ObservableProperty] private bool _minimizeToTray;
    [ObservableProperty] private bool _startWithWindows;
    [ObservableProperty] private bool _showNotifications;
    [ObservableProperty] private bool _browserIntegration;
    [ObservableProperty] private string _interceptExtensions;
    [ObservableProperty] private double _interceptMinMb;
    [ObservableProperty] private string _ffmpegPath;
    [ObservableProperty] private string _ffmpegStatus = "";
    [ObservableProperty] private bool _useSchedule;
    [ObservableProperty] private string _scheduleStart;
    [ObservableProperty] private string _scheduleStop;
    [ObservableProperty] private string _browserStatus = "";
    [ObservableProperty] private string? _error;

    public string ExtensionFolder => Path.Combine(AppContext.BaseDirectory, "extensions");

    [RelayCommand]
    private void DetectFfmpeg()
    {
        var found = FfmpegLocator.Find(string.IsNullOrWhiteSpace(FfmpegPath) ? null : FfmpegPath);
        FfmpegStatus = found is not null
            ? $"Using {found}"
            : string.IsNullOrWhiteSpace(FfmpegPath)
                ? "FFmpeg not found. HLS streams still download (as .ts); DASH and separate audio/video need FFmpeg."
                : "The configured path must be an existing file named ffmpeg.exe.";
    }

    [RelayCommand]
    private void RepairBrowserIntegration()
    {
        var result = _registrar.Register();
        BrowserStatus = result;
    }

    [RelayCommand]
    private void OpenExtensionFolder()
    {
        if (Directory.Exists(ExtensionFolder)) Process.Start(new ProcessStartInfo(ExtensionFolder) { UseShellExecute = true })?.Dispose();
    }

    private void RefreshBrowserStatus() => BrowserStatus = _registrar.Describe();

    [RelayCommand]
    private async Task SaveAsync()
    {
        Error = null;
        if (!PathValidator.IsAcceptableDirectory(DownloadFolder, out var dirErr)) { Error = $"Download folder: {dirErr}"; return; }
        long limit = 0;
        if (!string.IsNullOrWhiteSpace(SpeedLimit) && !Formatting.TryParseSize(SpeedLimit, out limit)) { Error = "Speed limit must look like 500K or 2M (empty = unlimited)."; return; }
        if (ProxyMode == ProxyMode.Manual && !Uri.TryCreate(ProxyAddress.Contains("://") ? ProxyAddress : "http://" + ProxyAddress, UriKind.Absolute, out _))
        { Error = "Proxy address must look like host:port."; return; }
        TimeOnly? start = null, stop = null;
        if (UseSchedule)
        {
            if (!TimeOnly.TryParse(ScheduleStart, out var a) || !TimeOnly.TryParse(ScheduleStop, out var b)) { Error = "Schedule times must look like 02:00."; return; }
            start = a; stop = b;
        }
        if (!string.IsNullOrWhiteSpace(FfmpegPath) && FfmpegLocator.Find(FfmpegPath) is null) { Error = "FFmpeg path must point to an existing ffmpeg.exe."; return; }

        var s = _s.Clone();
        s.DefaultDownloadDirectory = DownloadFolder.Trim();
        s.UseCategoryFolders = UseCategoryFolders;
        s.MaxConnectionsPerDownload = Math.Clamp(MaxConnections, 1, 32);
        s.MaxConcurrentDownloads = Math.Clamp(MaxConcurrent, 1, 20);
        s.MaxRetries = Math.Clamp(MaxRetries, 0, 100);
        s.GlobalSpeedLimit = limit;
        s.ConnectTimeoutSeconds = Math.Clamp(ConnectTimeout, 5, 300);
        s.ReadTimeoutSeconds = Math.Clamp(ReadTimeout, 5, 600);
        s.UserAgent = string.IsNullOrWhiteSpace(UserAgent) ? "MyDownloadManager/1.0" : UserAgent.Trim();
        s.ProxyMode = ProxyMode;
        s.ProxyAddress = string.IsNullOrWhiteSpace(ProxyAddress) ? null : ProxyAddress.Trim();
        s.ProxyUserName = string.IsNullOrWhiteSpace(ProxyUserName) ? null : ProxyUserName.Trim();
        s.ProxyPassword = string.IsNullOrEmpty(ProxyPassword) ? null : ProxyPassword;
        s.MonitorClipboard = MonitorClipboard;
        s.MinimizeToTray = MinimizeToTray;
        s.StartWithWindows = StartWithWindows;
        s.ShowCompletionNotification = ShowNotifications;
        s.BrowserIntegrationEnabled = BrowserIntegration;
        s.InterceptExtensions = InterceptExtensions.Trim();
        s.InterceptMinimumBytes = (long)(Math.Max(0, InterceptMinMb) * 1048576);
        s.FfmpegPath = string.IsNullOrWhiteSpace(FfmpegPath) ? null : FfmpegPath.Trim();
        s.ScheduleStart = start;
        s.ScheduleStop = stop;
        try
        {
            Directory.CreateDirectory(s.DefaultDownloadDirectory);
            _startup.Set(StartWithWindows);
            await _service.SaveAsync(s);
            CloseRequested?.Invoke(true);
        }
        catch (Exception ex) { Error = ex.Message; }
    }

    [RelayCommand] private void Cancel() => CloseRequested?.Invoke(false);
}

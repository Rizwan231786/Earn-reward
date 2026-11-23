using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MyDownloadManager.Application;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Engine.Queue;
using MyDownloadManager.Media;

namespace MyDownloadManager.App.ViewModels;

public enum StartMode { Now, Paused, Scheduled }

public sealed partial class AddDownloadViewModel : ObservableObject
{
    private readonly DownloadManager _manager;
    private readonly SettingsService _settings;
    private readonly Func<MediaResolver> _resolver;

    public AddDownloadViewModel(DownloadManager manager, SettingsService settings, Func<MediaResolver> resolver)
    {
        _manager = manager;
        _settings = settings;
        _resolver = resolver;
        var s = settings.Current;
        _folder = s.DefaultDownloadDirectory;
        _useCategoryFolder = s.UseCategoryFolders;
        _connections = s.MaxConnectionsPerDownload;
    }

    /// <summary>Raised with true when downloads were added (window closes).</summary>
    public event Action<bool>? CloseRequested;

    [ObservableProperty] [NotifyPropertyChangedFor(nameof(UrlCount), nameof(IsSingle), nameof(IsMediaUrl))] private string _urlsText = "";
    [ObservableProperty] private string _fileName = "";
    [ObservableProperty] private string _folder;
    [ObservableProperty] private bool _useCategoryFolder;
    [ObservableProperty] private int _connections;
    [ObservableProperty] private string _checksum = "";
    [ObservableProperty] private string _referrer = "";
    [ObservableProperty] private string _userName = "";
    [ObservableProperty] private string _speedLimit = "";
    [ObservableProperty] private StartMode _startMode = StartMode.Now;
    [ObservableProperty] private DateTime? _scheduleDate;
    [ObservableProperty] private string _scheduleTime = "";
    [ObservableProperty] private string? _error;
    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private string? _mediaMessage;
    [ObservableProperty] private MediaVariant? _selectedVariant;

    /// <summary>Set by the view from the PasswordBox (never bound, never persisted in plaintext).</summary>
    public string Password { get; set; } = "";

    public ObservableCollection<MediaVariant> Variants { get; } = [];
    public IReadOnlyList<StartMode> StartModes { get; } = [StartMode.Now, StartMode.Paused, StartMode.Scheduled];

    private List<string> ParsedUrls() => UrlValidator.ExtractUrls(UrlsText).Select(u => u.AbsoluteUri).ToList();
    public int UrlCount => ParsedUrls().Count;
    public bool IsSingle => UrlCount == 1;
    public bool IsMediaUrl => IsSingle && MediaResolver.DetectFormat(ParsedUrls()[0]) is MediaFormat.Hls or MediaFormat.Dash;

    public void Prefill(IReadOnlyList<string>? urls, string? referrer)
    {
        if (urls is { Count: > 0 }) UrlsText = string.Join(Environment.NewLine, urls);
        if (!string.IsNullOrWhiteSpace(referrer)) Referrer = referrer;
    }

    [RelayCommand]
    private async Task InspectAsync()
    {
        Error = null;
        MediaMessage = "Reading stream manifest…";
        Variants.Clear();
        IsBusy = true;
        try
        {
            var url = ParsedUrls().Single();
            var probe = new DownloadItem
            {
                Url = url, TargetDirectory = Folder, Referrer = string.IsNullOrWhiteSpace(Referrer) ? null : Referrer,
                Kind = MediaResolver.DetectFormat(url) == MediaFormat.Dash ? DownloadKind.Dash : DownloadKind.Hls,
            };
            var info = await Task.Run(() => _resolver().InspectAsync(probe, CancellationToken.None));
            if (info.BlockReason is { } block) { MediaMessage = block; return; }
            foreach (var v in info.Variants.OrderByDescending(v => v.Height ?? 0).ThenByDescending(v => v.Bandwidth)) Variants.Add(v);
            SelectedVariant = Variants.FirstOrDefault();
            MediaMessage = $"{info.Format} stream, {TimeSpan.FromSeconds(info.DurationSeconds ?? 0):hh\\:mm\\:ss}, {Variants.Count} quality level(s)" +
                           (info.AudioRenditions.Count > 0 ? $", {info.AudioRenditions.Count} audio track(s)" : "");
        }
        catch (Exception ex) { MediaMessage = $"Could not read the stream: {ex.Message}"; }
        finally { IsBusy = false; }
    }

    [RelayCommand]
    private async Task AddAsync()
    {
        Error = null;
        var urls = ParsedUrls();
        if (urls.Count == 0) { Error = "Enter at least one http:// or https:// URL."; return; }
        if (!PathValidator.IsAcceptableDirectory(Folder, out var dirErr)) { Error = $"Download folder: {dirErr}"; return; }
        long limit = 0;
        if (!string.IsNullOrWhiteSpace(SpeedLimit) && !Core.Utilities.Formatting.TryParseSize(SpeedLimit, out limit)) { Error = "Speed limit must look like 500K or 2M."; return; }
        if (!string.IsNullOrWhiteSpace(Checksum) && !Engine.ChecksumVerifier.TryParse(Checksum, out _, out _)) { Error = "Checksum must look like sha256:<hex> (md5, sha1, sha256, sha512)."; return; }
        DateTimeOffset? at = null;
        if (StartMode == StartMode.Scheduled && ScheduleDate is { } date)
        {
            if (!TimeOnly.TryParse(string.IsNullOrWhiteSpace(ScheduleTime) ? "00:00" : ScheduleTime, out var time)) { Error = "Time must look like 23:30."; return; }
            at = new DateTimeOffset(date.Date + time.ToTimeSpan(), TimeZoneInfo.Local.GetUtcOffset(date.Date + time.ToTimeSpan()));
        }

        IsBusy = true;
        try
        {
            var requests = urls.Select(u =>
            {
                var format = MediaResolver.DetectFormat(u);
                var kind = format == MediaFormat.Hls ? DownloadKind.Hls : format == MediaFormat.Dash ? DownloadKind.Dash : DownloadKind.File;
                return new AddDownloadRequest
                {
                    Url = u,
                    FileName = IsSingle && !string.IsNullOrWhiteSpace(FileName) ? FileName.Trim() : null,
                    TargetDirectory = UseCategoryFolder ? null : Folder,
                    Referrer = UrlValidator.IsValid(Referrer) ? Referrer : null,
                    UserName = string.IsNullOrWhiteSpace(UserName) ? null : UserName,
                    Password = string.IsNullOrEmpty(Password) ? null : Password,
                    ExpectedChecksum = IsSingle && !string.IsNullOrWhiteSpace(Checksum) ? Checksum.Trim() : null,
                    MaxConnections = Connections,
                    SpeedLimit = limit,
                    Kind = kind,
                    MediaSelection = kind != DownloadKind.File ? new MediaSelection { VideoId = SelectedVariant?.Id }.ToJson() : null,
                    StartImmediately = StartMode == StartMode.Now,
                    UseSchedule = StartMode == StartMode.Scheduled,
                    ScheduledAt = at,
                };
            }).ToList();
            if (UseCategoryFolder && Folder != _settings.Current.DefaultDownloadDirectory)
            {
                // A custom folder was chosen but category sub-folders are on: put the category folder under it.
                requests = requests.Select(r => new AddDownloadRequest
                {
                    Url = r.Url, FileName = r.FileName, Referrer = r.Referrer, UserName = r.UserName, Password = r.Password,
                    ExpectedChecksum = r.ExpectedChecksum, MaxConnections = r.MaxConnections, SpeedLimit = r.SpeedLimit, Kind = r.Kind,
                    MediaSelection = r.MediaSelection, StartImmediately = r.StartImmediately, UseSchedule = r.UseSchedule, ScheduledAt = r.ScheduledAt,
                    TargetDirectory = Path.Combine(Folder, r.Kind != DownloadKind.File ? FileCategories.Video : FileCategories.FromFileName(FileNameSanitizer.FromUrl(new Uri(r.Url)))),
                }).ToList();
            }
            await _manager.AddBatchAsync(requests);
            CloseRequested?.Invoke(true);
        }
        catch (Exception ex) { Error = ex.Message; }
        finally { IsBusy = false; }
    }

    [RelayCommand] private void Close() => CloseRequested?.Invoke(false);
}

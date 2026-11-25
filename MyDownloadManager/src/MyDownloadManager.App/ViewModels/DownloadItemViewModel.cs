using CommunityToolkit.Mvvm.ComponentModel;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Core.Utilities;
using MyDownloadManager.Engine;

namespace MyDownloadManager.App.ViewModels;

/// <summary>One segment drawn in the details pane (fractions of the whole file).</summary>
public sealed record SegmentBar(double Left, double Width, double Done);

/// <summary>Row in the downloads grid. Updated on the UI thread from manager events.</summary>
public sealed partial class DownloadItemViewModel : ObservableObject
{
    public DownloadItemViewModel(DownloadItem item)
    {
        Model = item;
        Refresh();
    }

    public DownloadItem Model { get; }
    public Guid Id => Model.Id;

    [ObservableProperty] private string _fileName = "";
    [ObservableProperty] private string _url = "";
    [ObservableProperty] private DownloadStatus _status;
    [ObservableProperty] private string _statusText = "";
    [ObservableProperty] private string _sizeText = "";
    [ObservableProperty] private double _progress;
    [ObservableProperty] private string _progressText = "";
    [ObservableProperty] private string _speedText = "";
    [ObservableProperty] private string _etaText = "";
    [ObservableProperty] private string _category = "";
    [ObservableProperty] private string _folder = "";
    [ObservableProperty] private string? _error;
    [ObservableProperty] private string _connectionsText = "";
    [ObservableProperty] private string _kindText = "";
    [ObservableProperty] private IReadOnlyList<SegmentBar> _segments = [];
    [ObservableProperty] private double _bytesPerSecond;

    public DateTimeOffset Added => Model.CreatedAt.ToLocalTime();
    public string AddedText => Added.ToString("g");
    public bool IsActive => Status.IsActive();
    public bool CanStart => Status.CanStart();
    public bool CanPause => Status.IsActive() || Status is DownloadStatus.Queued or DownloadStatus.Scheduled;
    public bool IsCompleted => Status == DownloadStatus.Completed;
    public string FullPath => Model.FullPath;

    /// <summary>Refreshes everything from the model (status changes, completion, load).</summary>
    public void Refresh()
    {
        FileName = string.IsNullOrEmpty(Model.FileName) ? FileNameSanitizer.FromUrl(new Uri(Model.Url)) : Model.FileName;
        Url = Model.Url;
        Status = Model.Status;
        Category = Model.Category;
        Folder = Model.TargetDirectory;
        Error = Model.ErrorMessage;
        KindText = Model.Kind switch { DownloadKind.Hls => "HLS stream", DownloadKind.Dash => "DASH stream", _ => "File" };
        UpdateNumbers(Model.DownloadedBytes, Model.TotalBytes);
        if (!Status.IsActive()) { SpeedText = ""; EtaText = ""; BytesPerSecond = 0; ConnectionsText = ""; }
        StatusText = Status switch
        {
            DownloadStatus.Queued => "Queued",
            DownloadStatus.Scheduled => Model.ScheduledAt is { } at ? $"Scheduled {at.ToLocalTime():g}" : "Scheduled",
            DownloadStatus.Connecting => "Connecting…",
            DownloadStatus.Downloading => "Downloading",
            DownloadStatus.Paused => "Paused",
            DownloadStatus.Merging => "Merging…",
            DownloadStatus.Verifying => "Verifying…",
            DownloadStatus.Completed => "Completed",
            DownloadStatus.Failed => "Failed",
            DownloadStatus.Cancelled => "Cancelled",
            _ => Status.ToString(),
        };
        if (Model.Segments.Count > 0 && Model.TotalBytes is > 0 && !Status.IsActive()) Segments = BuildBars(Model.Segments, Model.TotalBytes.Value);
        if (Status == DownloadStatus.Completed) Segments = [new SegmentBar(0, 1, 1)];
        OnPropertyChanged(nameof(IsActive));
        OnPropertyChanged(nameof(CanStart));
        OnPropertyChanged(nameof(CanPause));
        OnPropertyChanged(nameof(IsCompleted));
        OnPropertyChanged(nameof(FullPath));
    }

    public void Apply(DownloadProgress p)
    {
        UpdateNumbers(p.DownloadedBytes, p.TotalBytes);
        BytesPerSecond = p.BytesPerSecond;
        SpeedText = Formatting.Speed(p.BytesPerSecond);
        EtaText = Formatting.Eta(p.Eta);
        ConnectionsText = p.ActiveConnections > 0 ? p.ActiveConnections.ToString() : "";
        if (p.Segments.Count > 0 && p.TotalBytes is > 0) Segments = BuildBars(p.Segments, p.TotalBytes.Value);
    }

    private void UpdateNumbers(long done, long? total)
    {
        SizeText = total is > 0 ? Formatting.Bytes(total) : done > 0 ? Formatting.Bytes(done) : "";
        if (Status == DownloadStatus.Completed) { Progress = 100; ProgressText = "100%"; return; }
        Progress = total is > 0 ? Math.Clamp(100.0 * done / total.Value, 0, 100) : 0;
        ProgressText = total is > 0 ? $"{Progress:0.0}%" : done > 0 ? Formatting.Bytes(done) : "";
    }

    private static List<SegmentBar> BuildBars(IReadOnlyList<DownloadSegment> segments, long total) =>
        segments.Where(s => s.End < long.MaxValue - 1)
            .Select(s => new SegmentBar((double)s.Start / total, (double)s.Length / total, s.Length > 0 ? (double)s.Downloaded / s.Length : 1))
            .ToList();
}

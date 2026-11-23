using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Data;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.Logging;
using MyDownloadManager.App.Services;
using MyDownloadManager.Application;
using MyDownloadManager.Core.Abstractions;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Core.Utilities;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Queue;

namespace MyDownloadManager.App.ViewModels;

public sealed partial class MainViewModel : ObservableObject
{
    private readonly DownloadManager _manager;
    private readonly IEventLog _eventLog;
    private readonly IDialogService _dialogs;
    private readonly SettingsService _settings;
    private readonly ILogger<MainViewModel> _logger;
    private readonly Dispatcher _dispatcher;
    private readonly Dictionary<Guid, DownloadItemViewModel> _byId = [];
    private readonly DispatcherTimer _statsTimer;

    public MainViewModel(DownloadManager manager, IEventLog eventLog, IDialogService dialogs, SettingsService settings, ILogger<MainViewModel> logger)
    {
        _manager = manager;
        _eventLog = eventLog;
        _dialogs = dialogs;
        _settings = settings;
        _logger = logger;
        _dispatcher = System.Windows.Application.Current.Dispatcher;

        Categories = new ObservableCollection<CategoryNode>(CategoryNode.CreateDefault());
        _selectedCategory = Categories[0];
        DownloadsView = CollectionViewSource.GetDefaultView(Downloads);
        DownloadsView.Filter = o => o is DownloadItemViewModel d && SelectedCategory.Matches(d) &&
            (string.IsNullOrWhiteSpace(SearchText) || d.FileName.Contains(SearchText, StringComparison.OrdinalIgnoreCase)
                                                   || d.Url.Contains(SearchText, StringComparison.OrdinalIgnoreCase));
        DownloadsView.SortDescriptions.Add(new SortDescription(nameof(DownloadItemViewModel.Added), ListSortDirection.Descending));

        foreach (var item in manager.Items) Add(item);
        manager.ItemAdded += i => _dispatcher.BeginInvoke(() => { Add(i); UpdateCounts(); });
        manager.ItemRemoved += i => _dispatcher.BeginInvoke(() => Remove(i.Id));
        manager.ItemChanged += i => _dispatcher.BeginInvoke(() => OnItemChanged(i));
        manager.ProgressChanged += p => _dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (_byId.TryGetValue(p.Id, out var vm)) vm.Apply(p);
        });

        _statsTimer = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, (_, _) => UpdateStats(), _dispatcher);
        _statsTimer.Start();
        UpdateCounts();
        UpdateLimitText();
        _settings.Changed += _ => _dispatcher.BeginInvoke(UpdateLimitText);
    }

    public ObservableCollection<DownloadItemViewModel> Downloads { get; } = [];
    public ICollectionView DownloadsView { get; }
    public ObservableCollection<CategoryNode> Categories { get; }
    public ObservableCollection<LogEntry> Logs { get; } = [];
    /// <summary>Selected rows (kept in sync by the view because DataGrid.SelectedItems is not bindable).</summary>
    public List<DownloadItemViewModel> SelectedItems { get; private set; } = [];

    /// <summary>Raised when a download finishes, for tray notifications.</summary>
    public event Action<DownloadItemViewModel>? DownloadCompleted;

    [ObservableProperty] private CategoryNode _selectedCategory;
    [ObservableProperty] private DownloadItemViewModel? _selectedDownload;
    [ObservableProperty] private string _searchText = "";
    [ObservableProperty] private string _totalSpeedText = "";
    [ObservableProperty] private string _activeText = "";
    [ObservableProperty] private string _speedLimitText = "";

    public bool IsLogView => SelectedCategory.Filter == CategoryFilter.Logs;

    partial void OnSelectedCategoryChanged(CategoryNode value)
    {
        OnPropertyChanged(nameof(IsLogView));
        if (value.Filter == CategoryFilter.Logs) _ = RefreshLogsAsync();
        else DownloadsView.Refresh();
    }

    partial void OnSearchTextChanged(string value) => DownloadsView.Refresh();

    public void SetSelection(IEnumerable<DownloadItemViewModel> items)
    {
        SelectedItems = items.ToList();
        NotifyCommands();
    }

    private void Add(DownloadItem item)
    {
        if (_byId.ContainsKey(item.Id)) return;
        var vm = new DownloadItemViewModel(item);
        _byId[item.Id] = vm;
        Downloads.Add(vm);
    }

    private void Remove(Guid id)
    {
        if (!_byId.Remove(id, out var vm)) return;
        Downloads.Remove(vm);
        UpdateCounts();
    }

    private void OnItemChanged(DownloadItem item)
    {
        if (!_byId.TryGetValue(item.Id, out var vm)) { Add(item); vm = _byId[item.Id]; }
        var wasCompleted = vm.Status == DownloadStatus.Completed;
        vm.Refresh();
        if (!wasCompleted && vm.Status == DownloadStatus.Completed) DownloadCompleted?.Invoke(vm);
        UpdateCounts();
        DownloadsView.Refresh();
        NotifyCommands();
    }

    private void UpdateCounts()
    {
        foreach (var c in Categories) c.Count = c.Filter == CategoryFilter.Logs ? 0 : Downloads.Count(c.Matches);
    }

    private void UpdateStats()
    {
        var active = Downloads.Where(d => d.IsActive).ToList();
        var total = active.Sum(d => d.BytesPerSecond);
        TotalSpeedText = total > 0 ? Formatting.Speed(total) : "Idle";
        var queued = Downloads.Count(d => d.Status == DownloadStatus.Queued);
        ActiveText = $"{active.Count} active · {queued} queued · {Downloads.Count} total";
    }

    private void UpdateLimitText()
    {
        var limit = _settings.Current.GlobalSpeedLimit;
        SpeedLimitText = limit > 0 ? $"Limit {Formatting.Speed(limit)}" : "No speed limit";
    }

    private IEnumerable<DownloadItemViewModel> Targets() =>
        SelectedItems.Count > 0 ? SelectedItems : SelectedDownload is null ? [] : [SelectedDownload];

    private void NotifyCommands()
    {
        ResumeCommand.NotifyCanExecuteChanged();
        PauseCommand.NotifyCanExecuteChanged();
        CancelCommand.NotifyCanExecuteChanged();
        DeleteCommand.NotifyCanExecuteChanged();
        OpenFileCommand.NotifyCanExecuteChanged();
        OpenFolderCommand.NotifyCanExecuteChanged();
        RestartCommand.NotifyCanExecuteChanged();
    }

    partial void OnSelectedDownloadChanged(DownloadItemViewModel? value) => NotifyCommands();

    // ------------------------------------------------------------------ commands

    [RelayCommand] private void AddUrl() => _dialogs.ShowAddDownloads();

    [RelayCommand] private void OpenSettings() => _dialogs.ShowSettings();

    private bool AnyCanStart() => Targets().Any(t => t.CanStart);
    private bool AnyCanPause() => Targets().Any(t => t.CanPause);
    private bool AnySelected() => Targets().Any();
    private bool SingleCompleted() => Targets().Count() == 1 && Targets().First().IsCompleted;

    [RelayCommand(CanExecute = nameof(AnyCanStart))]
    private async Task Resume()
    {
        foreach (var t in Targets().Where(t => t.CanStart).ToList()) await Safe(() => _manager.StartAsync(t.Id));
    }

    [RelayCommand(CanExecute = nameof(AnyCanPause))]
    private async Task Pause()
    {
        foreach (var t in Targets().Where(t => t.CanPause).ToList()) await Safe(() => _manager.PauseAsync(t.Id));
    }

    [RelayCommand(CanExecute = nameof(AnyCanPause))]
    private async Task Cancel()
    {
        var targets = Targets().Where(t => t.CanPause || t.Status == DownloadStatus.Paused).ToList();
        if (targets.Count == 0 || !_dialogs.Confirm("Cancel download", $"Cancel {targets.Count} download(s) and discard the partial data?")) return;
        foreach (var t in targets) await Safe(() => _manager.CancelAsync(t.Id));
    }

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private async Task Restart()
    {
        var targets = Targets().ToList();
        if (!_dialogs.Confirm("Restart download", "Discard progress and download again from the beginning?")) return;
        foreach (var t in targets) await Safe(() => _manager.RestartAsync(t.Id));
    }

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private async Task Delete()
    {
        var targets = Targets().ToList();
        if (!_dialogs.Confirm("Remove from list", $"Remove {targets.Count} download(s) from the list? Completed files stay on disk.")) return;
        foreach (var t in targets) await Safe(() => _manager.RemoveAsync(t.Id, deleteFile: false));
    }

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private async Task DeleteWithFile()
    {
        var targets = Targets().ToList();
        if (!_dialogs.Confirm("Delete files", $"Remove {targets.Count} download(s) AND delete the downloaded files from disk?")) return;
        foreach (var t in targets) await Safe(() => _manager.RemoveAsync(t.Id, deleteFile: true));
    }

    [RelayCommand] private Task StartAll() => Safe(_manager.StartAllAsync);
    [RelayCommand] private Task PauseAll() => Safe(_manager.PauseAllAsync);

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private Task MoveUp() => Targets().FirstOrDefault() is { } t ? Safe(() => _manager.MoveAsync(t.Id, -1)) : Task.CompletedTask;

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private Task MoveDown() => Targets().FirstOrDefault() is { } t ? Safe(() => _manager.MoveAsync(t.Id, +1)) : Task.CompletedTask;

    [RelayCommand(CanExecute = nameof(SingleCompleted))]
    private void OpenFile()
    {
        var t = Targets().First();
        if (!File.Exists(t.FullPath)) { _dialogs.Error("File not found", $"'{t.FullPath}' no longer exists."); return; }
        try { Process.Start(new ProcessStartInfo(t.FullPath) { UseShellExecute = true })?.Dispose(); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { _dialogs.Error("Cannot open file", ex.Message); }
    }

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private void OpenFolder()
    {
        var t = Targets().First();
        try
        {
            if (File.Exists(t.FullPath))
            {
                // File names are sanitized (no quotes), so this argument cannot break out of the quoting.
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{t.FullPath}\"") { UseShellExecute = false })?.Dispose();
            }
            else if (Directory.Exists(t.Folder))
            {
                Process.Start(new ProcessStartInfo(t.Folder) { UseShellExecute = true })?.Dispose();
            }
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { _dialogs.Error("Cannot open folder", ex.Message); }
    }

    [RelayCommand(CanExecute = nameof(AnySelected))]
    private void CopyUrl()
    {
        var text = string.Join(Environment.NewLine, Targets().Select(t => t.Url));
        try { Clipboard.SetText(text); } catch (System.Runtime.InteropServices.COMException) { }
    }

    [RelayCommand]
    private async Task SetSpeedLimit(string? value)
    {
        if (!Formatting.TryParseSize(value, out var bps)) return;
        var s = _settings.Current;
        s.GlobalSpeedLimit = bps;
        await Safe(() => _settings.SaveAsync(s));
    }

    [RelayCommand]
    private async Task RefreshLogsAsync()
    {
        try
        {
            var entries = await Task.Run(() => _eventLog.GetRecentAsync(500));
            Logs.Clear();
            foreach (var e in entries) Logs.Add(e);
        }
        catch (Exception ex) { _logger.LogError(ex, "Loading logs failed"); }
    }

    /// <summary>Handles URLs/text dropped onto the window.</summary>
    public void HandleDrop(string? text)
    {
        var urls = UrlValidator.ExtractUrls(text).Select(u => u.AbsoluteUri).ToList();
        if (urls.Count > 0) _dialogs.ShowAddDownloads(urls);
    }

    private async Task Safe(Func<Task> action)
    {
        try { await action(); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Command failed");
            _dialogs.Error("Operation failed", ex.Message);
        }
    }
}

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MyDownloadManager.Core.Abstractions;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;

namespace MyDownloadManager.Engine.Queue;

/// <summary>Why a running download is being stopped.</summary>
internal enum StopReason { None, Pause, Cancel, Remove, Schedule, Shutdown }

/// <summary>
/// Application service that owns all downloads: queueing, concurrency, scheduling, pause/resume/cancel,
/// persistence and crash recovery. Events are raised on thread-pool threads.
/// </summary>
public sealed class DownloadManager : IAsyncDisposable
{
    private sealed class Running
    {
        public required CancellationTokenSource Cts { get; init; }
        public Task Task { get; set; } = Task.CompletedTask;
        public StopReason Reason;
        public bool FromSchedule;
    }

    private readonly IDownloadEngine _httpEngine;
    private readonly IReadOnlyDictionary<DownloadKind, IDownloadEngine> _engines;
    private readonly IDownloadRepository _repo;
    private readonly IEventLog? _eventLog;
    private readonly ILogger _log;
    private readonly object _lock = new();
    private readonly List<DownloadItem> _items = [];
    private readonly Dictionary<Guid, Running> _running = [];
    private readonly Dictionary<Guid, RateLimiter> _itemLimiters = [];
    private readonly SerialTaskQueue _persist = new();
    private readonly RateLimiter _globalLimiter = new();
    private AppSettings _settings;
    private Timer? _timer;
    private bool _disposed;
    private bool _wasInWindow;

    public DownloadManager(IDownloadEngine httpEngine, IDownloadRepository repo, AppSettings settings,
        IEventLog? eventLog = null, IReadOnlyDictionary<DownloadKind, IDownloadEngine>? mediaEngines = null,
        ILogger<DownloadManager>? logger = null)
    {
        _httpEngine = httpEngine;
        _engines = mediaEngines ?? new Dictionary<DownloadKind, IDownloadEngine>();
        _repo = repo;
        _eventLog = eventLog;
        _settings = settings.Clone();
        _globalLimiter.BytesPerSecond = settings.GlobalSpeedLimit;
        _log = (ILogger?)logger ?? NullLogger.Instance;
    }

    public event Action<DownloadItem>? ItemAdded;
    public event Action<DownloadItem>? ItemChanged;
    public event Action<DownloadItem>? ItemRemoved;
    public event Action<DownloadProgress>? ProgressChanged;

    public IReadOnlyList<DownloadItem> Items { get { lock (_lock) return _items.ToList(); } }
    public AppSettings Settings { get { lock (_lock) return _settings.Clone(); } }
    public int ActiveCount { get { lock (_lock) return _running.Count; } }
    public DownloadItem? Find(Guid id) { lock (_lock) return _items.FirstOrDefault(i => i.Id == id); }

    // ------------------------------------------------------------------ lifecycle

    /// <summary>Loads persisted downloads, recovers ones interrupted by a crash/reboot and starts the queue.</summary>
    public async Task InitializeAsync(bool startTimer = true, CancellationToken ct = default)
    {
        var loaded = await _repo.GetAllAsync(ct).ConfigureAwait(false);
        var recovered = new List<DownloadItem>();
        lock (_lock)
        {
            _items.Clear();
            foreach (var item in loaded)
            {
                if (item.Status.IsActive())
                {
                    // The app was closed or the PC restarted mid-download: requeue; the engine resumes from the checkpoint.
                    item.Status = DownloadStatus.Queued;
                    recovered.Add(item);
                }
                _items.Add(item);
            }
        }
        foreach (var r in recovered)
        {
            await PersistAsync(r).ConfigureAwait(false);
            await LogAsync("Info", $"Recovered interrupted download '{r.FileName}' — it will resume automatically.", r.Id).ConfigureAwait(false);
        }
        if (startTimer) _timer = new Timer(_ => Tick(DateTimeOffset.Now), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(15));
        Pump();
    }

    public void ApplySettings(AppSettings settings)
    {
        lock (_lock) _settings = settings.Clone();
        _globalLimiter.BytesPerSecond = settings.GlobalSpeedLimit;
        Pump();
    }

    // ------------------------------------------------------------------ commands

    public async Task<DownloadItem> AddAsync(AddDownloadRequest request, CancellationToken ct = default)
    {
        if (!UrlValidator.TryValidate(request.Url, out var uri, out var err)) throw new ArgumentException(err, nameof(request));
        AppSettings s;
        lock (_lock) s = _settings;

        var fileName = string.IsNullOrWhiteSpace(request.FileName) ? "" : FileNameSanitizer.Sanitize(request.FileName);
        var guessName = fileName.Length > 0 ? fileName : FileNameSanitizer.FromUrl(uri);
        var category = request.Kind != DownloadKind.File ? FileCategories.Video : FileCategories.FromFileName(guessName);
        var dir = request.TargetDirectory;
        if (string.IsNullOrWhiteSpace(dir))
            dir = s.UseCategoryFolders && category != FileCategories.General ? Path.Combine(s.DefaultDownloadDirectory, category) : s.DefaultDownloadDirectory;
        if (!PathValidator.IsAcceptableDirectory(dir, out var dirErr)) throw new ArgumentException(dirErr, nameof(request));

        var item = new DownloadItem
        {
            Url = uri.AbsoluteUri,
            FileName = fileName,
            TargetDirectory = Path.GetFullPath(dir),
            Category = category,
            Kind = request.Kind,
            Referrer = request.Referrer,
            Cookies = request.Cookies,
            UserName = request.UserName,
            Password = request.Password,
            UserAgent = request.UserAgent,
            ExpectedChecksum = request.ExpectedChecksum,
            MediaSelection = request.MediaSelection,
            MaxConnections = Math.Clamp(request.MaxConnections, 0, 32),
            SpeedLimit = Math.Max(0, request.SpeedLimit),
            ScheduledAt = request.ScheduledAt,
            Status = request.UseSchedule || request.ScheduledAt is not null ? DownloadStatus.Scheduled
                   : request.StartImmediately ? DownloadStatus.Queued : DownloadStatus.Paused,
        };
        if (request.Headers is not null)
            foreach (var (k, v) in request.Headers) item.Headers[k] = v;

        lock (_lock)
        {
            item.QueueOrder = _items.Count == 0 ? 0 : _items.Max(i => i.QueueOrder) + 1;
            _items.Add(item);
        }
        await PersistAsync(item).ConfigureAwait(false);
        Raise(ItemAdded, item);
        await LogAsync("Info", $"Added {UrlValidator.Redact(item.Url)}", item.Id).ConfigureAwait(false);
        Pump();
        return item;
    }

    public async Task<IReadOnlyList<DownloadItem>> AddBatchAsync(IEnumerable<AddDownloadRequest> requests, CancellationToken ct = default)
    {
        var added = new List<DownloadItem>();
        foreach (var r in requests) added.Add(await AddAsync(r, ct).ConfigureAwait(false));
        return added;
    }

    /// <summary>Queues a paused/failed/scheduled download (resumes from where it stopped).</summary>
    public Task StartAsync(Guid id)
    {
        var item = Find(id);
        if (item is null) return Task.CompletedTask;
        lock (_lock)
        {
            if (_running.ContainsKey(id) || !item.Status.CanStart()) return Task.CompletedTask;
            item.Status = DownloadStatus.Queued;
            item.ErrorMessage = null;
            item.ScheduledAt = null;
        }
        Raise(ItemChanged, item);
        var t = PersistAsync(item);
        Pump();
        return t;
    }

    public Task PauseAsync(Guid id) => StopAsync(id, StopReason.Pause);

    /// <summary>Stops the download and discards partial data; the entry stays in the list as Cancelled.</summary>
    public Task CancelAsync(Guid id) => StopAsync(id, StopReason.Cancel);

    /// <summary>Removes the entry. Partial data is always deleted; the completed file only when <paramref name="deleteFile"/>.</summary>
    public async Task RemoveAsync(Guid id, bool deleteFile = false)
    {
        await StopAsync(id, StopReason.Remove).ConfigureAwait(false);
        DownloadItem? item;
        lock (_lock)
        {
            item = _items.FirstOrDefault(i => i.Id == id);
            if (item is null) return;
            _items.Remove(item);
            _itemLimiters.Remove(id);
        }
        DeleteTemp(item);
        if (deleteFile && item.Status == DownloadStatus.Completed && !string.IsNullOrEmpty(item.FileName))
        {
            try { File.Delete(PathValidator.SafeCombine(item.TargetDirectory, item.FileName)); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { _log.LogWarning(ex, "Could not delete file"); }
        }
        await _persist.Enqueue(() => _repo.DeleteAsync(id)).ConfigureAwait(false);
        Raise(ItemRemoved, item);
    }

    /// <summary>Discards progress and downloads again from scratch.</summary>
    public async Task RestartAsync(Guid id)
    {
        await StopAsync(id, StopReason.Pause).ConfigureAwait(false);
        var item = Find(id);
        if (item is null) return;
        DeleteTemp(item);
        lock (_lock)
        {
            item.Segments.Clear();
            item.DownloadedBytes = 0;
            item.TempFileName = null;
            item.Status = DownloadStatus.Paused;
        }
        await StartAsync(id).ConfigureAwait(false);
    }

    public async Task StartAllAsync()
    {
        foreach (var i in Items.Where(i => i.Status is DownloadStatus.Paused or DownloadStatus.Failed))
            await StartAsync(i.Id).ConfigureAwait(false);
    }

    public async Task PauseAllAsync()
    {
        foreach (var i in Items.Where(i => i.Status is DownloadStatus.Queued or DownloadStatus.Scheduled || i.Status.IsActive()))
            await PauseAsync(i.Id).ConfigureAwait(false);
    }

    public void SetSpeedLimit(Guid id, long bytesPerSecond)
    {
        var item = Find(id);
        if (item is null) return;
        lock (_lock)
        {
            item.SpeedLimit = Math.Max(0, bytesPerSecond);
            if (_itemLimiters.TryGetValue(id, out var l)) l.BytesPerSecond = item.SpeedLimit;
        }
        _ = PersistAsync(item);
    }

    /// <summary>Moves an item up (negative) or down (positive) in the queue order.</summary>
    public async Task MoveAsync(Guid id, int delta)
    {
        DownloadItem? a, b = null;
        lock (_lock)
        {
            var ordered = _items.OrderBy(i => i.QueueOrder).ToList();
            var idx = ordered.FindIndex(i => i.Id == id);
            if (idx < 0) return;
            var target = Math.Clamp(idx + delta, 0, ordered.Count - 1);
            if (target == idx) return;
            a = ordered[idx]; b = ordered[target];
            (a.QueueOrder, b.QueueOrder) = (b.QueueOrder, a.QueueOrder);
            if (a.QueueOrder == b.QueueOrder) a.QueueOrder += Math.Sign(delta);
        }
        await PersistAsync(a).ConfigureAwait(false);
        await PersistAsync(b).ConfigureAwait(false);
        Raise(ItemChanged, a);
        Raise(ItemChanged, b);
    }

    /// <summary>Waits until the given download stops running (test/diagnostic helper).</summary>
    public async Task WaitForIdleAsync(Guid id, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            Task? t;
            DownloadItem? item;
            lock (_lock) { t = _running.TryGetValue(id, out var r) ? r.Task : null; item = _items.FirstOrDefault(i => i.Id == id); }
            if (t is not null) { await Task.WhenAny(t, Task.Delay(100)).ConfigureAwait(false); continue; }
            if (item is null || item.Status is not (DownloadStatus.Queued)) return;
            await Task.Delay(50).ConfigureAwait(false);
        }
        throw new TimeoutException($"Download {id} did not finish within {timeout}.");
    }

    // ------------------------------------------------------------------ scheduling

    internal static bool IsWithinWindow(TimeOnly start, TimeOnly stop, TimeOnly now) =>
        start <= stop ? now >= start && now < stop : now >= start || now < stop;

    /// <summary>Periodic scheduler tick (public for tests): promotes due scheduled items and enforces the stop time.</summary>
    public void Tick(DateTimeOffset now)
    {
        AppSettings s;
        lock (_lock) s = _settings;
        var hasWindow = s.ScheduleStart is not null && s.ScheduleStop is not null;
        var inWindow = hasWindow && IsWithinWindow(s.ScheduleStart!.Value, s.ScheduleStop!.Value, TimeOnly.FromDateTime(now.LocalDateTime));
        var changed = new List<DownloadItem>();
        var toStop = new List<Guid>();
        lock (_lock)
        {
            foreach (var item in _items.Where(i => i.Status == DownloadStatus.Scheduled))
            {
                var due = item.ScheduledAt is { } at ? at <= now : inWindow;
                if (!due) continue;
                item.Status = DownloadStatus.Queued;
                item.ScheduledAt = null;
                item.ErrorMessage = null;
                changed.Add(item);
                _scheduledStarts.Add(item.Id);
            }
            if (hasWindow && _wasInWindow && !inWindow)
                toStop.AddRange(_running.Where(r => r.Value.FromSchedule).Select(r => r.Key));
            _wasInWindow = inWindow;
        }
        foreach (var c in changed) { Raise(ItemChanged, c); _ = PersistAsync(c); }
        foreach (var id in toStop) _ = StopAsync(id, StopReason.Schedule);
        Pump();
    }

    private readonly HashSet<Guid> _scheduledStarts = [];

    // ------------------------------------------------------------------ execution

    private void Pump()
    {
        var toStart = new List<(DownloadItem Item, Running Run)>();
        lock (_lock)
        {
            if (_disposed) return;
            var slots = Math.Max(1, _settings.MaxConcurrentDownloads) - _running.Count;
            foreach (var item in _items.Where(i => i.Status == DownloadStatus.Queued).OrderBy(i => i.QueueOrder))
            {
                if (slots <= 0) break;
                if (_running.ContainsKey(item.Id)) continue;
                var run = new Running { Cts = new CancellationTokenSource(), FromSchedule = _scheduledStarts.Remove(item.Id) };
                _running[item.Id] = run;
                item.Status = DownloadStatus.Connecting;
                toStart.Add((item, run));
                slots--;
            }
        }
        foreach (var (item, run) in toStart)
        {
            Raise(ItemChanged, item);
            run.Task = Task.Run(() => RunAsync(item, run));
        }
    }

    private async Task RunAsync(DownloadItem item, Running run)
    {
        RateLimiter limiter;
        lock (_lock)
        {
            if (!_itemLimiters.TryGetValue(item.Id, out limiter!)) _itemLimiters[item.Id] = limiter = new RateLimiter(item.SpeedLimit);
            limiter.BytesPerSecond = item.SpeedLimit;
        }
        var engine = _engines.TryGetValue(item.Kind, out var e) ? e : _httpEngine;
        var context = new DownloadContext { Observer = new ManagerObserver(this, item), GlobalLimiter = _globalLimiter, DownloadLimiter = limiter };
        try
        {
            await engine.RunAsync(item, context, run.Cts.Token).ConfigureAwait(false);
            await LogAsync("Info", $"Completed '{item.FileName}'.", item.Id).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (run.Cts.IsCancellationRequested)
        {
            switch (run.Reason)
            {
                case StopReason.Cancel:
                    DeleteTemp(item);
                    item.Segments.Clear(); item.DownloadedBytes = 0; item.TempFileName = null;
                    item.Status = DownloadStatus.Cancelled;
                    break;
                case StopReason.Schedule:
                    item.Status = DownloadStatus.Scheduled;
                    break;
                case StopReason.Shutdown:
                    item.Status = DownloadStatus.Queued; // resume automatically on next start
                    break;
                default:
                    item.Status = DownloadStatus.Paused;
                    break;
            }
        }
        catch (DownloadException ex)
        {
            item.Status = DownloadStatus.Failed;
            item.ErrorMessage = ex.Message;
            await LogAsync("Error", $"'{DisplayName(item)}' failed: {ex.Message}", item.Id).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            item.Status = DownloadStatus.Failed;
            item.ErrorMessage = ex.Message;
            _log.LogError(ex, "Download {Id} failed unexpectedly", item.Id);
            await LogAsync("Error", $"'{DisplayName(item)}' failed: {ex.Message}", item.Id).ConfigureAwait(false);
        }
        finally
        {
            lock (_lock) _running.Remove(item.Id);
            run.Cts.Dispose();
        }
        if (run.Reason != StopReason.Remove) await PersistAsync(item).ConfigureAwait(false);
        Raise(ItemChanged, item);
        Pump();
    }

    private async Task StopAsync(Guid id, StopReason reason)
    {
        Running? run;
        DownloadItem? item;
        lock (_lock)
        {
            item = _items.FirstOrDefault(i => i.Id == id);
            _running.TryGetValue(id, out run);
            if (run is not null) run.Reason = reason;
            else if (item is not null && reason != StopReason.Remove)
            {
                if (item.Status is DownloadStatus.Queued or DownloadStatus.Scheduled && reason is StopReason.Pause or StopReason.Shutdown)
                    item.Status = DownloadStatus.Paused;
                else if (reason == StopReason.Cancel && item.Status != DownloadStatus.Completed)
                {
                    item.Status = DownloadStatus.Cancelled;
                    item.Segments.Clear(); item.DownloadedBytes = 0;
                }
                else return;
            }
        }
        if (run is not null)
        {
            await run.Cts.CancelAsync().ConfigureAwait(false);
            try { await run.Task.ConfigureAwait(false); } catch (OperationCanceledException) { }
        }
        else if (item is not null && reason != StopReason.Remove)
        {
            if (item.Status == DownloadStatus.Cancelled) { DeleteTemp(item); item.TempFileName = null; }
            Raise(ItemChanged, item);
            await PersistAsync(item).ConfigureAwait(false);
        }
    }

    // ------------------------------------------------------------------ helpers

    private Task PersistAsync(DownloadItem item, IReadOnlyList<DownloadSegment>? segments = null)
    {
        segments ??= item.Segments.Select(s => s.Clone()).ToList();
        return _persist.Enqueue(async () =>
        {
            try { await _repo.UpsertAsync(item, segments).ConfigureAwait(false); }
            catch (Exception ex) { _log.LogError(ex, "Persisting download {Id} failed", item.Id); }
        });
    }

    private void DeleteTemp(DownloadItem item)
    {
        if (string.IsNullOrEmpty(item.TempFileName)) return;
        try { File.Delete(PathValidator.SafeCombine(item.TargetDirectory, item.TempFileName)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { _log.LogWarning(ex, "Could not delete temp file"); }
        // Media downloads keep a working folder next to the temp file.
        var work = PathValidator.SafeCombine(item.TargetDirectory, item.TempFileName + ".work");
        try { if (Directory.Exists(work)) Directory.Delete(work, true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { _log.LogWarning(ex, "Could not delete work folder"); }
    }

    private static string DisplayName(DownloadItem i) => string.IsNullOrEmpty(i.FileName) ? UrlValidator.Redact(i.Url) : i.FileName;

    private async Task LogAsync(string level, string message, Guid? id)
    {
        if (_eventLog is null) return;
        try { await _persist.Enqueue(() => _eventLog.AppendAsync(level, message, id)).ConfigureAwait(false); }
        catch (Exception ex) { _log.LogWarning(ex, "Event log write failed"); }
    }

    private void Raise<T>(Action<T>? handler, T arg)
    {
        if (handler is null) return;
        try { handler(arg); } catch (Exception ex) { _log.LogError(ex, "Event handler failed"); }
    }

    private sealed class ManagerObserver(DownloadManager owner, DownloadItem item) : IDownloadObserver
    {
        public void OnStatusChanged(DownloadItem i, DownloadStatus status)
        {
            owner.Raise(owner.ItemChanged, i);
            // Status changes happen while no segment worker is running, so item.Segments is stable here.
            _ = owner.PersistAsync(i);
        }

        public void OnProgress(DownloadProgress progress) => owner.Raise(owner.ProgressChanged, progress);

        public Task OnCheckpointAsync(DownloadItem i, IReadOnlyList<DownloadSegment> segments, long downloadedBytes)
        {
            i.DownloadedBytes = downloadedBytes;
            return owner.PersistAsync(i, segments);
        }

        public void OnLog(LogLevel level, string message)
        {
            if (level >= LogLevel.Warning) _ = owner.LogAsync(level == LogLevel.Warning ? "Warning" : "Error", $"{DisplayName(item)}: {message}", item.Id);
            else _ = owner.LogAsync("Info", $"{DisplayName(item)}: {message}", item.Id);
        }
    }

    /// <summary>Stops all transfers (they resume automatically next launch) and flushes pending writes.</summary>
    public async ValueTask DisposeAsync()
    {
        List<Guid> ids;
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            ids = _running.Keys.ToList();
        }
        if (_timer is not null) await _timer.DisposeAsync().ConfigureAwait(false);
        await Task.WhenAll(ids.Select(id => StopAsync(id, StopReason.Shutdown))).ConfigureAwait(false);
        await _persist.DisposeAsync().ConfigureAwait(false);
    }
}

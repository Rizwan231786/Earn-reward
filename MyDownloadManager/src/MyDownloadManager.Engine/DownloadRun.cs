using System.Buffers;
using System.Diagnostics;
using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Win32.SafeHandles;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Engine.Http;

namespace MyDownloadManager.Engine;

/// <summary>
/// One execution of a download. Design notes:
/// <list type="bullet">
/// <item>All connections write directly at their own offsets into a single pre-allocated temp file, so there is no
/// "concatenate parts" step that could duplicate or drop bytes. Each write is clamped to its segment's end under the
/// segment lock, so segments can never overlap even while they are being split.</item>
/// <item>Checkpoints snapshot the segment table <em>before</em> flushing the file to disk; the persisted progress
/// therefore never claims bytes that are not durably written (safe across crashes and power loss).</item>
/// <item>Resumed range requests carry If-Range; if the remote file changed the server answers 200 and the run
/// restarts cleanly instead of mixing old and new content.</item>
/// <item>The completed temp file is atomically renamed to the final name (same directory ⇒ same volume).</item>
/// </list>
/// </summary>
internal sealed class DownloadRun
{
    public const string TempExtension = HttpDownloadEngine.TempExtension;

    private readonly EngineOptions _options;
    private readonly DownloadItem _item;
    private readonly DownloadContext _ctx;
    private readonly IDownloadObserver _observer;
    private readonly ILogger _log;
    private readonly RequestBuilder _requests;
    private readonly object _planLock = new();
    private readonly HashSet<DownloadSegment> _assigned = [];
    private readonly SpeedMeter _speed = new();

    private Uri _url = null!;
    private string? _validator;
    private bool _rangeMode;
    private bool _unknownLength;
    private SafeFileHandle? _handle;
    private long _downloaded;
    private int _activeConnections;
    private HttpResponseMessage? _pendingResponse; // probe response reused for the first segment
    private string _tempPath = "";

    public DownloadRun(HttpDownloadEngine engine, HttpClient client, EngineOptions options, DownloadItem item, DownloadContext ctx)
    {
        _options = options;
        _item = item;
        _ctx = ctx;
        _observer = ctx.Observer;
        _log = engine.Logger;
        _requests = new RequestBuilder(client, item, options);
    }

    private const long MeaningfulProgress = 256 * 1024;

    private int MaxConnections => Math.Clamp(_item.MaxConnections > 0 ? _item.MaxConnections : _options.MaxConnections, 1, 32);

    public async Task ExecuteAsync(CancellationToken ct)
    {
        if (!PathValidator.IsAcceptableDirectory(_item.TargetDirectory, out var dirErr))
            throw new DownloadException($"Invalid download folder: {dirErr}", false);
        Directory.CreateDirectory(_item.TargetDirectory);

        SetStatus(DownloadStatus.Connecting);
        try
        {
            await ProbeAndPlanAsync(ct).ConfigureAwait(false);
            SetStatus(DownloadStatus.Downloading);
            await TransferAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _pendingResponse?.Dispose();
            _pendingResponse = null;
            _handle?.Dispose();
            _handle = null;
        }
        await FinalizeAsync(ct).ConfigureAwait(false);
    }

    // ---------------------------------------------------------------- probe & plan

    private async Task ProbeAndPlanAsync(CancellationToken ct)
    {
        var (resp, finalUri) = await WithRetryAsync(async () =>
        {
            var r = await _requests.SendAsync(_requests.Origin, 0, null, null, ct).ConfigureAwait(false);
            if (r.Response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable)
            {
                // "bytes=0-" is unsatisfiable for an empty entity; ask again without a Range header.
                r.Response.Dispose();
                r = await _requests.SendAsync(_requests.Origin, null, null, null, ct).ConfigureAwait(false);
            }
            if (r.Response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.PartialContent))
            {
                var ex = DownloadException.FromStatus(r.Response.StatusCode, r.Response.ReasonPhrase);
                r.Response.Dispose();
                throw ex;
            }
            return r;
        }, "probe", ct).ConfigureAwait(false);

        var info = ResponseInfo.From(resp);
        if (info.RangeAccepted && info.RangeStart != 0)
        {
            resp.Dispose();
            throw new DownloadException("Server returned an inconsistent Content-Range for the initial request.", false);
        }

        _url = finalUri;
        var supportsRanges = info.RangeAccepted && info.TotalLength is not null;
        var hadPlan = _item.Segments.Count > 0 && _item.TempFileName is not null;
        var tempExists = hadPlan && File.Exists(PathValidator.SafeCombine(_item.TargetDirectory, _item.TempFileName!));

        if (hadPlan)
        {
            string? reason = null;
            if (!tempExists) reason = "temporary file is missing";
            else if (!supportsRanges) reason = "server does not support resuming (no byte-range support)";
            else if (_item.TotalBytes != info.TotalLength) reason = $"remote size changed ({_item.TotalBytes} → {info.TotalLength})";
            else if (_item.ETag is not null && info.StrongETag is not null && _item.ETag != info.StrongETag) reason = "remote ETag changed";
            else if (_item.ETag is null && _item.LastModified is not null && info.LastModified is not null && _item.LastModified != info.LastModified)
                reason = "remote Last-Modified changed";
            else if (new FileInfo(PathValidator.SafeCombine(_item.TargetDirectory, _item.TempFileName!)).Length != info.TotalLength)
                reason = "temporary file size is inconsistent";

            if (reason is not null)
            {
                Log(LogLevel.Warning, $"Cannot resume: {reason}. Restarting from the beginning.");
                ResetProgress();
                hadPlan = false;
            }
            else
            {
                Log(LogLevel.Information, $"Resuming at {_item.Segments.Sum(s => s.Downloaded)} of {info.TotalLength} bytes.");
            }
        }

        _item.ResolvedUrl = finalUri.AbsoluteUri;
        _item.SupportsRanges = supportsRanges;
        _item.TotalBytes = info.TotalLength;
        _item.ETag = info.StrongETag;
        _item.LastModified = info.LastModified;
        _item.ContentType = info.ContentType;
        _validator = info.Validator;
        _rangeMode = supportsRanges;
        _unknownLength = info.TotalLength is null;

        if (string.IsNullOrWhiteSpace(_item.FileName))
        {
            var name = info.SuggestedFileName ?? FileNameSanitizer.FromUrl(finalUri);
            if (info.SuggestedFileName is null && !Path.HasExtension(name)) name += MimeExtensions.For(info.ContentType);
            _item.FileName = FileNameSanitizer.MakeUnique(name, n =>
                File.Exists(PathValidator.SafeCombine(_item.TargetDirectory, n)) || Directory.Exists(PathValidator.SafeCombine(_item.TargetDirectory, n)));
            if (_item.Category == FileCategories.General) _item.Category = FileCategories.FromFileName(_item.FileName);
        }
        else
        {
            _item.FileName = FileNameSanitizer.Sanitize(_item.FileName);
        }

        _item.TempFileName ??= FileNameSanitizer.Sanitize($"{_item.FileName}.{_item.Id.ToString("N")[..8]}{TempExtension}");
        _tempPath = PathValidator.SafeCombine(_item.TargetDirectory, _item.TempFileName);

        if (!hadPlan)
        {
            PlanSegments();
            _pendingResponse = resp; // fresh start: first segment begins at offset 0, exactly where the probe response starts
        }
        else
        {
            resp.Dispose();
        }

        _handle = File.OpenHandle(_tempPath, hadPlan ? FileMode.Open : FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
        if (!hadPlan && _item.TotalBytes is > 0)
        {
            try { RandomAccess.SetLength(_handle, _item.TotalBytes.Value); }
            catch (IOException ex) { throw new DownloadException($"Not enough disk space to allocate {_item.TotalBytes} bytes: {ex.Message}", false, inner: ex); }
        }
        _downloaded = _item.Segments.Sum(s => s.Downloaded);
        _item.DownloadedBytes = _downloaded;
    }

    private void ResetProgress()
    {
        if (_item.TempFileName is not null)
        {
            try { File.Delete(PathValidator.SafeCombine(_item.TargetDirectory, _item.TempFileName)); }
            catch (IOException) { }
        }
        _item.Segments.Clear();
        _item.DownloadedBytes = 0;
    }

    private void PlanSegments()
    {
        _item.Segments.Clear();
        if (_unknownLength)
        {
            _item.Segments.Add(new DownloadSegment { Index = 0, Start = 0, End = long.MaxValue - 1 });
            return;
        }
        var total = _item.TotalBytes!.Value;
        if (total == 0) return;
        var n = _rangeMode ? (int)Math.Clamp((total + _options.MinSegmentSize - 1) / _options.MinSegmentSize, 1, MaxConnections) : 1;
        var size = total / n;
        for (var i = 0; i < n; i++)
        {
            var start = i * size;
            var end = i == n - 1 ? total - 1 : (i + 1) * size - 1;
            _item.Segments.Add(new DownloadSegment { Index = i, Start = start, End = end });
        }
    }

    // ---------------------------------------------------------------- transfer

    private async Task TransferAsync(CancellationToken ct)
    {
        using var runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var workerCount = _rangeMode ? MaxConnections : 1;
        Exception? failure = null;
        var workers = Enumerable.Range(0, workerCount).Select(async _ =>
        {
            try
            {
                while (!runCts.IsCancellationRequested && TryAcquireSegment() is { } seg)
                {
                    try { await DownloadSegmentAsync(seg, runCts.Token).ConfigureAwait(false); }
                    finally { lock (_planLock) _assigned.Remove(seg); }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !runCts.IsCancellationRequested)
            {
                Interlocked.CompareExchange(ref failure, ex, null);
                await runCts.CancelAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException) { }
        }).ToArray();
        var all = Task.WhenAll(workers);

        var sw = Stopwatch.StartNew();
        var lastCheckpoint = TimeSpan.Zero;
        while (!all.IsCompleted)
        {
            await Task.WhenAny(all, Task.Delay(250, CancellationToken.None)).ConfigureAwait(false);
            PublishProgress();
            if (sw.Elapsed - lastCheckpoint >= _options.CheckpointInterval && !all.IsCompleted)
            {
                lastCheckpoint = sw.Elapsed;
                await CheckpointAsync().ConfigureAwait(false);
            }
        }
        await all.ConfigureAwait(false);
        await CheckpointAsync().ConfigureAwait(false); // durable state on success, pause, cancel and failure alike
        PublishProgress();

        if (failure is not null)
        {
            if (failure is ResourceChangedException)
            {
                // Do not keep bytes from two different versions of the file.
                _handle?.Dispose(); _handle = null;
                ResetProgress();
                await _observer.OnCheckpointAsync(_item, [], 0).ConfigureAwait(false);
            }
            throw failure;
        }
        ct.ThrowIfCancellationRequested();
    }

    private DownloadSegment? TryAcquireSegment()
    {
        lock (_planLock)
        {
            foreach (var s in _item.Segments)
            {
                bool complete;
                lock (s) complete = s.IsComplete;
                if (!complete && _assigned.Add(s)) return s;
            }
            if (!_rangeMode || !_options.DynamicSegmentation) return null;

            // Work stealing: split the largest remaining segment that is being downloaded by another connection.
            DownloadSegment? victim = null;
            long best = 0;
            foreach (var s in _assigned)
            {
                long rem;
                lock (s) rem = s.Remaining;
                if (rem > best) { best = rem; victim = s; }
            }
            if (victim is null || best < 2 * _options.MinSegmentSize) return null;

            DownloadSegment created;
            lock (victim)
            {
                var rem = victim.Remaining;
                if (rem < 2 * _options.MinSegmentSize) return null;
                var mid = victim.NextOffset + rem / 2;
                created = new DownloadSegment { Index = _item.Segments.Max(x => x.Index) + 1, Start = mid, End = victim.End };
                victim.End = mid - 1;
            }
            _item.Segments.Add(created);
            _assigned.Add(created);
            return created;
        }
    }

    private HttpResponseMessage? TakePendingResponse(long offset)
    {
        if (offset != 0) return null;
        return Interlocked.Exchange(ref _pendingResponse, null);
    }

    private async Task DownloadSegmentAsync(DownloadSegment seg, CancellationToken ct)
    {
        var failures = 0;
        var buffer = ArrayPool<byte>.Shared.Rent(_options.BufferSize);
        try
        {
            while (true)
            {
                long offset, end;
                lock (seg)
                {
                    if (!_rangeMode && seg.Downloaded > 0)
                    {
                        // Without range support every (re)connect starts over from byte 0.
                        Interlocked.Add(ref _downloaded, -seg.Downloaded);
                        seg.Downloaded = 0;
                    }
                    if (seg.IsComplete) return;
                    offset = seg.NextOffset;
                    end = seg.End;
                }

                HttpResponseMessage? resp = null;
                var counted = false;
                long receivedThisAttempt = 0;
                try
                {
                    resp = TakePendingResponse(offset);
                    if (resp is null)
                    {
                        (resp, _) = _rangeMode
                            ? await _requests.SendAsync(_url, offset, end, _validator, ct).ConfigureAwait(false)
                            : await _requests.SendAsync(_url, null, null, null, ct).ConfigureAwait(false);
                    }
                    ValidateSegmentResponse(resp, offset);

                    Interlocked.Increment(ref _activeConnections);
                    counted = true;
                    await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                    using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    while (true)
                    {
                        var chunk = Math.Min(_options.BufferSize,
                            Math.Min(_ctx.DownloadLimiter?.SuggestChunk(_options.BufferSize) ?? int.MaxValue,
                                     _ctx.GlobalLimiter?.SuggestChunk(_options.BufferSize) ?? int.MaxValue));
                        readCts.CancelAfter(_options.ReadTimeout);
                        int n;
                        try { n = await stream.ReadAsync(buffer.AsMemory(0, chunk), readCts.Token).ConfigureAwait(false); }
                        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                        {
                            throw new DownloadException($"No data received for {_options.ReadTimeout.TotalSeconds:0} s.", true);
                        }

                        if (n == 0)
                        {
                            lock (seg)
                            {
                                if (_unknownLength) { seg.End = seg.Start + seg.Downloaded - 1; return; }
                                if (seg.IsComplete) return;
                            }
                            throw new DownloadException("Connection closed before the segment was complete.", true);
                        }

                        if (_ctx.DownloadLimiter is { } dl) await dl.WaitAsync(n, ct).ConfigureAwait(false);
                        if (_ctx.GlobalLimiter is { } gl) await gl.WaitAsync(n, ct).ConfigureAwait(false);

                        bool done;
                        lock (seg)
                        {
                            var allowed = _unknownLength ? n : (int)Math.Min(n, seg.End - seg.NextOffset + 1);
                            if (allowed > 0)
                            {
                                WriteAt(buffer.AsSpan(0, allowed), seg.NextOffset);
                                seg.Downloaded += allowed;
                                Interlocked.Add(ref _downloaded, allowed);
                            }
                            done = !_unknownLength && seg.IsComplete;
                        }
                        // Only meaningful progress resets the retry budget, so a server that drops every
                        // connection after a few bytes cannot keep us retrying forever.
                        receivedThisAttempt += n;
                        if (receivedThisAttempt >= MeaningfulProgress) failures = 0;
                        if (done) return;
                    }
                }
                catch (Exception ex) when (!ct.IsCancellationRequested && IsTransient(ex))
                {
                    failures++;
                    if (failures > _options.MaxRetries)
                        throw new DownloadException($"Gave up after {_options.MaxRetries} retries: {ex.Message}", false, inner: ex);
                    var delay = Backoff(failures);
                    Log(LogLevel.Warning, $"Segment {seg.Index}: {ex.Message} Retry {failures}/{_options.MaxRetries} in {delay.TotalSeconds:0.#} s.");
                    await Task.Delay(delay, ct).ConfigureAwait(false);
                }
                finally
                {
                    if (counted) Interlocked.Decrement(ref _activeConnections);
                    resp?.Dispose();
                }
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private void ValidateSegmentResponse(HttpResponseMessage resp, long offset)
    {
        var status = resp.StatusCode;
        if (_rangeMode)
        {
            if (status == HttpStatusCode.PartialContent)
            {
                var cr = resp.Content.Headers.ContentRange;
                if (cr?.From != offset)
                    throw new DownloadException($"Server returned range starting at {cr?.From} instead of {offset}.", true);
                if (cr.Length is { } len && len != _item.TotalBytes)
                    throw new ResourceChangedException($"Remote file size changed ({_item.TotalBytes} → {len}).");
                return;
            }
            if (status == HttpStatusCode.OK)
            {
                if (offset == 0 && ResponseInfo.From(resp).TotalLength == _item.TotalBytes) return; // full body from 0 is fine
                throw new ResourceChangedException("The remote file changed while downloading (If-Range check failed).");
            }
            if (status == HttpStatusCode.RequestedRangeNotSatisfiable)
                throw new ResourceChangedException("The server no longer accepts the byte range (file changed or truncated).");
        }
        else if (status is HttpStatusCode.OK or HttpStatusCode.PartialContent)
        {
            if (status == HttpStatusCode.PartialContent && resp.Content.Headers.ContentRange?.From is not (null or 0))
                throw new DownloadException("Unexpected partial response.", true);
            var total = ResponseInfo.From(resp).TotalLength;
            if (!_unknownLength && total is not null && total != _item.TotalBytes)
                throw new ResourceChangedException($"Remote file size changed ({_item.TotalBytes} → {total}).");
            return;
        }
        throw DownloadException.FromStatus(status, resp.ReasonPhrase);
    }

    private void WriteAt(ReadOnlySpan<byte> data, long offset)
    {
        try { RandomAccess.Write(_handle!, data, offset); }
        catch (IOException ex) { throw new DownloadException($"Disk write failed: {ex.Message}", false, inner: ex); }
        catch (UnauthorizedAccessException ex) { throw new DownloadException($"Disk write denied: {ex.Message}", false, inner: ex); }
    }

    private static bool IsTransient(Exception ex) => ex switch
    {
        DownloadException d => d.IsTransient,
        HttpRequestException => true,
        HttpIOException => true,
        IOException => true,              // network stream errors (disk errors are wrapped as non-transient above)
        TimeoutException => true,
        OperationCanceledException => true, // HttpClient-internal timeouts; user cancellation is filtered by the caller
        _ => false,
    };

    private TimeSpan Backoff(int attempt)
    {
        var ms = _options.RetryBaseDelay.TotalMilliseconds * Math.Pow(2, Math.Min(attempt - 1, 10));
        ms = Math.Min(ms, _options.RetryMaxDelay.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(ms * (0.75 + Random.Shared.NextDouble() * 0.5));
    }

    private async Task<T> WithRetryAsync<T>(Func<Task<T>> action, string what, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { return await action().ConfigureAwait(false); }
            catch (Exception ex) when (!ct.IsCancellationRequested && IsTransient(ex) && attempt <= _options.MaxRetries)
            {
                var delay = Backoff(attempt);
                Log(LogLevel.Warning, $"{what}: {ex.Message} Retry {attempt}/{_options.MaxRetries} in {delay.TotalSeconds:0.#} s.");
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
        }
    }

    // ---------------------------------------------------------------- progress & checkpoints

    private List<DownloadSegment> SnapshotSegments()
    {
        lock (_planLock)
        {
            var list = new List<DownloadSegment>(_item.Segments.Count);
            foreach (var s in _item.Segments) lock (s) list.Add(s.Clone());
            return list;
        }
    }

    private void PublishProgress()
    {
        var done = Interlocked.Read(ref _downloaded);
        _item.DownloadedBytes = done;
        _speed.Sample(done);
        var bps = _speed.BytesPerSecond;
        try
        {
            _observer.OnProgress(new DownloadProgress(_item.Id, done, _item.TotalBytes, bps,
                SpeedMeter.Eta(_item.TotalBytes, done, bps), Volatile.Read(ref _activeConnections), SnapshotSegments()));
        }
        catch (Exception ex) { _log.LogWarning(ex, "Progress observer failed"); }
    }

    private async Task CheckpointAsync()
    {
        if (_handle is null) return;
        var snapshot = SnapshotSegments();                // 1. capture counters
        try { RandomAccess.FlushToDisk(_handle); }        // 2. make at least those bytes durable
        catch (IOException ex) { _log.LogWarning(ex, "Flush failed"); return; }
        var done = snapshot.Sum(s => s.Downloaded);
        try { await _observer.OnCheckpointAsync(_item, snapshot, done).ConfigureAwait(false); } // 3. persist
        catch (Exception ex) { _log.LogWarning(ex, "Checkpoint persistence failed"); }
    }

    // ---------------------------------------------------------------- finalize

    private async Task FinalizeAsync(CancellationToken ct)
    {
        if (_unknownLength)
        {
            _item.TotalBytes = new FileInfo(_tempPath).Length;
        }
        else
        {
            if (_item.Segments.Any(s => !s.IsComplete))
                throw new DownloadException("Internal error: download ended with incomplete segments.", true);
            var len = File.Exists(_tempPath) ? new FileInfo(_tempPath).Length : -1;
            if (_item.TotalBytes == 0 && len < 0) { await File.WriteAllBytesAsync(_tempPath, [], ct).ConfigureAwait(false); len = 0; }
            if (len != _item.TotalBytes)
                throw new DownloadException($"Size check failed: expected {_item.TotalBytes} bytes, file has {len}.", false);
        }
        _item.DownloadedBytes = _item.TotalBytes ?? _item.DownloadedBytes;

        if (!string.IsNullOrWhiteSpace(_item.ExpectedChecksum))
        {
            SetStatus(DownloadStatus.Verifying);
            var err = await ChecksumVerifier.VerifyAsync(_tempPath, _item.ExpectedChecksum!, ct).ConfigureAwait(false);
            if (err is not null)
            {
                ResetProgress();
                await _observer.OnCheckpointAsync(_item, [], 0).ConfigureAwait(false);
                throw new DownloadException($"Integrity check failed — {err} The corrupted file was discarded.", false);
            }
        }

        for (var attempt = 0; ; attempt++)
        {
            var finalName = FileNameSanitizer.MakeUnique(_item.FileName, n => File.Exists(PathValidator.SafeCombine(_item.TargetDirectory, n)));
            var finalPath = PathValidator.SafeCombine(_item.TargetDirectory, finalName);
            try
            {
                File.Move(_tempPath, finalPath, overwrite: false);
                _item.FileName = finalName;
                break;
            }
            catch (IOException) when (attempt < 5 && File.Exists(finalPath)) { /* lost a race for the name; pick another */ }
        }

        _item.Segments.Clear();
        _item.TempFileName = null;
        _item.CompletedAt = DateTimeOffset.UtcNow;
        _item.ErrorMessage = null;
        SetStatus(DownloadStatus.Completed);
        Log(LogLevel.Information, $"Completed: {_item.FileName} ({_item.TotalBytes} bytes).");
    }

    private void SetStatus(DownloadStatus s)
    {
        _item.Status = s;
        try { _observer.OnStatusChanged(_item, s); } catch (Exception ex) { _log.LogWarning(ex, "Status observer failed"); }
    }

    private void Log(LogLevel level, string message)
    {
        _log.Log(level, "[{Id}] {Message}", _item.Id, message);
        try { _observer.OnLog(level, message); } catch { /* observer errors must not break the download */ }
    }
}

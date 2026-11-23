using System.Buffers;
using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Engine;
using MyDownloadManager.Engine.Http;
using MyDownloadManager.Media.Ffmpeg;

namespace MyDownloadManager.Media;

/// <summary>
/// Downloads HLS/DASH streams: segments are fetched in parallel into "&lt;temp&gt;.work/" (each written to .part and renamed
/// when complete, so a resumed download skips finished segments), concatenated per track and remuxed with FFmpeg
/// (stream copy, no re-encoding). DRM-protected and live streams are refused with an explanation.
/// </summary>
public sealed class MediaDownloadEngine : IDownloadEngine, IDisposable
{
    private readonly HttpClient _client;
    private readonly ILogger _log;
    private readonly Func<string?> _ffmpegPathProvider;

    public MediaDownloadEngine(EngineOptions options, Func<string?>? ffmpegPathProvider = null, ILogger<MediaDownloadEngine>? logger = null, HttpMessageHandler? handler = null)
    {
        Options = options;
        _client = HttpClientProvider.Create(options, handler);
        _ffmpegPathProvider = ffmpegPathProvider ?? (() => FfmpegLocator.Find());
        _log = (ILogger?)logger ?? NullLogger.Instance;
    }

    public EngineOptions Options { get; }

    public void Dispose() => _client.Dispose();

    public async Task RunAsync(DownloadItem item, DownloadContext context, CancellationToken ct)
    {
        var observer = context.Observer;
        void Status(DownloadStatus s) { item.Status = s; observer.OnStatusChanged(item, s); }
        void Log(LogLevel l, string m) { _log.Log(l, "[{Id}] {Message}", item.Id, m); observer.OnLog(l, m); }

        if (!UrlValidator.TryValidate(item.Url, out _, out var urlErr)) throw new DownloadException(urlErr!, false);
        if (!PathValidator.IsAcceptableDirectory(item.TargetDirectory, out var dirErr)) throw new DownloadException($"Invalid download folder: {dirErr}", false);
        Directory.CreateDirectory(item.TargetDirectory);

        Status(DownloadStatus.Connecting);
        var selection = MediaSelection.Parse(item.MediaSelection);
        ResolvedMedia resolved;
        try { resolved = await new MediaResolver(_client, Options).ResolveAsync(item, selection, ct).ConfigureAwait(false); }
        catch (MediaFormatException ex) { throw new DownloadException(ex.Message, false); }
        if (resolved.Info.BlockReason is { } block) throw new DownloadException(block, false);
        if (resolved.Tracks.Count == 0 || resolved.Tracks.All(t => t.Segments.Count == 0)) throw new DownloadException("The stream contains no downloadable segments.", false);

        var ffmpeg = _ffmpegPathProvider();
        if (resolved.Tracks.Count > 1 && ffmpeg is null)
            throw new DownloadException("This stream has separate audio and video tracks, which must be merged with FFmpeg. " +
                                        "Install FFmpeg (or set its path in Settings) and resume the download.", false);
        var container = selection.Container is "mkv" ? "mkv" : "mp4";
        var outputExt = ffmpeg is not null ? container : resolved.Tracks[0].Container;

        if (string.IsNullOrWhiteSpace(item.FileName))
        {
            var stem = Path.GetFileNameWithoutExtension(FileNameSanitizer.FromUrl(new Uri(item.Url), "video"));
            if (stem is "master" or "index" or "playlist" or "manifest" or "stream" && new Uri(item.Url).Segments is { Length: > 2 } segs)
                stem = FileNameSanitizer.Sanitize(Uri.UnescapeDataString(segs[^2].Trim('/')), "video");
            item.FileName = stem + "." + outputExt;
        }
        else item.FileName = FileNameSanitizer.Sanitize(Path.ChangeExtension(item.FileName, outputExt));
        item.Category = FileCategories.Video;
        item.TempFileName ??= FileNameSanitizer.Sanitize($"{item.FileName}.{item.Id.ToString("N")[..8]}{HttpDownloadEngine.TempExtension}");
        var workDir = PathValidator.SafeCombine(item.TargetDirectory, item.TempFileName + ".work");
        Directory.CreateDirectory(workDir);

        // Plan: one local file per segment (init segments first).
        var jobs = new List<(string Path, MediaSegment Segment)>();
        for (var t = 0; t < resolved.Tracks.Count; t++)
        {
            var track = resolved.Tracks[t];
            if (track.Init is not null) jobs.Add((Path.Combine(workDir, $"t{t}_init.seg"), track.Init));
            for (var i = 0; i < track.Segments.Count; i++) jobs.Add((Path.Combine(workDir, $"t{t}_{i:D6}.seg"), track.Segments[i]));
        }
        long downloaded = jobs.Where(j => File.Exists(j.Path)).Sum(j => new FileInfo(j.Path).Length);
        var completed = jobs.Count(j => File.Exists(j.Path));
        if (completed > 0) Log(LogLevel.Information, $"Resuming media download: {completed}/{jobs.Count} segments already present.");

        Status(DownloadStatus.Downloading);
        var speed = new SpeedMeter();
        var keys = new ConcurrentDictionary<Uri, Lazy<Task<byte[]>>>();
        var active = 0;
        using var runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var work = Parallel.ForEachAsync(jobs.Where(j => !File.Exists(j.Path)),
            new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(item.MaxConnections > 0 ? item.MaxConnections : Options.MaxConnections, 1, 8), CancellationToken = runCts.Token },
            async (job, token) =>
            {
                Interlocked.Increment(ref active);
                try
                {
                    var bytes = await DownloadSegmentFileAsync(item, job.Segment, job.Path, keys, context, n => Interlocked.Add(ref downloaded, n), Log, token).ConfigureAwait(false);
                    Interlocked.Increment(ref completed);
                    _ = bytes;
                }
                finally { Interlocked.Decrement(ref active); }
            });

        var lastCheckpoint = DateTime.UtcNow;
        while (!work.IsCompleted)
        {
            await Task.WhenAny(work, Task.Delay(300, CancellationToken.None)).ConfigureAwait(false);
            Publish();
            if (DateTime.UtcNow - lastCheckpoint > Options.CheckpointInterval)
            {
                lastCheckpoint = DateTime.UtcNow;
                await observer.OnCheckpointAsync(item, [], Interlocked.Read(ref downloaded)).ConfigureAwait(false);
            }
        }
        try { await work.ConfigureAwait(false); }
        finally
        {
            Publish();
            await observer.OnCheckpointAsync(item, [], Interlocked.Read(ref downloaded)).ConfigureAwait(false);
        }

        // Merge.
        Status(DownloadStatus.Merging);
        var trackFiles = new List<string>();
        for (var t = 0; t < resolved.Tracks.Count; t++)
        {
            var track = resolved.Tracks[t];
            var trackPath = Path.Combine(workDir, $"track{t}.{track.Container}");
            await using (var output = new FileStream(trackPath, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20, useAsync: true))
            {
                foreach (var job in jobs.Where(j => Path.GetFileName(j.Path).StartsWith($"t{t}_", StringComparison.Ordinal)))
                {
                    await using var input = new FileStream(job.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, useAsync: true);
                    await input.CopyToAsync(output, ct).ConfigureAwait(false);
                }
            }
            trackFiles.Add(trackPath);
        }

        string resultPath;
        if (ffmpeg is not null)
        {
            var runner = new FfmpegRunner(ffmpeg);
            resultPath = Path.Combine(workDir, "output." + container);
            var r = await runner.RemuxAsync(workDir, trackFiles, resultPath, container, ct).ConfigureAwait(false);
            if (!r.Success && container == "mp4")
            {
                Log(LogLevel.Warning, "MP4 remux failed; retrying with Matroska (MKV) container.");
                container = "mkv";
                resultPath = Path.Combine(workDir, "output.mkv");
                r = await runner.RemuxAsync(workDir, trackFiles, resultPath, container, ct).ConfigureAwait(false);
                item.FileName = Path.ChangeExtension(item.FileName, "mkv");
            }
            if (!r.Success) throw new DownloadException($"FFmpeg could not merge the stream: {r.StdErr.Trim()}", false);
        }
        else
        {
            resultPath = trackFiles[0];
            Log(LogLevel.Information, "FFmpeg not found: saved the concatenated stream without remuxing.");
        }

        for (var attempt = 0; ; attempt++)
        {
            var finalName = FileNameSanitizer.MakeUnique(item.FileName, n => File.Exists(PathValidator.SafeCombine(item.TargetDirectory, n)));
            var finalPath = PathValidator.SafeCombine(item.TargetDirectory, finalName);
            try { File.Move(resultPath, finalPath, overwrite: false); item.FileName = finalName; break; }
            catch (IOException) when (attempt < 5 && File.Exists(finalPath)) { }
        }
        try { Directory.Delete(workDir, recursive: true); } catch (IOException ex) { _log.LogWarning(ex, "Could not remove work folder"); }

        item.TotalBytes = new FileInfo(item.FullPath).Length;
        item.DownloadedBytes = item.TotalBytes.Value;
        item.TempFileName = null;
        item.Segments.Clear();
        item.CompletedAt = DateTimeOffset.UtcNow;
        item.ErrorMessage = null;
        Status(DownloadStatus.Completed);

        void Publish()
        {
            var done = Interlocked.Read(ref downloaded);
            var c = Volatile.Read(ref completed);
            item.DownloadedBytes = done;
            long? estimate = c > 0 ? (long)((double)done / c * jobs.Count) : null;
            if (c == jobs.Count) estimate = done;
            item.TotalBytes = estimate;
            speed.Sample(done);
            var bps = speed.BytesPerSecond;
            observer.OnProgress(new DownloadProgress(item.Id, done, estimate, bps, SpeedMeter.Eta(estimate, done, bps), Volatile.Read(ref active), []));
        }
    }

    private async Task<long> DownloadSegmentFileAsync(DownloadItem item, MediaSegment seg, string path,
        ConcurrentDictionary<Uri, Lazy<Task<byte[]>>> keys, DownloadContext ctx, Action<long> onBytes, Action<LogLevel, string> log, CancellationToken ct)
    {
        var rb = new RequestBuilder(_client, item, Options);
        var part = path + ".part";
        for (var attempt = 1; ; attempt++)
        {
            long written = 0;
            try
            {
                var (resp, _) = seg.Range is { } r
                    ? await rb.SendAsync(seg.Uri, r.Offset, r.Offset + r.Length - 1, null, ct).ConfigureAwait(false)
                    : await rb.SendAsync(seg.Uri, null, null, null, ct).ConfigureAwait(false);
                using (resp)
                {
                    if (resp.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.PartialContent))
                        throw DownloadException.FromStatus(resp.StatusCode, resp.ReasonPhrase);
                    var skip = seg.Range is { } rr && resp.StatusCode == HttpStatusCode.OK ? rr.Offset : 0; // server ignored Range
                    var limit = seg.Range?.Length ?? long.MaxValue;
                    await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                    await using var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true);
                    var buffer = ArrayPool<byte>.Shared.Rent(Options.BufferSize);
                    try
                    {
                        using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                        while (written < limit)
                        {
                            readCts.CancelAfter(Options.ReadTimeout);
                            int n;
                            try { n = await stream.ReadAsync(buffer.AsMemory(0, Options.BufferSize), readCts.Token).ConfigureAwait(false); }
                            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new DownloadException("Read timed out.", true); }
                            if (n == 0) break;
                            var start = 0;
                            if (skip > 0) { var s = (int)Math.Min(skip, n); skip -= s; start = s; if (start == n) continue; }
                            var take = (int)Math.Min(n - start, limit - written);
                            if (ctx.DownloadLimiter is { } dl) await dl.WaitAsync(take, ct).ConfigureAwait(false);
                            if (ctx.GlobalLimiter is { } gl) await gl.WaitAsync(take, ct).ConfigureAwait(false);
                            await file.WriteAsync(buffer.AsMemory(start, take), ct).ConfigureAwait(false);
                            written += take;
                            onBytes(take);
                        }
                    }
                    finally { ArrayPool<byte>.Shared.Return(buffer); }
                    if (seg.Range is not null && written != seg.Range.Length)
                        throw new DownloadException("Segment byte range was truncated.", true);
                    if (resp.Content.Headers.ContentLength is { } cl && seg.Range is null && written != cl)
                        throw new DownloadException("Segment was truncated.", true);
                }

                if (seg.Key is not null)
                {
                    // Lazy guarantees a single key request even when many segments need the key concurrently.
                    var key = await keys.GetOrAdd(seg.Key.KeyUri, u => new Lazy<Task<byte[]>>(() => FetchKeyAsync(item, u, CancellationToken.None))).Value.ConfigureAwait(false);
                    var cipher = await File.ReadAllBytesAsync(part, ct).ConfigureAwait(false);
                    var iv = seg.Key.IV ?? SequenceIv(seg.Sequence);
                    using var aes = Aes.Create();
                    aes.Key = key;
                    byte[] plain;
                    try { plain = aes.DecryptCbc(cipher, iv, PaddingMode.PKCS7); }
                    catch (CryptographicException ex) { throw new DownloadException($"Could not decrypt AES-128 segment: {ex.Message}", false); }
                    await File.WriteAllBytesAsync(part, plain, ct).ConfigureAwait(false);
                }
                File.Move(part, path, overwrite: true);
                return written;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && attempt <= Options.MaxRetries &&
                                       ex is HttpRequestException or IOException or DownloadException { IsTransient: true } or OperationCanceledException)
            {
                onBytes(-written);
                log(LogLevel.Warning, $"Segment {Path.GetFileName(path)}: {ex.Message} Retry {attempt}/{Options.MaxRetries}.");
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(Options.RetryMaxDelay.TotalMilliseconds, Options.RetryBaseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1))), ct).ConfigureAwait(false);
            }
            catch
            {
                onBytes(-written);
                throw;
            }
        }
    }

    private async Task<byte[]> FetchKeyAsync(DownloadItem item, Uri uri, CancellationToken ct)
    {
        if (!UrlValidator.TryValidate(uri.AbsoluteUri, out _, out var err)) throw new DownloadException($"Invalid key URL: {err}", false);
        var (resp, _) = await new RequestBuilder(_client, item, Options).SendAsync(uri, null, null, null, ct).ConfigureAwait(false);
        using (resp)
        {
            if (resp.StatusCode != HttpStatusCode.OK)
                throw new DownloadException($"The decryption key for this stream is not available to this session (HTTP {(int)resp.StatusCode}). " +
                                            "The site may require being signed in; access controls are not bypassed.", false);
            var key = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
            if (key.Length != 16) throw new DownloadException("Invalid AES-128 key length — the stream may use DRM, which is not supported.", false);
            return key;
        }
    }

    internal static byte[] SequenceIv(long sequence)
    {
        var iv = new byte[16];
        for (var i = 0; i < 8; i++) iv[15 - i] = (byte)(sequence >> (8 * i));
        return iv;
    }
}

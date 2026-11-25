using System.Diagnostics;

namespace MyDownloadManager.Engine;

/// <summary>
/// Async token-bucket bandwidth limiter. A limit of 0 disables throttling. Limits can be changed at runtime.
/// Thread-safe; shared by all connections of a download (per-download limit) or all downloads (global limit).
/// </summary>
public sealed class RateLimiter
{
    private readonly object _gate = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private long _bytesPerSecond;
    private double _tokens;
    private double _lastRefill;

    public RateLimiter(long bytesPerSecond = 0) => _bytesPerSecond = Math.Max(0, bytesPerSecond);

    public long BytesPerSecond
    {
        get => Interlocked.Read(ref _bytesPerSecond);
        set
        {
            lock (_gate) { _bytesPerSecond = Math.Max(0, value); _tokens = Math.Min(_tokens, Burst); }
        }
    }

    private double Burst => Math.Max(_bytesPerSecond / 4.0, 16 * 1024);

    /// <summary>Maximum chunk size callers should request so throttling stays smooth.</summary>
    public int SuggestChunk(int bufferSize)
    {
        var bps = BytesPerSecond;
        return bps <= 0 ? bufferSize : (int)Math.Clamp(bps / 8, 1024, bufferSize);
    }

    /// <summary>Waits until <paramref name="bytes"/> may be consumed.</summary>
    public async ValueTask WaitAsync(int bytes, CancellationToken ct)
    {
        while (true)
        {
            TimeSpan delay;
            lock (_gate)
            {
                if (_bytesPerSecond <= 0) return;
                var now = _clock.Elapsed.TotalSeconds;
                _tokens = Math.Min(Burst, _tokens + (now - _lastRefill) * _bytesPerSecond);
                _lastRefill = now;
                if (_tokens >= bytes || (_tokens >= Burst && bytes > Burst))
                {
                    _tokens -= bytes; // may go negative for oversized requests; repaid by later waits
                    return;
                }
                var deficit = bytes - _tokens;
                delay = TimeSpan.FromSeconds(Math.Min(deficit / _bytesPerSecond, 0.25));
            }
            await Task.Delay(delay < TimeSpan.FromMilliseconds(1) ? TimeSpan.FromMilliseconds(1) : delay, ct).ConfigureAwait(false);
        }
    }
}

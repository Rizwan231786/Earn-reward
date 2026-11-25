using System.Diagnostics;

namespace MyDownloadManager.Engine;

/// <summary>Sliding-window throughput estimator (5 s window) used for speed and ETA display.</summary>
public sealed class SpeedMeter
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Queue<(double t, long bytes)> _samples = new();
    private readonly object _gate = new();
    private readonly double _window;

    public SpeedMeter(double windowSeconds = 5) => _window = windowSeconds;

    /// <summary>Records the current cumulative byte counter.</summary>
    public void Sample(long totalBytes)
    {
        lock (_gate)
        {
            var now = _clock.Elapsed.TotalSeconds;
            _samples.Enqueue((now, totalBytes));
            while (_samples.Count > 2 && now - _samples.Peek().t > _window) _samples.Dequeue();
        }
    }

    public double BytesPerSecond
    {
        get
        {
            lock (_gate)
            {
                if (_samples.Count < 2) return 0;
                var first = _samples.Peek();
                var last = _samples.Last();
                var dt = last.t - first.t;
                return dt <= 0.05 ? 0 : Math.Max(0, (last.bytes - first.bytes) / dt);
            }
        }
    }

    public static TimeSpan? Eta(long? total, long done, double bps)
    {
        if (total is null || bps <= 1) return null;
        var rem = total.Value - done;
        return rem <= 0 ? TimeSpan.Zero : TimeSpan.FromSeconds(rem / bps);
    }
}

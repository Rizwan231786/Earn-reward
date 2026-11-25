using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;

namespace MyDownloadManager.Application;

/// <summary>
/// Structured, rolling daily log files ("app-YYYYMMDD.log", kept 7 days). Each line is
/// "timestamp level [category] message | exception". Writes are serialized and never throw into callers.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _directory;
    private readonly LogLevel _minimum;
    private readonly object _gate = new();
    private readonly ConcurrentDictionary<string, FileLogger> _loggers = new();
    private StreamWriter? _writer;
    private DateOnly _day;

    public FileLoggerProvider(string directory, LogLevel minimum = LogLevel.Information)
    {
        _directory = directory;
        _minimum = minimum;
        Directory.CreateDirectory(directory);
        Cleanup();
    }

    public ILogger CreateLogger(string categoryName) => _loggers.GetOrAdd(categoryName, n => new FileLogger(this, n));

    internal void Write(LogLevel level, string category, string message, Exception? ex)
    {
        if (level < _minimum) return;
        var now = DateTimeOffset.Now;
        var sb = new StringBuilder(256)
            .Append(now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture)).Append(' ')
            .Append(level switch { LogLevel.Trace => "TRC", LogLevel.Debug => "DBG", LogLevel.Information => "INF", LogLevel.Warning => "WRN", LogLevel.Error => "ERR", _ => "CRT" })
            .Append(" [").Append(category).Append("] ").Append(message.Replace('\n', ' ').Replace('\r', ' '));
        if (ex is not null) sb.Append(" | ").Append(ex.GetType().Name).Append(": ").Append(ex.Message.Replace('\n', ' '));
        lock (_gate)
        {
            try
            {
                var today = DateOnly.FromDateTime(now.LocalDateTime);
                if (_writer is null || today != _day)
                {
                    _writer?.Dispose();
                    _day = today;
                    var path = Path.Combine(_directory, $"app-{today:yyyyMMdd}.log");
                    _writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8) { AutoFlush = true };
                }
                _writer.WriteLine(sb.ToString());
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private void Cleanup()
    {
        try
        {
            foreach (var f in Directory.GetFiles(_directory, "app-*.log"))
                if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-7)) File.Delete(f);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public void Dispose()
    {
        lock (_gate) { _writer?.Dispose(); _writer = null; }
    }

    private sealed class FileLogger(FileLoggerProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= owner._minimum;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (IsEnabled(logLevel)) owner.Write(logLevel, category, formatter(state, exception), exception);
        }
    }
}

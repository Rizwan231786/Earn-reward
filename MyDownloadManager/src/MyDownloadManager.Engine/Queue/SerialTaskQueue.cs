using System.Threading.Channels;

namespace MyDownloadManager.Engine.Queue;

/// <summary>Runs async work items strictly one at a time in FIFO order (used to keep DB writes ordered).</summary>
public sealed class SerialTaskQueue : IAsyncDisposable
{
    private readonly Channel<(Func<Task> Work, TaskCompletionSource Done)> _channel =
        Channel.CreateUnbounded<(Func<Task>, TaskCompletionSource)>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Task _consumer;

    public SerialTaskQueue() => _consumer = Task.Run(ConsumeAsync);

    public Task Enqueue(Func<Task> work)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_channel.Writer.TryWrite((work, tcs))) tcs.SetException(new ObjectDisposedException(nameof(SerialTaskQueue)));
        return tcs.Task;
    }

    private async Task ConsumeAsync()
    {
        await foreach (var (work, done) in _channel.Reader.ReadAllAsync().ConfigureAwait(false))
        {
            try { await work().ConfigureAwait(false); done.SetResult(); }
            catch (Exception ex) { done.SetException(ex); }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        await _consumer.ConfigureAwait(false);
    }
}

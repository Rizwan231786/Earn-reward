using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace MyDownloadManager.Integration;

/// <summary>Named-pipe IPC between the native messaging host (or a second app instance) and the running app.</summary>
public static class IpcNames
{
    /// <summary>Per-user pipe name. Override with MDM_PIPE_NAME (used by tests).</summary>
    public static string PipeName
    {
        get
        {
            var overrideName = Environment.GetEnvironmentVariable("MDM_PIPE_NAME");
            if (!string.IsNullOrWhiteSpace(overrideName)) return overrideName;
            var user = new StringBuilder();
            foreach (var c in Environment.UserName) user.Append(char.IsLetterOrDigit(c) ? c : '_');
            return $"MyDownloadManager.Ipc.v1.{user}";
        }
    }
}

/// <summary>
/// Accepts IPC connections. The pipe is created with <see cref="PipeOptions.CurrentUserOnly"/>, so only processes of the
/// same Windows user can connect. Every request is size-limited, parsed and validated before reaching the handler.
/// </summary>
public sealed class IpcServer : IAsyncDisposable
{
    private readonly string _pipeName;
    private readonly Func<BrowserMessage, CancellationToken, Task<HostResponse>> _handler;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    public IpcServer(Func<BrowserMessage, CancellationToken, Task<HostResponse>> handler, string? pipeName = null)
    {
        _handler = handler;
        _pipeName = pipeName ?? IpcNames.PipeName;
    }

    public event Action<Exception>? Error;

    /// <summary>Creates the first pipe instance synchronously so a failure (another instance owns the name) surfaces here.</summary>
    public void Start()
    {
        var first = Create();
        _loop = Task.Run(() => AcceptLoopAsync(first, _cts.Token));
    }

    private NamedPipeServerStream Create() =>
        new(_pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

    private async Task AcceptLoopAsync(NamedPipeServerStream first, CancellationToken ct)
    {
        var next = first;
        while (!ct.IsCancellationRequested)
        {
            var server = next;
            try
            {
                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { await server.DisposeAsync().ConfigureAwait(false); break; }
            catch (IOException ex) { Error?.Invoke(ex); await server.DisposeAsync().ConfigureAwait(false); next = Create(); continue; }
            next = Create();
            _ = Task.Run(() => HandleConnectionAsync(server, ct), CancellationToken.None);
        }
    }

    private async Task HandleConnectionAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        await using (pipe)
        {
            try
            {
                while (!ct.IsCancellationRequested && pipe.IsConnected)
                {
                    using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    idle.CancelAfter(TimeSpan.FromMinutes(2));
                    var json = await NativeMessaging.ReadAsync(pipe, idle.Token).ConfigureAwait(false);
                    if (json is null) break;
                    var response = await ProcessAsync(json, ct).ConfigureAwait(false);
                    await NativeMessaging.WriteAsync(pipe, JsonSerializer.Serialize(response, Json.Options), ct).ConfigureAwait(false);
                }
            }
            catch (Exception ex) when (ex is IOException or InvalidDataException or OperationCanceledException or ObjectDisposedException)
            {
                if (ex is not OperationCanceledException) Error?.Invoke(ex);
            }
        }
    }

    internal async Task<HostResponse> ProcessAsync(string json, CancellationToken ct)
    {
        BrowserMessage? msg;
        try { msg = JsonSerializer.Deserialize<BrowserMessage>(json, Json.Options); }
        catch (JsonException) { return HostResponse.Fail("Malformed JSON."); }
        if (msg is null) return HostResponse.Fail("Empty message.");
        if (!MessageValidator.TryValidate(msg, out var err)) return HostResponse.Fail(err!);
        try { return await _handler(msg, ct).ConfigureAwait(false); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Error?.Invoke(ex);
            return HostResponse.Fail(ex is ArgumentException or InvalidOperationException ? ex.Message : "Internal error in MyDownloadManager.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync().ConfigureAwait(false);
        if (_loop is not null) { try { await _loop.ConfigureAwait(false); } catch (OperationCanceledException) { } }
        _cts.Dispose();
    }
}

public static class IpcClient
{
    /// <summary>Sends one request to the running app. Throws <see cref="TimeoutException"/> when the app is not listening.</summary>
    public static async Task<HostResponse> SendAsync(BrowserMessage message, TimeSpan connectTimeout, CancellationToken ct = default, string? pipeName = null)
    {
        await using var pipe = new NamedPipeClientStream(".", pipeName ?? IpcNames.PipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(connectTimeout, ct).ConfigureAwait(false);
        await NativeMessaging.WriteAsync(pipe, JsonSerializer.Serialize(message, Json.Options), ct).ConfigureAwait(false);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(60));
        var reply = await NativeMessaging.ReadAsync(pipe, timeout.Token).ConfigureAwait(false)
                    ?? throw new IOException("The app closed the connection without replying.");
        return JsonSerializer.Deserialize<HostResponse>(reply, Json.Options) ?? HostResponse.Fail("Empty reply.");
    }
}

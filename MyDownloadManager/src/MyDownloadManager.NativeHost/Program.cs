using System.Diagnostics;
using System.Text.Json;
using MyDownloadManager.Integration;

namespace MyDownloadManager.NativeHost;

/// <summary>
/// Native messaging host launched by Chrome/Edge/Firefox. It reads framed JSON from stdin, forwards each request to the
/// running MyDownloadManager app over a per-user named pipe (starting the app if needed) and writes the reply to stdout.
/// Nothing except protocol frames is ever written to stdout; diagnostics go to a log file.
/// </summary>
public static class Program
{
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MyDownloadManager", "logs", "nativehost.log");

    public static async Task<int> Main(string[] args)
    {
        // Chrome passes the caller origin ("chrome-extension://<id>/"), Firefox passes the manifest path + extension id.
        var browser = args.Any(a => a.StartsWith("chrome-extension://", StringComparison.Ordinal)) ? "chromium" : args.Length >= 2 ? "firefox" : "unknown";
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        try
        {
            while (true)
            {
                string? json;
                try { json = await NativeMessaging.ReadAsync(stdin).ConfigureAwait(false); }
                catch (InvalidDataException ex)
                {
                    Log($"Bad frame: {ex.Message}");
                    await Reply(stdout, HostResponse.Fail(ex.Message)).ConfigureAwait(false);
                    return 1; // the stream is no longer in sync; let the browser reconnect
                }
                if (json is null) return 0;

                BrowserMessage? msg;
                try { msg = JsonSerializer.Deserialize<BrowserMessage>(json, Json.Options); }
                catch (JsonException) { await Reply(stdout, HostResponse.Fail("Malformed JSON.")).ConfigureAwait(false); continue; }
                if (msg is null) { await Reply(stdout, HostResponse.Fail("Empty message.")).ConfigureAwait(false); continue; }
                msg.Browser ??= browser;

                await Reply(stdout, await ForwardAsync(msg).ConfigureAwait(false)).ConfigureAwait(false);
            }
        }
        catch (IOException ex)
        {
            Log($"I/O error: {ex.Message}");
            return 2;
        }
    }

    private static async Task<HostResponse> ForwardAsync(BrowserMessage msg)
    {
        try
        {
            return await IpcClient.SendAsync(msg, TimeSpan.FromMilliseconds(800)).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            if (msg.Type == MessageTypes.Ping)
                return new HostResponse { Ok = true, AppRunning = false, Version = Version };
        }

        // The app is not running: start it in the background, then retry for up to 20 s.
        if (!TryLaunchApp(out var launchError)) return HostResponse.Fail(launchError!);
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            try { return await IpcClient.SendAsync(msg, TimeSpan.FromSeconds(2)).ConfigureAwait(false); }
            catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
            {
                await Task.Delay(300).ConfigureAwait(false);
            }
        }
        return HostResponse.Fail("MyDownloadManager did not start in time. Open the app and try again.");
    }

    private static bool TryLaunchApp(out string? error)
    {
        error = null;
        var exe = Environment.GetEnvironmentVariable("MDM_APP_PATH");
        if (string.IsNullOrWhiteSpace(exe)) exe = Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "MyDownloadManager.exe" : "MyDownloadManager");
        if (!File.Exists(exe)) { error = "MyDownloadManager is not running and could not be found next to the native host."; return false; }
        try
        {
            // Fixed executable path and a constant argument: no user-controlled data reaches the command line.
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! };
            psi.ArgumentList.Add("--background");
            Process.Start(psi)?.Dispose();
            return true;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            error = $"Could not start MyDownloadManager: {ex.Message}";
            Log(error);
            return false;
        }
    }

    private static string Version => typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    private static Task Reply(Stream stdout, HostResponse r) =>
        NativeMessaging.WriteAsync(stdout, JsonSerializer.Serialize(r, Json.Options));

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 1024 * 1024) File.Delete(LogPath);
            File.AppendAllText(LogPath, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

using System.Diagnostics;
using System.Text;

namespace MyDownloadManager.Media.Ffmpeg;

/// <summary>Finds an FFmpeg executable: configured path → bundled copy next to the app → PATH.</summary>
public static class FfmpegLocator
{
    public static string? Find(string? configuredPath = null)
    {
        var exe = OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";
        if (!string.IsNullOrWhiteSpace(configuredPath))
        {
            // Only accept an absolute path to a file literally named ffmpeg(.exe) — never an arbitrary program.
            if (Path.IsPathFullyQualified(configuredPath) && File.Exists(configuredPath) &&
                string.Equals(Path.GetFileName(configuredPath), exe, StringComparison.OrdinalIgnoreCase))
                return configuredPath;
            return null;
        }
        var bundled = Path.Combine(AppContext.BaseDirectory, "ffmpeg", exe);
        if (File.Exists(bundled)) return bundled;
        bundled = Path.Combine(AppContext.BaseDirectory, exe);
        if (File.Exists(bundled)) return bundled;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                if (!Path.IsPathFullyQualified(dir)) continue; // ignore relative PATH entries (DLL/exe planting)
                var p = Path.Combine(dir, exe);
                if (File.Exists(p)) return p;
            }
            catch (ArgumentException) { }
        }
        return null;
    }
}

public sealed record FfmpegResult(int ExitCode, string StdErr)
{
    public bool Success => ExitCode == 0;
}

/// <summary>
/// Safe FFmpeg invocation: no shell, arguments passed as a list (no quoting/injection issues), stdin closed,
/// network protocols disabled, inputs/outputs restricted to a working directory, bounded stderr capture,
/// cancellation kills the process tree.
/// </summary>
public sealed class FfmpegRunner(string ffmpegPath)
{
    private const int MaxStdErr = 64 * 1024;

    public string FfmpegPath { get; } = ffmpegPath;

    /// <summary>Remuxes (no re-encoding) one or two local inputs into <paramref name="output"/>.</summary>
    public Task<FfmpegResult> RemuxAsync(string workDir, IReadOnlyList<string> inputs, string output, string container, CancellationToken ct)
    {
        if (inputs.Count is < 1 or > 2) throw new ArgumentException("Expected one or two inputs.", nameof(inputs));
        var root = Path.GetFullPath(workDir);
        foreach (var p in inputs.Append(output))
        {
            var full = Path.GetFullPath(p);
            var parent = Path.GetDirectoryName(full)!;
            var outputParent = Path.GetDirectoryName(Path.GetFullPath(output))!;
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(parent, outputParent, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("FFmpeg paths must stay inside the download folder.");
        }

        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "file" };
        foreach (var input in inputs) { args.Add("-i"); args.Add(Path.GetFullPath(input)); }
        if (inputs.Count == 2) { args.AddRange(["-map", "0:v:0?", "-map", "0:a:0?", "-map", "1:a:0?", "-map", "1:v:0?"]); }
        else { args.AddRange(["-map", "0:v?", "-map", "0:a?"]); }
        args.AddRange(["-c", "copy"]);
        if (container == "mp4") args.AddRange(["-movflags", "+faststart", "-f", "mp4"]);
        else if (container == "mkv") args.AddRange(["-f", "matroska"]);
        else throw new ArgumentException("Unsupported container.", nameof(container));
        args.Add(Path.GetFullPath(output));
        return RunAsync(args, ct);
    }

    public async Task<FfmpegResult> RunAsync(IEnumerable<string> arguments, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(FfmpegPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            RedirectStandardInput = true,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in arguments) psi.ArgumentList.Add(a);

        using var process = new Process { StartInfo = psi };
        var stderr = new StringBuilder();
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            lock (stderr) if (stderr.Length < MaxStdErr) stderr.AppendLine(e.Data);
        };
        process.OutputDataReceived += (_, _) => { };
        if (!process.Start()) throw new InvalidOperationException("Could not start FFmpeg.");
        process.StandardInput.Close();
        process.BeginErrorReadLine();
        process.BeginOutputReadLine();
        try
        {
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            throw;
        }
        process.WaitForExit(); // flush async stderr readers
        lock (stderr) return new FfmpegResult(process.ExitCode, stderr.ToString());
    }
}

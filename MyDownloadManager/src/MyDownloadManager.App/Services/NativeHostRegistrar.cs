using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using MyDownloadManager.Application;
using MyDownloadManager.Integration;

namespace MyDownloadManager.App.Services;

/// <summary>
/// Registers the native messaging host for Chrome, Edge, Chromium, Brave and Firefox under HKCU (no admin rights needed).
/// Re-run on every start so the registration heals itself after the app is moved or updated.
/// </summary>
public sealed class NativeHostRegistrar(AppPaths paths, ILogger<NativeHostRegistrar> logger)
{
    public static string HostExePath => Path.Combine(AppContext.BaseDirectory, "MyDownloadManager.NativeHost.exe");
    private string ChromiumManifest => Path.Combine(paths.NativeMessagingDirectory, $"{NativeHostManifest.HostName}.chromium.json");
    private string FirefoxManifest => Path.Combine(paths.NativeMessagingDirectory, $"{NativeHostManifest.HostName}.firefox.json");

    public string Register()
    {
        if (!File.Exists(HostExePath))
            return $"Native host not found at {HostExePath}. Reinstall MyDownloadManager.";
        try
        {
            Directory.CreateDirectory(paths.NativeMessagingDirectory);
            File.WriteAllText(ChromiumManifest, NativeHostManifest.BuildChromium(HostExePath), new UTF8Encoding(false));
            File.WriteAllText(FirefoxManifest, NativeHostManifest.BuildFirefox(HostExePath), new UTF8Encoding(false));
            foreach (var (_, key, firefox) in NativeHostManifest.RegistryLocations)
            {
                using var k = Registry.CurrentUser.CreateSubKey(key, writable: true);
                k.SetValue("", firefox ? FirefoxManifest : ChromiumManifest, RegistryValueKind.String);
            }
            logger.LogInformation("Browser integration registered");
            return "Registered for Chrome, Edge, Chromium, Brave and Firefox. Restart your browser if it was open.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            logger.LogError(ex, "Browser integration registration failed");
            return $"Registration failed: {ex.Message}";
        }
    }

    public void Unregister()
    {
        foreach (var (_, key, _) in NativeHostManifest.RegistryLocations)
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(key, throwOnMissingSubKey: false); }
            catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException) { logger.LogWarning(ex, "Could not remove {Key}", key); }
        }
        try { File.Delete(ChromiumManifest); File.Delete(FirefoxManifest); } catch (IOException) { }
    }

    public string Describe()
    {
        var lines = new List<string>();
        foreach (var (browser, key, _) in NativeHostManifest.RegistryLocations)
        {
            using var k = Registry.CurrentUser.OpenSubKey(key);
            var target = k?.GetValue("") as string;
            lines.Add($"{browser}: {(target is not null && File.Exists(target) ? "registered" : "not registered")}");
        }
        return string.Join(Environment.NewLine, lines);
    }
}

/// <summary>"Start with Windows" via the per-user Run key.</summary>
public sealed class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "MyDownloadManager";

    public bool IsEnabled
    {
        get
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey);
            return k?.GetValue(ValueName) is string;
        }
    }

    public void Set(bool enabled)
    {
        using var k = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (enabled) k.SetValue(ValueName, $"\"{Environment.ProcessPath}\" --background", RegistryValueKind.String);
        else if (k.GetValue(ValueName) is not null) k.DeleteValue(ValueName);
    }
}

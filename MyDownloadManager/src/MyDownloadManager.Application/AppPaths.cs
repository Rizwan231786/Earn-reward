namespace MyDownloadManager.Application;

/// <summary>Per-user data locations. Override the root with MDM_DATA_DIR (tests, portable mode).</summary>
public sealed class AppPaths
{
    public AppPaths(string? root = null)
    {
        DataDirectory = root
            ?? Environment.GetEnvironmentVariable("MDM_DATA_DIR")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MyDownloadManager");
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(LogsDirectory);
    }

    public string DataDirectory { get; }
    public string DatabasePath => Path.Combine(DataDirectory, "mydownloadmanager.db");
    public string LogsDirectory => Path.Combine(DataDirectory, "logs");
    public string NativeMessagingDirectory => Path.Combine(DataDirectory, "NativeMessaging");
}

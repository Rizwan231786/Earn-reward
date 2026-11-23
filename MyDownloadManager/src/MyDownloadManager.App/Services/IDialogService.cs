namespace MyDownloadManager.App.Services;

/// <summary>Opens windows and message boxes so view models stay free of UI types.</summary>
public interface IDialogService
{
    void ShowAddDownloads(IReadOnlyList<string>? urls = null, string? referrer = null);
    void ShowSettings();
    bool Confirm(string title, string message);
    void Error(string title, string message);
    void Info(string title, string message);
}

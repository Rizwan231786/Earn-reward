using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using MyDownloadManager.Application;

namespace MyDownloadManager.App.Services;

/// <summary>
/// Opt-in clipboard monitoring (Settings → General). Uses the Windows clipboard format listener, so nothing is polled.
/// When a copied URL looks like a download, the user gets a notification; nothing is downloaded without confirmation.
/// </summary>
public sealed partial class ClipboardMonitor(ClipboardUrlFilter filter, SettingsService settings, TrayIconService tray, IDialogService dialogs) : IDisposable
{
    private const int WmClipboardUpdate = 0x031D;
    private HwndSource? _source;

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AddClipboardFormatListener(IntPtr hwnd);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool RemoveClipboardFormatListener(IntPtr hwnd);

    public void Attach(Window window)
    {
        var handle = new WindowInteropHelper(window).EnsureHandle();
        _source = HwndSource.FromHwnd(handle);
        _source?.AddHook(WndProc);
        AddClipboardFormatListener(handle);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmClipboardUpdate && settings.Current.MonitorClipboard) OnClipboardChanged();
        return IntPtr.Zero;
    }

    private void OnClipboardChanged()
    {
        string? text = null;
        for (var attempt = 0; attempt < 3 && text is null; attempt++)
        {
            try { if (Clipboard.ContainsText()) text = Clipboard.GetText(); else return; }
            catch (COMException) { Thread.Sleep(30); } // clipboard busy in another process
        }
        var urls = filter.Filter(text, settings.Current);
        if (urls.Count == 0) return;
        var label = urls.Count == 1 ? urls[0] : $"{urls.Count} download links";
        tray.Notify("Download link copied", $"{label}\nClick to download with MyDownloadManager.", () => dialogs.ShowAddDownloads(urls));
    }

    public void Dispose()
    {
        if (_source is null) return;
        RemoveClipboardFormatListener(_source.Handle);
        _source.RemoveHook(WndProc);
        _source = null;
    }
}

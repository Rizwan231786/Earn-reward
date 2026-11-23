using System.Windows;
using Forms = System.Windows.Forms;

namespace MyDownloadManager.App.Services;

/// <summary>Notification-area icon with a context menu and balloon notifications.</summary>
public sealed class TrayIconService : IDisposable
{
    private readonly Forms.NotifyIcon _icon;
    private Action? _balloonClick;

    public TrayIconService()
    {
        using var stream = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/Assets/MyDownloadManager.ico"))!.Stream;
        _icon = new Forms.NotifyIcon
        {
            Icon = new System.Drawing.Icon(stream, new System.Drawing.Size(16, 16)),
            Text = "MyDownloadManager",
            Visible = false,
        };
        _icon.DoubleClick += (_, _) => OpenRequested?.Invoke();
        _icon.BalloonTipClicked += (_, _) => { var a = _balloonClick; _balloonClick = null; a?.Invoke(); };
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open MyDownloadManager", null, (_, _) => OpenRequested?.Invoke());
        menu.Items.Add("Add URL…", null, (_, _) => AddRequested?.Invoke());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Resume all", null, (_, _) => ResumeAllRequested?.Invoke());
        menu.Items.Add("Pause all", null, (_, _) => PauseAllRequested?.Invoke());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitRequested?.Invoke());
        _icon.ContextMenuStrip = menu;
    }

    public event Action? OpenRequested;
    public event Action? AddRequested;
    public event Action? ResumeAllRequested;
    public event Action? PauseAllRequested;
    public event Action? ExitRequested;

    public void Show() => _icon.Visible = true;

    public void SetTooltip(string text) => _icon.Text = text.Length > 63 ? text[..63] : text;

    /// <summary>Shows a balloon/toast. <paramref name="onClick"/> runs on the UI thread when the user clicks it.</summary>
    public void Notify(string title, string message, Action? onClick = null)
    {
        _balloonClick = onClick is null ? null : () => System.Windows.Application.Current?.Dispatcher.BeginInvoke(onClick);
        _icon.ShowBalloonTip(5000, title, message.Length > 250 ? message[..250] + "…" : message, Forms.ToolTipIcon.Info);
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}

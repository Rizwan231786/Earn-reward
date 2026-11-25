using System.Windows;
using Microsoft.Extensions.DependencyInjection;
using MyDownloadManager.App.ViewModels;
using MyDownloadManager.App.Views;
using MyDownloadManager.Application;

namespace MyDownloadManager.App.Services;

public sealed class DialogService(IServiceProvider services) : IDialogService
{
    private Window? Owner => System.Windows.Application.Current.MainWindow is { IsVisible: true } w ? w : null;

    public void ShowAddDownloads(IReadOnlyList<string>? urls = null, string? referrer = null)
    {
        var vm = services.GetRequiredService<AddDownloadViewModel>();
        vm.Prefill(urls, referrer);
        var window = new AddDownloadWindow(vm) { Owner = Owner };
        if (window.Owner is null) window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        window.Show();
        window.Activate();
    }

    public void ShowSettings()
    {
        var window = new SettingsWindow(services.GetRequiredService<SettingsViewModel>()) { Owner = Owner };
        if (window.Owner is null) window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        window.ShowDialog();
    }

    public bool Confirm(string title, string message) =>
        Show(message, title, MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes;

    public void Error(string title, string message) => Show(message, title, MessageBoxButton.OK, MessageBoxImage.Error);
    public void Info(string title, string message) => Show(message, title, MessageBoxButton.OK, MessageBoxImage.Information);

    private MessageBoxResult Show(string message, string title, MessageBoxButton buttons, MessageBoxImage image) =>
        Owner is { } owner ? MessageBox.Show(owner, message, title, buttons, image) : MessageBox.Show(message, title, buttons, image);
}

/// <summary>Bridges non-UI services (browser handler) to the WPF shell, always on the UI thread.</summary>
public sealed class WpfUserInteraction(IServiceProvider services, TrayIconService tray, SettingsService settings) : IUserInteraction
{
    private static void OnUi(Action a) => System.Windows.Application.Current?.Dispatcher.BeginInvoke(a);

    public void ShowAddDialog(IReadOnlyList<string> urls, string? referrer = null) =>
        OnUi(() => services.GetRequiredService<IDialogService>().ShowAddDownloads(urls, referrer));

    public void Notify(string title, string message)
    {
        if (settings.Current.ShowCompletionNotification) OnUi(() => tray.Notify(title, message, ActivateMainWindow));
    }

    public void ActivateMainWindow() => OnUi(() =>
    {
        var w = System.Windows.Application.Current.MainWindow;
        if (w is null) return;
        w.Show();
        if (w.WindowState == WindowState.Minimized) w.WindowState = WindowState.Normal;
        w.Activate();
        w.Topmost = true;
        w.Topmost = false;
    });
}

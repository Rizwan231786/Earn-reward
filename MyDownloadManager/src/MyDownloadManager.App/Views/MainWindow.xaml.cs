using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using MyDownloadManager.App.ViewModels;
using MyDownloadManager.Application;

namespace MyDownloadManager.App.Views;

public partial class MainWindow : Window
{
    private readonly MainViewModel _vm;
    private readonly SettingsService _settings;

    /// <summary>Set by the app when the user chose Exit, so closing really closes.</summary>
    public bool AllowClose { get; set; }

    public MainWindow(MainViewModel vm, SettingsService settings)
    {
        InitializeComponent();
        _vm = vm;
        _settings = settings;
        DataContext = vm;
        Drop += OnDrop;
        DragOver += OnDragOver;
        vm.Downloads.CollectionChanged += (_, _) => UpdateEmptyState();
        vm.DownloadsView.CollectionChanged += (_, _) => UpdateEmptyState();
        UpdateEmptyState();
    }

    private void UpdateEmptyState() => EmptyState.Visibility = _vm.DownloadsView.IsEmpty ? Visibility.Visible : Visibility.Collapsed;

    private void Grid_SelectionChanged(object sender, SelectionChangedEventArgs e) =>
        _vm.SetSelection(Grid.SelectedItems.OfType<DownloadItemViewModel>());

    private void Grid_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (_vm.SelectedDownload is { IsCompleted: true }) _vm.OpenFileCommand.Execute(null);
        else if (_vm.SelectedDownload is { CanStart: true }) _vm.ResumeCommand.Execute(null);
    }

    private void SpeedButton_Click(object sender, RoutedEventArgs e)
    {
        SpeedButton.ContextMenu.PlacementTarget = SpeedButton;
        SpeedButton.ContextMenu.DataContext = _vm;
        SpeedButton.ContextMenu.IsOpen = true;
    }

    private static readonly string[] DropFormats = ["UniformResourceLocatorW", "UniformResourceLocator", DataFormats.UnicodeText, DataFormats.Text];

    private void OnDragOver(object sender, DragEventArgs e)
    {
        e.Effects = DropFormats.Any(e.Data.GetDataPresent) ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    private void OnDrop(object sender, DragEventArgs e)
    {
        foreach (var format in DropFormats)
        {
            if (!e.Data.GetDataPresent(format)) continue;
            var data = e.Data.GetData(format);
            var text = data switch
            {
                string s => s,
                MemoryStream ms when format == "UniformResourceLocatorW" => System.Text.Encoding.Unicode.GetString(ms.ToArray()).TrimEnd('\0'),
                MemoryStream ms => System.Text.Encoding.Default.GetString(ms.ToArray()).TrimEnd('\0'),
                _ => null,
            };
            if (!string.IsNullOrWhiteSpace(text)) { _vm.HandleDrop(text); break; }
        }
        e.Handled = true;
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!AllowClose && _settings.Current.MinimizeToTray)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnClosing(e);
    }
}

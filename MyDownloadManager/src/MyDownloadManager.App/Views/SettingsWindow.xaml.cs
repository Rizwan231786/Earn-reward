using System.Windows;
using Microsoft.Win32;
using MyDownloadManager.App.ViewModels;

namespace MyDownloadManager.App.Views;

public partial class SettingsWindow : Window
{
    private readonly SettingsViewModel _vm;

    public SettingsWindow(SettingsViewModel vm)
    {
        InitializeComponent();
        _vm = vm;
        DataContext = vm;
        ProxyPasswordBox.Password = vm.ProxyPassword;
        vm.CloseRequested += ok => { DialogResult = ok; };
    }

    private void ProxyPasswordBox_PasswordChanged(object sender, RoutedEventArgs e) => _vm.ProxyPassword = ProxyPasswordBox.Password;

    private void Browse_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFolderDialog { Title = "Default download folder", InitialDirectory = Directory.Exists(_vm.DownloadFolder) ? _vm.DownloadFolder : null };
        if (dlg.ShowDialog(this) == true) _vm.DownloadFolder = dlg.FolderName;
    }
}

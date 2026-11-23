using System.Windows;
using Microsoft.Win32;
using MyDownloadManager.App.ViewModels;

namespace MyDownloadManager.App.Views;

public partial class AddDownloadWindow : Window
{
    private readonly AddDownloadViewModel _vm;

    public AddDownloadWindow(AddDownloadViewModel vm)
    {
        InitializeComponent();
        _vm = vm;
        DataContext = vm;
        vm.CloseRequested += _ => Close();
    }

    private void PasswordBox_PasswordChanged(object sender, RoutedEventArgs e) => _vm.Password = PasswordBox.Password;

    private void Browse_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFolderDialog { Title = "Choose download folder", InitialDirectory = Directory.Exists(_vm.Folder) ? _vm.Folder : null };
        if (dlg.ShowDialog(this) == true) _vm.Folder = dlg.FolderName;
    }
}

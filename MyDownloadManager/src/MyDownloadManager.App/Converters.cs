using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.App;

public sealed class StatusBrushConverter : IValueConverter
{
    private static readonly Brush Ok = Frozen("#1A7F37"), Busy = Frozen("#1F6FEB"), Warn = Frozen("#9A6700"), Err = Frozen("#CF222E"), Muted = Frozen("#656D76");
    private static Brush Frozen(string hex) { var b = (Brush)new BrushConverter().ConvertFromString(hex)!; b.Freeze(); return b; }

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value is DownloadStatus s
        ? s switch
        {
            DownloadStatus.Completed => Ok,
            DownloadStatus.Downloading or DownloadStatus.Connecting or DownloadStatus.Merging or DownloadStatus.Verifying => Busy,
            DownloadStatus.Paused or DownloadStatus.Scheduled => Warn,
            DownloadStatus.Failed => Err,
            _ => Muted,
        }
        : Muted;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class BoolToVisibilityConverter : IValueConverter
{
    public bool Invert { get; set; }
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) =>
        (value is true) ^ Invert ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class NullToVisibilityConverter : IValueConverter
{
    public bool Invert { get; set; }
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture) =>
        (value is not null && value is not "") ^ Invert ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>Multiplies a fraction (0..1) by the available width; used to draw segment bars.</summary>
public sealed class FractionToWidthConverter : IMultiValueConverter
{
    public object Convert(object[] values, Type targetType, object parameter, CultureInfo culture) =>
        values.Length == 2 && values[0] is double f && values[1] is double w && !double.IsNaN(w) ? Math.Max(0, f * w) : 0.0;
    public object[] ConvertBack(object value, Type[] targetTypes, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class EnumEqualsConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => Equals(value?.ToString(), parameter?.ToString());
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        value is true && parameter is string s ? Enum.Parse(targetType, s) : Binding.DoNothing;
}

using CommunityToolkit.Mvvm.ComponentModel;
using MyDownloadManager.Core.Models;

namespace MyDownloadManager.App.ViewModels;

public enum CategoryFilter { All, Unfinished, Finished, Failed, FileCategory, Logs }

/// <summary>Entry in the left sidebar.</summary>
public sealed partial class CategoryNode(string title, string glyph, CategoryFilter filter, string? category = null) : ObservableObject
{
    public string Title { get; } = title;
    public string Glyph { get; } = glyph;
    public CategoryFilter Filter { get; } = filter;
    public string? FileCategory { get; } = category;

    [ObservableProperty] private int _count;

    public bool Matches(DownloadItemViewModel d) => Filter switch
    {
        CategoryFilter.All => true,
        CategoryFilter.Unfinished => d.Status is not (DownloadStatus.Completed or DownloadStatus.Cancelled),
        CategoryFilter.Finished => d.Status == DownloadStatus.Completed,
        CategoryFilter.Failed => d.Status is DownloadStatus.Failed or DownloadStatus.Cancelled,
        CategoryFilter.FileCategory => d.Category == FileCategory,
        _ => false,
    };

    public static IReadOnlyList<CategoryNode> CreateDefault() =>
    [
        new("All downloads", "", CategoryFilter.All),
        new("Unfinished", "", CategoryFilter.Unfinished),
        new("Finished", "", CategoryFilter.Finished),
        new("Failed / cancelled", "", CategoryFilter.Failed),
        new(FileCategories.Video, "", CategoryFilter.FileCategory, FileCategories.Video),
        new(FileCategories.Music, "", CategoryFilter.FileCategory, FileCategories.Music),
        new(FileCategories.Documents, "", CategoryFilter.FileCategory, FileCategories.Documents),
        new(FileCategories.Compressed, "", CategoryFilter.FileCategory, FileCategories.Compressed),
        new(FileCategories.Programs, "", CategoryFilter.FileCategory, FileCategories.Programs),
        new(FileCategories.Images, "", CategoryFilter.FileCategory, FileCategories.Images),
        new(FileCategories.General, "", CategoryFilter.FileCategory, FileCategories.General),
        new("Logs", "", CategoryFilter.Logs),
    ];
}

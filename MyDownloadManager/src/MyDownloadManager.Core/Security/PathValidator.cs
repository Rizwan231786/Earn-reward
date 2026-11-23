namespace MyDownloadManager.Core.Security;

/// <summary>Guards every file-system write so output always stays inside the intended directory.</summary>
public static class PathValidator
{
    /// <summary>
    /// Combines <paramref name="directory"/> and an (already sanitized) <paramref name="fileName"/> and verifies
    /// the result is a direct child of <paramref name="directory"/>. Throws on traversal attempts.
    /// </summary>
    public static string SafeCombine(string directory, string fileName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        var dir = Path.GetFullPath(directory);
        var full = Path.GetFullPath(Path.Combine(dir, fileName));
        var parent = Path.GetDirectoryName(full);
        if (parent is null || !string.Equals(Path.TrimEndingDirectorySeparator(parent), Path.TrimEndingDirectorySeparator(dir),
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new UnauthorizedAccessException($"Refusing to write outside the target directory: '{fileName}'.");
        return full;
    }

    /// <summary>Validates a user-chosen download directory: must be absolute, rooted and not a device path.</summary>
    public static bool IsAcceptableDirectory(string? directory, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(directory)) { error = "Directory is empty."; return false; }
        if (directory.StartsWith(@"\\?\", StringComparison.Ordinal) || directory.StartsWith(@"\\.\", StringComparison.Ordinal))
        { error = "Device paths are not allowed."; return false; }
        if (!Path.IsPathFullyQualified(directory)) { error = "Directory must be an absolute path."; return false; }
        if (directory.IndexOfAny(Path.GetInvalidPathChars()) >= 0) { error = "Directory contains invalid characters."; return false; }
        return true;
    }
}

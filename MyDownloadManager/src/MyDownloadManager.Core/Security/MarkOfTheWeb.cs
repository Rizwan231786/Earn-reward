using System.Text;

namespace MyDownloadManager.Core.Security;

/// <summary>
/// Tags completed downloads with the NTFS "Zone.Identifier" stream (Mark-of-the-Web) exactly like browsers do, so that
/// Windows SmartScreen, Office Protected View and attachment policies still apply to files fetched by this app.
/// </summary>
public static class MarkOfTheWeb
{
    public const int InternetZone = 3;

    public static string BuildStream(string? url, string? referrer)
    {
        var sb = new StringBuilder("[ZoneTransfer]\r\n").Append("ZoneId=").Append(InternetZone).Append("\r\n");
        // Query strings are dropped: they frequently carry access tokens.
        if (UrlValidator.IsValid(referrer)) sb.Append("ReferrerUrl=").Append(Strip(referrer!)).Append("\r\n");
        if (UrlValidator.IsValid(url)) sb.Append("HostUrl=").Append(Strip(url!)).Append("\r\n");
        return sb.ToString();
    }

    /// <summary>Writes the zone stream on Windows/NTFS. Returns false where unsupported (non-Windows, FAT32, network shares).</summary>
    public static bool TryApply(string filePath, string? url, string? referrer)
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            File.WriteAllText(filePath + ":Zone.Identifier", BuildStream(url, referrer), Encoding.ASCII);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return false;
        }
    }

    private static string Strip(string url)
    {
        var u = new Uri(url);
        return new UriBuilder(u) { UserName = "", Password = "", Query = "", Fragment = "" }.Uri.AbsoluteUri;
    }
}

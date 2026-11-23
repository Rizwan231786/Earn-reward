using System.Text.Json;
using System.Text.Json.Nodes;

namespace MyDownloadManager.Integration;

/// <summary>Builds the native messaging host manifests that tell browsers where the host executable is.</summary>
public static class NativeHostManifest
{
    public const string HostName = "com.mydownloadmanager.host";
    /// <summary>ID of the bundled Chrome/Edge extension (derived from the public key in its manifest).</summary>
    public const string ChromiumExtensionId = "jepeaacjobbkicoofllleimejjcjebge";
    public const string FirefoxExtensionId = "mydownloadmanager@mydownloadmanager.app";

    /// <summary>Registry keys (under HKCU) that point browsers at the manifest files.</summary>
    public static readonly IReadOnlyList<(string Browser, string RegistryKey, bool Firefox)> RegistryLocations =
    [
        ("Google Chrome", $@"Software\Google\Chrome\NativeMessagingHosts\{HostName}", false),
        ("Microsoft Edge", $@"Software\Microsoft\Edge\NativeMessagingHosts\{HostName}", false),
        ("Chromium", $@"Software\Chromium\NativeMessagingHosts\{HostName}", false),
        ("Brave", $@"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{HostName}", false),
        ("Mozilla Firefox", $@"Software\Mozilla\NativeMessagingHosts\{HostName}", true),
    ];

    public static string BuildChromium(string hostExePath, IEnumerable<string>? extraExtensionIds = null)
    {
        var origins = new JsonArray();
        foreach (var id in new[] { ChromiumExtensionId }.Concat(extraExtensionIds ?? []).Distinct(StringComparer.Ordinal))
        {
            if (!IsChromiumId(id)) throw new ArgumentException($"Invalid Chromium extension id '{id}'.", nameof(extraExtensionIds));
            origins.Add($"chrome-extension://{id}/");
        }
        return Build(hostExePath, "allowed_origins", origins);
    }

    public static string BuildFirefox(string hostExePath, IEnumerable<string>? extraExtensionIds = null)
    {
        var ids = new JsonArray();
        foreach (var id in new[] { FirefoxExtensionId }.Concat(extraExtensionIds ?? []).Distinct(StringComparer.Ordinal)) ids.Add(id);
        return Build(hostExePath, "allowed_extensions", ids);
    }

    private static string Build(string hostExePath, string allowKey, JsonArray allowed)
    {
        if (!Path.IsPathFullyQualified(hostExePath)) throw new ArgumentException("Host path must be absolute.", nameof(hostExePath));
        var node = new JsonObject
        {
            ["name"] = HostName,
            ["description"] = "MyDownloadManager browser integration",
            ["path"] = hostExePath,
            ["type"] = "stdio",
            [allowKey] = allowed,
        };
        return node.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    /// <summary>Chromium IDs are 32 characters in the range a–p.</summary>
    public static bool IsChromiumId(string id) => id.Length == 32 && id.All(c => c is >= 'a' and <= 'p');
}

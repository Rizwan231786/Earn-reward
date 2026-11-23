using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using MyDownloadManager.Core.Abstractions;

namespace MyDownloadManager.Persistence;

/// <summary>Windows DPAPI (CurrentUser scope): secrets can only be decrypted by the same Windows account.</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiSecretProtector : ISecretProtector
{
    private const string Prefix = "dpapi:";
    private static readonly byte[] Entropy = "MyDownloadManager.v1"u8.ToArray();

    public string Protect(string plaintext) =>
        Prefix + Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(plaintext), Entropy, DataProtectionScope.CurrentUser));

    public string Unprotect(string protectedText)
    {
        if (!protectedText.StartsWith(Prefix, StringComparison.Ordinal)) throw new CryptographicException("Unknown secret format.");
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(protectedText[Prefix.Length..]), Entropy, DataProtectionScope.CurrentUser));
    }
}

/// <summary>
/// AES-256-GCM with a random per-user key file (mode 0600). Used on non-Windows hosts (tests/CI) where DPAPI is unavailable.
/// </summary>
public sealed class AesGcmSecretProtector : ISecretProtector
{
    private const string Prefix = "aesgcm:";
    private readonly byte[] _key;

    public AesGcmSecretProtector(string keyFile)
    {
        if (File.Exists(keyFile)) _key = File.ReadAllBytes(keyFile);
        else
        {
            _key = RandomNumberGenerator.GetBytes(32);
            Directory.CreateDirectory(Path.GetDirectoryName(keyFile)!);
            File.WriteAllBytes(keyFile, _key);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(keyFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        if (_key.Length != 32) throw new CryptographicException("Invalid key file.");
    }

    public string Protect(string plaintext)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var pt = Encoding.UTF8.GetBytes(plaintext);
        var ct = new byte[pt.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, pt, ct, tag);
        return Prefix + Convert.ToBase64String([.. nonce, .. tag, .. ct]);
    }

    public string Unprotect(string protectedText)
    {
        if (!protectedText.StartsWith(Prefix, StringComparison.Ordinal)) throw new CryptographicException("Unknown secret format.");
        var raw = Convert.FromBase64String(protectedText[Prefix.Length..]);
        var pt = new byte[raw.Length - 28];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(raw.AsSpan(0, 12), raw.AsSpan(28), raw.AsSpan(12, 16), pt);
        return Encoding.UTF8.GetString(pt);
    }
}

public static class SecretProtectorFactory
{
    public static ISecretProtector Create(string dataDirectory) =>
        OperatingSystem.IsWindows() ? new DpapiSecretProtector() : new AesGcmSecretProtector(Path.Combine(dataDirectory, "secret.key"));
}

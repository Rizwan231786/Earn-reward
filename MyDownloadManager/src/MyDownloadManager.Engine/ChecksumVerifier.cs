using System.Security.Cryptography;

namespace MyDownloadManager.Engine;

/// <summary>Verifies files against "algo:hex" checksums (sha256, sha1, md5, sha512) or a bare hex digest.</summary>
public static class ChecksumVerifier
{
    public static bool TryParse(string? spec, out HashAlgorithmName algorithm, out string hex)
    {
        algorithm = default; hex = "";
        if (string.IsNullOrWhiteSpace(spec)) return false;
        var s = spec.Trim();
        var colon = s.IndexOf(':');
        string algo;
        if (colon > 0) { algo = s[..colon].Trim().ToLowerInvariant().Replace("-", ""); hex = s[(colon + 1)..].Trim(); }
        else
        {
            hex = s;
            algo = s.Length switch { 32 => "md5", 40 => "sha1", 64 => "sha256", 128 => "sha512", _ => "" };
        }
        algorithm = algo switch
        {
            "md5" => HashAlgorithmName.MD5,
            "sha1" => HashAlgorithmName.SHA1,
            "sha256" => HashAlgorithmName.SHA256,
            "sha512" => HashAlgorithmName.SHA512,
            _ => default,
        };
        hex = hex.ToLowerInvariant();
        return algorithm != default && hex.Length > 0 && hex.All(Uri.IsHexDigit);
    }

    public static async Task<string> ComputeAsync(string path, HashAlgorithmName algorithm, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(algorithm);
        await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, useAsync: true);
        var buf = new byte[1 << 20];
        int n;
        while ((n = await fs.ReadAsync(buf, ct).ConfigureAwait(false)) > 0) hash.AppendData(buf, 0, n);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    /// <summary>Returns null when the file matches, or an error message.</summary>
    public static async Task<string?> VerifyAsync(string path, string spec, CancellationToken ct)
    {
        if (!TryParse(spec, out var algo, out var expected)) return $"Unrecognized checksum format '{spec}'.";
        var actual = await ComputeAsync(path, algo, ct).ConfigureAwait(false);
        return actual == expected ? null : $"{algo.Name} mismatch: expected {expected}, got {actual}.";
    }
}

using MyDownloadManager.Core.Models;
using MyDownloadManager.Core.Security;
using MyDownloadManager.Core.Utilities;
using MyDownloadManager.Engine;

namespace MyDownloadManager.Tests.Core;

public class SecurityTests
{
    [Theory]
    [InlineData("https://example.com/file.zip", true)]
    [InlineData("http://example.com", true)]
    [InlineData("  https://example.com/a b  ", true)]
    [InlineData("file:///C:/Windows/system32/calc.exe", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("data:text/plain,hi", false)]
    [InlineData("ftp://example.com/x", false)]
    [InlineData("\\\\server\\share\\x", false)]
    [InlineData("C:\\x.exe", false)]
    [InlineData("https://exa\nmple.com", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void UrlValidator_AcceptsOnlyHttp(string? url, bool valid) => Assert.Equal(valid, UrlValidator.IsValid(url));

    [Fact]
    public void ExtractUrls_FindsDistinctHttpLinks()
    {
        var text = "see https://a.com/x.zip, and (http://b.org/y.pdf) plus javascript:evil() https://a.com/x.zip\nftp://c";
        var urls = UrlValidator.ExtractUrls(text).Select(u => u.AbsoluteUri).ToList();
        Assert.Equal(["https://a.com/x.zip", "http://b.org/y.pdf"], urls);
    }

    [Fact]
    public void Redact_RemovesCredentialsAndQuery()
    {
        Assert.Equal("https://host/p/file.zip?…", UrlValidator.Redact("https://user:pw@host/p/file.zip?token=secret"));
    }

    [Theory]
    [InlineData("report.pdf", "report.pdf")]
    [InlineData("../../etc/passwd", "passwd")]
    [InlineData("..\\..\\Windows\\evil.exe", "evil.exe")]
    [InlineData("a<b>c:d\"e|f?g*h.txt", "a_b_c_d_e_f_g_h.txt")]
    [InlineData("CON", "_CON")]
    [InlineData("nul.txt", "_nul.txt")]
    [InlineData("com1.tar.gz", "_com1.tar.gz")]
    [InlineData("name. . .", "name")]
    [InlineData("...", "download")]
    [InlineData("   ", "download")]
    [InlineData("evil\u202Etxt.exe", "eviltxt.exe")]
    [InlineData("tab\there.bin", "tab_here.bin")]
    public void Sanitize_ProducesSafeWindowsNames(string input, string expected) =>
        Assert.Equal(expected, FileNameSanitizer.Sanitize(input));

    [Fact]
    public void Sanitize_TruncatesLongNamesKeepingExtension()
    {
        var name = new string('a', 500) + ".zip";
        var s = FileNameSanitizer.Sanitize(name);
        Assert.True(s.Length <= FileNameSanitizer.MaxFileNameLength);
        Assert.EndsWith(".zip", s);
    }

    [Fact]
    public void FromUrl_DecodesLastSegment()
    {
        Assert.Equal("my file.zip", FileNameSanitizer.FromUrl(new Uri("https://x.com/dir/my%20file.zip?q=1")));
        Assert.Equal("x.com", FileNameSanitizer.FromUrl(new Uri("https://x.com/")));
    }

    [Fact]
    public void MakeUnique_AppendsCounter()
    {
        var existing = new HashSet<string> { "a.zip", "a (1).zip" };
        Assert.Equal("a (2).zip", FileNameSanitizer.MakeUnique("a.zip", existing.Contains));
        Assert.Equal("b.zip", FileNameSanitizer.MakeUnique("b.zip", existing.Contains));
    }

    [Fact]
    public void SafeCombine_BlocksTraversal()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mdm-safe");
        Assert.Equal(Path.Combine(dir, "ok.txt"), PathValidator.SafeCombine(dir, "ok.txt"));
        Assert.Throws<UnauthorizedAccessException>(() => PathValidator.SafeCombine(dir, "../escape.txt"));
        Assert.Throws<UnauthorizedAccessException>(() => PathValidator.SafeCombine(dir, "sub/inner.txt"));
    }

    [Theory]
    [InlineData("relative\\path", false)]
    [InlineData("\\\\?\\C:\\x", false)]
    [InlineData("", false)]
    public void IsAcceptableDirectory_RejectsBadPaths(string dir, bool ok) =>
        Assert.Equal(ok, PathValidator.IsAcceptableDirectory(dir, out _));

    [Fact]
    public void IsAcceptableDirectory_AcceptsAbsolute() =>
        Assert.True(PathValidator.IsAcceptableDirectory(Path.GetTempPath(), out _));

    [Theory]
    [InlineData("movie.MP4", FileCategories.Video)]
    [InlineData("setup.exe", FileCategories.Programs)]
    [InlineData("a.tar.gz", FileCategories.Compressed)]
    [InlineData("song.flac", FileCategories.Music)]
    [InlineData("noext", FileCategories.General)]
    public void Categories_FromExtension(string name, string cat) => Assert.Equal(cat, FileCategories.FromFileName(name));

    [Theory]
    [InlineData("sha256:ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789", true)]
    [InlineData("d41d8cd98f00b204e9800998ecf8427e", true)]
    [InlineData("sha1:xyz", false)]
    [InlineData("crc32:1234", false)]
    public void Checksum_Parse(string spec, bool ok) => Assert.Equal(ok, ChecksumVerifier.TryParse(spec, out _, out _));

    [Theory]
    [InlineData(0L, "0 B")]
    [InlineData(1536L, "1.50 KB")]
    [InlineData(10L * 1024 * 1024, "10.0 MB")]
    [InlineData(null, "Unknown")]
    public void Formatting_Bytes(long? bytes, string expected) => Assert.Equal(expected, Formatting.Bytes(bytes));

    [Theory]
    [InlineData("500K", 512000L)]
    [InlineData("2M", 2097152L)]
    [InlineData("1.5MB/s", 1572864L)]
    [InlineData("0", 0L)]
    public void Formatting_ParseSize(string s, long expected)
    {
        Assert.True(Formatting.TryParseSize(s, out var v));
        Assert.Equal(expected, v);
    }
}

public class RateLimiterTests
{
    [Fact]
    public async Task Unlimited_DoesNotWait()
    {
        var rl = new RateLimiter(0);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 1000; i++) await rl.WaitAsync(1 << 20, CancellationToken.None);
        Assert.True(sw.ElapsedMilliseconds < 500);
    }

    [Fact]
    public async Task Limited_ThrottlesThroughput()
    {
        var rl = new RateLimiter(200_000);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 50; i++) await rl.WaitAsync(10_000, CancellationToken.None); // 500 KB
        Assert.InRange(sw.Elapsed.TotalSeconds, 2.0, 4.5);
    }

    [Fact]
    public async Task Cancellation_IsObserved()
    {
        var rl = new RateLimiter(1000);
        using var cts = new CancellationTokenSource(100);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            for (var i = 0; i < 100; i++) await rl.WaitAsync(1000, cts.Token);
        });
    }
}

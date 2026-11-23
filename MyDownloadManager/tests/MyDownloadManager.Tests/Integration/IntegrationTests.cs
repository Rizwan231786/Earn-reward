using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using MyDownloadManager.Integration;

namespace MyDownloadManager.Tests.Integration;

public class NativeMessagingTests
{
    [Fact]
    public async Task Frame_RoundTripsUtf8()
    {
        var ms = new MemoryStream();
        await NativeMessaging.WriteAsync(ms, "{\"type\":\"ping\",\"x\":\"héllo ✓\"}");
        Assert.Equal(Encoding.UTF8.GetByteCount("{\"type\":\"ping\",\"x\":\"héllo ✓\"}"), BinaryPrimitives.ReadInt32LittleEndian(ms.ToArray()));
        ms.Position = 0;
        Assert.Equal("{\"type\":\"ping\",\"x\":\"héllo ✓\"}", await NativeMessaging.ReadAsync(ms));
        Assert.Null(await NativeMessaging.ReadAsync(ms)); // clean EOF
    }

    [Fact]
    public async Task OversizedOrTruncatedFrames_AreRejected()
    {
        var big = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(big, NativeMessaging.MaxMessageBytes + 1);
        await Assert.ThrowsAsync<InvalidDataException>(() => NativeMessaging.ReadAsync(new MemoryStream(big)));

        var trunc = new byte[4 + 3];
        BinaryPrimitives.WriteInt32LittleEndian(trunc, 10);
        await Assert.ThrowsAsync<InvalidDataException>(() => NativeMessaging.ReadAsync(new MemoryStream(trunc)));

        var bad = new byte[] { 2, 0, 0, 0, 0xC3, 0x28 }; // invalid UTF-8
        await Assert.ThrowsAsync<InvalidDataException>(() => NativeMessaging.ReadAsync(new MemoryStream(bad)));
    }

    [Theory]
    [InlineData("{\"type\":\"download\",\"url\":\"https://x.com/a.zip\"}", true)]
    [InlineData("{\"type\":\"download\",\"url\":\"file:///C:/x\"}", false)]
    [InlineData("{\"type\":\"download\",\"url\":\"javascript:alert(1)\"}", false)]
    [InlineData("{\"type\":\"exec\",\"url\":\"https://x.com\"}", false)]
    [InlineData("{\"type\":\"media\",\"url\":\"https://x.com/a.m3u8\",\"mediaKind\":\"hls\"}", true)]
    [InlineData("{\"type\":\"media\",\"url\":\"https://x.com/a.m3u8\",\"mediaKind\":\"rtmp\"}", false)]
    [InlineData("{\"type\":\"batch\",\"urls\":[\"ftp://a\",\"file:///b\"]}", false)]
    [InlineData("{\"type\":\"download\",\"url\":\"https://x.com/a\",\"cookies\":\"a=1\\r\\nX-Evil: 1\"}", false)]
    public void Validator(string json, bool ok)
    {
        var m = JsonSerializer.Deserialize<BrowserMessage>(json, Json.Options)!;
        Assert.Equal(ok, MessageValidator.TryValidate(m, out _));
    }

    [Fact]
    public void Validator_FiltersHeadersAndInvalidBatchUrls()
    {
        var m = new BrowserMessage
        {
            Type = MessageTypes.Batch, Urls = ["https://a.com/1", "javascript:x", "https://a.com/1", "http://b.com/2"],
            Headers = new() { ["Accept-Language"] = "en", ["Host"] = "evil", ["X-Forwarded-For"] = "1.2.3.4" },
        };
        Assert.True(MessageValidator.TryValidate(m, out _));
        Assert.Equal(["https://a.com/1", "http://b.com/2"], m.Urls);
        Assert.Equal(["Accept-Language"], m.Headers!.Keys);
    }
}

public sealed class IpcTests : IAsyncDisposable
{
    private readonly string _pipe = "mdm-test-" + Guid.NewGuid().ToString("N");
    private readonly ConcurrentQueue<BrowserMessage> _received = new();
    private readonly IpcServer _server;

    public IpcTests()
    {
        _server = new IpcServer((m, _) =>
        {
            _received.Enqueue(m);
            return Task.FromResult(m.Type == MessageTypes.Ping ? new HostResponse { Ok = true, Version = "test" } : HostResponse.Success(new { id = "123" }));
        }, _pipe);
        _server.Start();
    }

    public ValueTask DisposeAsync() => _server.DisposeAsync();

    [Fact]
    public async Task ClientServer_RoundTrip()
    {
        var r = await IpcClient.SendAsync(new BrowserMessage { Type = "download", Url = "https://example.com/f.zip", Cookies = "a=b" }, TimeSpan.FromSeconds(5), pipeName: _pipe);
        Assert.True(r.Ok);
        Assert.Equal("123", r.Data!.Value.GetProperty("id").GetString());
        var got = Assert.Single(_received);
        Assert.Equal("a=b", got.Cookies);
    }

    [Fact]
    public async Task InvalidRequests_NeverReachHandler()
    {
        var r = await IpcClient.SendAsync(new BrowserMessage { Type = "download", Url = "file:///etc/passwd" }, TimeSpan.FromSeconds(5), pipeName: _pipe);
        Assert.False(r.Ok);
        Assert.Empty(_received);
    }

    [Fact]
    public async Task ManyConcurrentClients()
    {
        var tasks = Enumerable.Range(0, 20).Select(i =>
            IpcClient.SendAsync(new BrowserMessage { Type = "download", Url = $"https://example.com/{i}" }, TimeSpan.FromSeconds(10), pipeName: _pipe));
        var results = await Task.WhenAll(tasks);
        Assert.All(results, r => Assert.True(r.Ok));
        Assert.Equal(20, _received.Count);
    }

    [Fact]
    public async Task Dispose_IsIdempotent()
    {
        var server = new IpcServer((_, _) => Task.FromResult(HostResponse.Success()), "mdm-dispose-" + Guid.NewGuid().ToString("N"));
        server.Start();
        await server.DisposeAsync();
        await server.DisposeAsync();
    }

    [Fact]
    public async Task NoServer_TimesOut() =>
        await Assert.ThrowsAsync<TimeoutException>(() =>
            IpcClient.SendAsync(new BrowserMessage { Type = "ping" }, TimeSpan.FromMilliseconds(200), pipeName: "mdm-nobody-" + Guid.NewGuid().ToString("N")));
}

/// <summary>End-to-end: spawn the real native host executable exactly like a browser does (framed stdin/stdout).</summary>
public sealed class NativeHostProcessTests : IAsyncDisposable
{
    private readonly string _pipe = "mdm-host-" + Guid.NewGuid().ToString("N");
    private readonly ConcurrentQueue<BrowserMessage> _received = new();
    private IpcServer? _server;

    public async ValueTask DisposeAsync() { if (_server is not null) await _server.DisposeAsync(); }

    private static string HostDll()
    {
        var cfg = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name; // Debug/Release
        var root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "MyDownloadManager.slnx"))) root = Path.GetDirectoryName(root.TrimEnd(Path.DirectorySeparatorChar))!;
        var dll = Path.Combine(root, "src", "MyDownloadManager.NativeHost", "bin", cfg, "net10.0", "MyDownloadManager.NativeHost.dll");
        Assert.True(File.Exists(dll), $"Native host not built at {dll}");
        return dll;
    }

    private Process StartHost(string? appPath = null)
    {
        var psi = new ProcessStartInfo("dotnet") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        psi.ArgumentList.Add(HostDll());
        psi.ArgumentList.Add("chrome-extension://abcdefghijklmnopabcdefghijklmnop/");
        psi.Environment["MDM_PIPE_NAME"] = _pipe;
        psi.Environment["MDM_APP_PATH"] = appPath ?? "/nonexistent/MyDownloadManager";
        return Process.Start(psi)!;
    }

    private static async Task<JsonElement> Exchange(Process p, object message)
    {
        await NativeMessaging.WriteAsync(p.StandardInput.BaseStream, JsonSerializer.Serialize(message));
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var reply = await NativeMessaging.ReadAsync(p.StandardOutput.BaseStream, cts.Token);
        return JsonDocument.Parse(reply!).RootElement.Clone();
    }

    [Fact]
    public async Task Host_RelaysMessagesToApp()
    {
        _server = new IpcServer((m, _) => { _received.Enqueue(m); return Task.FromResult(HostResponse.Success(new { queued = true })); }, _pipe);
        _server.Start();
        using var p = StartHost();
        var r1 = await Exchange(p, new { type = "download", url = "https://example.com/file.iso", referrer = "https://example.com/" });
        Assert.True(r1.GetProperty("ok").GetBoolean());
        Assert.True(r1.GetProperty("data").GetProperty("queued").GetBoolean());
        var r2 = await Exchange(p, new { type = "download", url = "file:///etc/shadow" });
        Assert.False(r2.GetProperty("ok").GetBoolean());

        p.StandardInput.Close(); // browser disconnects
        Assert.True(p.WaitForExit(10_000));
        Assert.Equal(0, p.ExitCode);
        var m = Assert.Single(_received);
        Assert.Equal("chromium", m.Browser);
        Assert.Equal("https://example.com/", m.Referrer);
    }

    [Fact]
    public async Task Host_PingWithoutApp_ReportsNotRunning()
    {
        using var p = StartHost();
        var r = await Exchange(p, new { type = "ping" });
        Assert.True(r.GetProperty("ok").GetBoolean());
        Assert.False(r.GetProperty("appRunning").GetBoolean());
        var d = await Exchange(p, new { type = "download", url = "https://example.com/x" });
        Assert.False(d.GetProperty("ok").GetBoolean());
        Assert.Contains("could not be found", d.GetProperty("error").GetString());
        p.Kill();
    }

    [Fact]
    public async Task Host_RejectsOversizedFrame()
    {
        using var p = StartHost();
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, 50 * 1024 * 1024);
        await p.StandardInput.BaseStream.WriteAsync(header);
        await p.StandardInput.BaseStream.FlushAsync();
        var reply = await NativeMessaging.ReadAsync(p.StandardOutput.BaseStream);
        Assert.Contains("exceeds", reply);
        Assert.True(p.WaitForExit(10_000));
        Assert.Equal(1, p.ExitCode);
    }
}

public class NativeHostManifestTests
{
    [Fact]
    public void Chromium_ManifestHasAllowedOrigins()
    {
        var path = OperatingSystem.IsWindows() ? @"C:\Program Files\MDM\MyDownloadManager.NativeHost.exe" : "/opt/mdm/host";
        using var doc = JsonDocument.Parse(NativeHostManifest.BuildChromium(path));
        var r = doc.RootElement;
        Assert.Equal("com.mydownloadmanager.host", r.GetProperty("name").GetString());
        Assert.Equal("stdio", r.GetProperty("type").GetString());
        Assert.Equal(path, r.GetProperty("path").GetString());
        Assert.Equal("chrome-extension://jepeaacjobbkicoofllleimejjcjebge/", r.GetProperty("allowed_origins")[0].GetString());
    }

    [Fact]
    public void Firefox_ManifestHasAllowedExtensions()
    {
        var path = OperatingSystem.IsWindows() ? @"C:\x\host.exe" : "/x/host";
        using var doc = JsonDocument.Parse(NativeHostManifest.BuildFirefox(path));
        Assert.Equal("mydownloadmanager@mydownloadmanager.app", doc.RootElement.GetProperty("allowed_extensions")[0].GetString());
    }

    [Fact]
    public void RejectsBadInput()
    {
        Assert.Throws<ArgumentException>(() => NativeHostManifest.BuildChromium("relative/host.exe"));
        Assert.Throws<ArgumentException>(() => NativeHostManifest.BuildChromium(OperatingSystem.IsWindows() ? @"C:\h.exe" : "/h", ["not-an-id"]));
    }

    [Fact]
    public void ChromiumId_MatchesExtensionPublicKey()
    {
        // The extension ID is the first 128 bits of SHA-256(public key DER), hex digits mapped 0-f → a-p.
        var root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "MyDownloadManager.slnx"))) root = Path.GetDirectoryName(root.TrimEnd(Path.DirectorySeparatorChar))!;
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "extensions", "manifest.chromium.json")));
        var der = Convert.FromBase64String(doc.RootElement.GetProperty("key").GetString()!);
        var hex = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(der))[..32];
        var id = new string(hex.Select(c => (char)('a' + Convert.ToInt32(c.ToString(), 16))).ToArray());
        Assert.Equal(NativeHostManifest.ChromiumExtensionId, id);
    }
}

using System.Buffers.Binary;
using System.Text;

namespace MyDownloadManager.Integration;

/// <summary>
/// Chrome/Firefox native messaging framing: a 32-bit little-endian length followed by UTF-8 JSON.
/// The same framing is used on the app's named pipe.
/// </summary>
public static class NativeMessaging
{
    /// <summary>Browsers cap host→browser messages at 1 MB; we apply the same cap to incoming messages.</summary>
    public const int MaxMessageBytes = 1024 * 1024;

    /// <summary>Reads one message. Returns null on clean end-of-stream (browser closed the port).</summary>
    public static async Task<string?> ReadAsync(Stream stream, CancellationToken ct = default, int maxBytes = MaxMessageBytes)
    {
        var header = new byte[4];
        var read = await ReadExactlyOrEofAsync(stream, header, ct).ConfigureAwait(false);
        if (read == 0) return null;
        if (read < 4) throw new InvalidDataException("Truncated message header.");
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length < 0 || length > maxBytes) throw new InvalidDataException($"Message length {length} exceeds the {maxBytes} byte limit.");
        var body = new byte[length];
        if (await ReadExactlyOrEofAsync(stream, body, ct).ConfigureAwait(false) != length) throw new InvalidDataException("Truncated message body.");
        try { return new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(body); }
        catch (DecoderFallbackException) { throw new InvalidDataException("Message is not valid UTF-8."); }
    }

    public static async Task WriteAsync(Stream stream, string json, CancellationToken ct = default)
    {
        var body = Encoding.UTF8.GetBytes(json);
        if (body.Length > MaxMessageBytes) throw new InvalidDataException("Message too large.");
        var frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        await stream.WriteAsync(frame, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    private static async Task<int> ReadExactlyOrEofAsync(Stream s, byte[] buffer, CancellationToken ct)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var n = await s.ReadAsync(buffer.AsMemory(total), ct).ConfigureAwait(false);
            if (n == 0) break;
            total += n;
        }
        return total;
    }
}

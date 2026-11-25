using System.Net;

namespace MyDownloadManager.Engine;

/// <summary>A download failure with a user-presentable message and a flag telling whether retrying may help.</summary>
public class DownloadException : Exception
{
    public bool IsTransient { get; }
    public HttpStatusCode? StatusCode { get; }

    public DownloadException(string message, bool isTransient, HttpStatusCode? status = null, Exception? inner = null)
        : base(message, inner)
    {
        IsTransient = isTransient;
        StatusCode = status;
    }

    public static DownloadException FromStatus(HttpStatusCode code, string? reason)
    {
        var n = (int)code;
        var transient = n is 408 or 425 or 429 or >= 500;
        var msg = code switch
        {
            HttpStatusCode.Unauthorized => "The server requires authentication (401). Provide valid credentials for this site.",
            HttpStatusCode.Forbidden => "Access denied by the server (403). The link may have expired or requires a browser session.",
            HttpStatusCode.NotFound => "File not found on the server (404).",
            HttpStatusCode.Gone => "The file is no longer available (410).",
            HttpStatusCode.RequestedRangeNotSatisfiable => "The server rejected the requested byte range (416).",
            _ => $"Server returned HTTP {n} {reason}.",
        };
        return new DownloadException(msg, transient, code);
    }
}

/// <summary>Thrown when the remote file changed between sessions (ETag / Last-Modified / size mismatch).</summary>
public sealed class ResourceChangedException(string message) : DownloadException(message, isTransient: false);

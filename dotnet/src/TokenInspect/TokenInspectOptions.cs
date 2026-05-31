using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
namespace TokenInspect;
public sealed class TokenInspectOptions
{
    /// <summary>Master switch. Default OFF — "closed door". Endpoint only mapped when true.</summary>
    public bool Enabled { get; set; } = false;
    /// <summary>Header where the host puts the resolved session id (server-to-server).</summary>
    public string SessionIdHeader { get; set; } = "X-Session-Id";
    /// <summary>
    /// REQUIRED for /internal/trace to return data. Receives the HttpContext and the session id
    /// pulled from the request header, returns true ONLY if the caller is authorized to read that
    /// session's journal (i.e. owns it). Default: DENY EVERYTHING. The host wires this to a
    /// principal-derived check (ownership derived from the authenticated context / server-side store).
    /// The header-supplied id is treated as an untrusted lookup key, never as proof of ownership.
    /// </summary>
    public Func<HttpContext, string, ValueTask<bool>> Authorize { get; set; } = static (_, _) => ValueTask.FromResult(false);
    public TimeSpan RunTtl { get; set; } = TimeSpan.FromMinutes(10);
    public TimeSpan JournalTtl { get; set; } = TimeSpan.FromHours(8);
}

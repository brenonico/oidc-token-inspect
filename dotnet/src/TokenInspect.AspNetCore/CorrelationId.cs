using System.Text.RegularExpressions;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Validation/sanitization for the cross-source correlation id.
/// Anti log/cache injection: an id read from an untrusted header is only accepted if it matches
/// a strict allow-list pattern (<c>^[A-Za-z0-9_-]{8,64}$</c>). Anything else (CR/LF, control chars,
/// over-long, too short, empty) is rejected and a fresh server-side id is generated instead.
/// </summary>
internal static partial class CorrelationId
{
    [GeneratedRegex("^[A-Za-z0-9_-]{8,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Allowed();

    /// <summary>True if <paramref name="value"/> is a syntactically valid correlation id.</summary>
    public static bool IsValid(string? value) => value is not null && Allowed().IsMatch(value);

    /// <summary>Generates a fresh, always-valid server-side correlation id.</summary>
    public static string Generate() => Guid.NewGuid().ToString("n"); // 32 hex chars, in [A-Za-z0-9]{8,64}

    /// <summary>Returns <paramref name="candidate"/> if valid, otherwise a freshly generated id.
    /// The result is ALWAYS safe to use as a log/ring key.</summary>
    public static string Sanitize(string? candidate) => IsValid(candidate) ? candidate! : Generate();
}

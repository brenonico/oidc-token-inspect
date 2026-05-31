namespace TokenInspect;
public interface ITraceStore
{
    Task SaveRunAsync(string key, FlowRun run, CancellationToken ct = default);
    Task<FlowRun?> GetRunAsync(string key, CancellationToken ct = default);
    Task AppendToJournalAsync(string sessionId, FlowRun run, CancellationToken ct = default);
    Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sessionId, CancellationToken ct = default);

    /// <summary>Re-keys an in-flight run from <paramref name="oldCorrelationId"/> to
    /// <paramref name="newCorrelationId"/> so an anonymous (pre-login) run can be adopted under
    /// an authenticated session id. Implementations that can do so MUST perform this atomically
    /// (pop the old key, push under the new key under a single lock) so a concurrent reader never
    /// observes the run under both keys, nor loses it mid-flight. The default is a best-effort copy
    /// that leaves the run reachable under the old key as well; override it in a store that owns a
    /// lock to get the atomic semantics.</summary>
    async Task RekeyRunAsync(string oldCorrelationId, string newCorrelationId, CancellationToken ct = default)
    {
        var run = await GetRunAsync(oldCorrelationId, ct).ConfigureAwait(false);
        if (run is null) return;
        await SaveRunAsync(newCorrelationId, run, ct).ConfigureAwait(false);
    }
}

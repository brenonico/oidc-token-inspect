namespace TokenInspect;
public interface ITraceStore
{
    Task SaveRunAsync(string key, FlowRun run, CancellationToken ct = default);
    Task<FlowRun?> GetRunAsync(string key, CancellationToken ct = default);
    Task AppendToJournalAsync(string sessionId, FlowRun run, CancellationToken ct = default);
    Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sessionId, CancellationToken ct = default);
}

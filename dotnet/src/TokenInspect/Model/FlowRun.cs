namespace TokenInspect;
public sealed class FlowRun
{
    public string Id { get; init; } = Guid.NewGuid().ToString("n");
    public required string FlowKind { get; init; }
    public required string Title { get; init; }
    public FlowStatus Status { get; set; } = FlowStatus.Running;
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EndedAt { get; set; }
    public string? Error { get; set; }
    public required IReadOnlyList<string> Participants { get; init; }
    /// <summary>Correlation key (e.g. OAuth <c>state</c>) that stitches a run split across a redirect.
    /// Persisted so <see cref="IFlowRecorder.ResumeRun"/> can recover the run — with all its steps —
    /// from a store that returns deep copies (e.g. a serializing Redis store), not shared references.</summary>
    public string? CorrelationKey { get; set; }
    /// <summary>Correlation id that stitches a client-side and server-side view of the SAME logical flow
    /// across sources (cross-source merge). Distinct from <see cref="CorrelationKey"/>, which is an
    /// internal resume key (OAuth <c>state</c>) for recovering a server run across a redirect.</summary>
    public string? CorrelationId { get; init; }
    /// <summary>Origin of this run: <c>"client"</c> | <c>"server"</c> | <c>"bff"</c> | <c>"merged"</c>.</summary>
    public string? Source { get; init; }
    /// <summary>Steps appended by <see cref="FlowRecorder"/> during the flow's lifetime; <c>init</c> protects the reference, not the contents.</summary>
    public List<TraceStep> Steps { get; init; } = new();
}

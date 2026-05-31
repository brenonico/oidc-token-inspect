namespace TokenInspect;
public sealed record TraceStep(
    int Ordinal, string Label, string From, string To,
    DateTimeOffset Timestamp, IReadOnlyList<TraceVariable> Vars,
    string? Note = null, string? Short = null, int? Seq = null, string? Source = null);

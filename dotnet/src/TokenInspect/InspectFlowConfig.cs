namespace TokenInspect;
/// <summary>
/// Process-wide entry point that the <see cref="InspectFlow"/> ambient API resolves its
/// <see cref="IFlowRecorder"/> from. Set once at startup by <c>AddTokenInspect()</c>.
/// </summary>
public static class InspectFlowConfig
{
    /// <summary>
    /// Recorder used by <see cref="InspectFlow.Begin"/>. Wired from DI when the package is
    /// registered. Null until <c>AddTokenInspect()</c> has run, in which case
    /// <see cref="InspectFlow.Begin"/> throws.
    /// </summary>
    public static IFlowRecorder? Recorder { get; set; }
}

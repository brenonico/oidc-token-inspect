using Xunit;

// InspectFlowConfig.Recorder is a process-wide static. Test classes that
// install a recorder in their constructor race against each other under the
// default xUnit per-class parallelism. Serialise this assembly to avoid it.
[assembly: CollectionBehavior(DisableTestParallelization = true)]

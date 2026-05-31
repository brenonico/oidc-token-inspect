using System.Text.Json;
using System.Text.Json.Serialization;
using TokenInspect;
using Xunit;
public class SerializationTests
{
    // Mirrors the serializer the host uses (Program.cs ConfigureHttpJsonOptions + RedisTraceStore):
    // web defaults (camelCase) + enums as their string names. Keeps the parity assertions honest.
    private static readonly JsonSerializerOptions HostOpts = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    [Fact]
    public void FlowRun_round_trips_with_all_variable_kinds()
    {
        var run = new FlowRun { FlowKind = "auth.login", Title = "Login", Participants = new[] { "Browser", "SessionManager" } };
        run.Steps.Add(new TraceStep(1, "Generated PKCE", "SessionManager", "SessionManager", DateTimeOffset.UtcNow,
            new[] { TraceVariable.Plain("state", "abc"), TraceVariable.Jwt("access_token", "eyJ.a.b") }));
        var json = JsonSerializer.Serialize(run);
        var back = JsonSerializer.Deserialize<FlowRun>(json)!;
        Assert.Equal("auth.login", back.FlowKind);
        Assert.Equal(2, back.Steps[0].Vars.Count);
        Assert.Equal(VariableKind.Jwt, back.Steps[0].Vars[1].Kind);
    }

    [Fact]
    public void FlowRun_with_parity_fields_round_trips_through_host_serializer()
    {
        var run = new FlowRun
        {
            FlowKind = "auth.login",
            Title = "Login",
            Participants = new[] { "Browser", "SessionManager" },
            CorrelationId = "corr-123",
            Source = "bff",
        };
        run.Steps.Add(new TraceStep(1, "Generated PKCE", "SessionManager", "SessionManager", DateTimeOffset.UtcNow,
            new[] { TraceVariable.Jwt("access_token", "eyJ.a.b") },
            Note: "n", Short: "PKCE", Seq: 1, Source: "bff"));

        var json = JsonSerializer.Serialize(run, HostOpts);
        var back = JsonSerializer.Deserialize<FlowRun>(json, HostOpts)!;

        Assert.Equal("corr-123", back.CorrelationId);
        Assert.Equal("bff", back.Source);
        Assert.Equal("PKCE", back.Steps[0].Short);
        Assert.Equal(1, back.Steps[0].Seq);
        Assert.Equal("bff", back.Steps[0].Source);
    }

    [Fact]
    public void Parity_fields_serialize_as_camelCase_with_string_enum_values()
    {
        var run = new FlowRun
        {
            FlowKind = "auth.login",
            Title = "Login",
            Participants = new[] { "Browser", "SessionManager" },
            CorrelationId = "corr-123",
            Source = "bff",
        };
        run.Steps.Add(new TraceStep(1, "Generated PKCE", "SessionManager", "SessionManager", DateTimeOffset.UtcNow,
            new[] { TraceVariable.Jwt("access_token", "eyJ.a.b") },
            Short: "PKCE", Seq: 1, Source: "bff"));

        var json = JsonSerializer.Serialize(run, HostOpts);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        // camelCase property names for the new fields.
        Assert.Equal("corr-123", root.GetProperty("correlationId").GetString());
        Assert.Equal("bff", root.GetProperty("source").GetString());
        var step = root.GetProperty("steps")[0];
        Assert.Equal("PKCE", step.GetProperty("short").GetString());
        Assert.Equal(1, step.GetProperty("seq").GetInt32());
        Assert.Equal("bff", step.GetProperty("source").GetString());

        // Enums serialize as their string names, not integers.
        Assert.Equal("Running", root.GetProperty("status").GetString());
        Assert.Equal("Jwt", step.GetProperty("vars")[0].GetProperty("kind").GetString());
    }
}

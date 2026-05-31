using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using TokenInspect;
using TokenInspect.AspNetCore;
using Xunit;

namespace TokenInspect.AspNetCore.Tests;

// ---------------------------------------------------------------------------
// Helper: build a TestServer-backed app for a given options configuration.
// A "/probe" endpoint exercises the middleware so we can observe ring growth.
// RemoteIpAddress can be forced to loopback to exercise LoopbackOnly paths.
// ---------------------------------------------------------------------------
file static class TestApp
{
    public static (WebApplication app, HttpClient client) Build(
        Action<AspNetCoreOptions> configure,
        string environment = "Development",
        bool forceLoopbackRemoteIp = false)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseTestServer();
        builder.Services.AddTokenInspectAspNetCore(configure);
        builder.Services.AddRouting();

        var app = builder.Build();

        if (forceLoopbackRemoteIp)
            app.Use(async (ctx, next) => { ctx.Connection.RemoteIpAddress = IPAddress.Loopback; await next(); });

        app.UseTokenInspect();
        app.MapTokenInspectDev();
        app.MapGet("/probe", () => Results.Ok("ok"));

        app.StartAsync().GetAwaiter().GetResult();
        return (app, app.GetTestClient());
    }

    public static RingBuffer<FlowRun> Ring(WebApplication app)
        => app.Services.GetRequiredService<RingBuffer<FlowRun>>();
}

public class MiddlewareAndEndpointTests
{
    // Case 1: Enabled=false → middleware no-op (no ring growth) + dev endpoint 404.
    [Fact]
    public async Task Disabled_middleware_is_noop_and_endpoint_404()
    {
        var (app, client) = TestApp.Build(o => o.Enabled = false);
        try
        {
            var probe = await client.GetAsync("/probe");
            Assert.Equal(HttpStatusCode.OK, probe.StatusCode);

            // No ring writes happened.
            Assert.Equal(0, TestApp.Ring(app).Count);

            var dev = await client.GetAsync("/__ti/trace?id=abcdefgh");
            Assert.Equal(HttpStatusCode.NotFound, dev.StatusCode);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    // Case 1b: Enabled=true → the probe causes exactly one ring entry (middleware records).
    [Fact]
    public async Task Enabled_middleware_records_a_run()
    {
        var (app, client) = TestApp.Build(o => o.Enabled = true);
        try
        {
            Assert.Equal(0, TestApp.Ring(app).Count);
            await client.GetAsync("/probe");
            Assert.Equal(1, TestApp.Ring(app).Count);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    // Case 2: Enabled=true, Production env, no Ack → dev endpoint NOT mapped (404).
    [Fact]
    public async Task Production_without_ack_does_not_map_endpoint()
    {
        var (app, client) = TestApp.Build(
            o => o.Enabled = true,
            environment: "Production",
            forceLoopbackRemoteIp: true);
        try
        {
            var dev = await client.GetAsync("/__ti/trace?id=abcdefgh");
            Assert.Equal(HttpStatusCode.NotFound, dev.StatusCode);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    // Case 3: Enabled + AckExposesTokens + default Authorize (deny) → endpoint responds but 403.
    [Fact]
    public async Task AckExposesTokens_with_default_deny_returns_403()
    {
        var (app, client) = TestApp.Build(
            o => { o.Enabled = true; o.AckExposesTokens = true; }, // default Authorize denies all
            environment: "Production",
            forceLoopbackRemoteIp: true);
        try
        {
            var dev = await client.GetAsync("/__ti/trace?id=abcdefgh");
            Assert.Equal(HttpStatusCode.Forbidden, dev.StatusCode);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    // Case 4: Authorize returns true → 200 with the runs for that correlationId.
    [Fact]
    public async Task Authorize_true_returns_200_with_runs_for_correlation_id()
    {
        const string corr = "corr-id-1234";
        var (app, client) = TestApp.Build(
            o => { o.Enabled = true; o.Authorize = (_, _) => true; },
            forceLoopbackRemoteIp: true);
        try
        {
            // Drive a recorded run that carries the correlation id via the default header.
            var req = new HttpRequestMessage(HttpMethod.Get, "/probe");
            req.Headers.Add("traceparent", corr);
            await client.SendAsync(req);

            var dev = await client.GetAsync($"/__ti/trace?id={corr}");
            Assert.Equal(HttpStatusCode.OK, dev.StatusCode);

            var body = await dev.Content.ReadAsStringAsync();
            Assert.Contains(corr, body);
            Assert.Contains("api.server", body); // run was captured
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    // Case 5: Corrupted/over-long header → sanitized; never used as ring key; no 500;
    // the captured run gets a generated (clean) id, not the corrupt value.
    [Theory]
    [InlineData("bad\r\ninjection")]                 // CRLF injection attempt
    [InlineData("short")]                            // too short (<8)
    [InlineData("this-id-is-way-too-long-to-be-accepted-because-it-exceeds-sixty-four-characters-limit")] // too long
    [InlineData("has spaces and #symbols!")]         // illegal chars
    public async Task Corrupt_header_is_sanitized_and_never_used_as_key(string corrupt)
    {
        var (app, client) = TestApp.Build(
            o => { o.Enabled = true; o.Authorize = (_, _) => true; },
            forceLoopbackRemoteIp: true);
        try
        {
            // HttpClient rejects header values with CR/LF at send time, so we tolerate that:
            // the server-side defence still must hold for values that DO reach us. We send via a
            // request and assert no crash + the captured run has a sanitized id.
            var req = new HttpRequestMessage(HttpMethod.Get, "/probe");
            try { req.Headers.TryAddWithoutValidation("traceparent", corrupt); } catch { }
            var probe = await client.SendAsync(req);
            Assert.Equal(HttpStatusCode.OK, probe.StatusCode); // never a 500

            var ring = TestApp.Ring(app);
            Assert.Equal(1, ring.Count);
            var run = Assert.Single(ring.Snapshot());

            // The corrupt value must NOT have become the correlation id.
            Assert.NotEqual(corrupt, run.CorrelationId);
            Assert.True(run.CorrelationId is not null && IsCleanId(run.CorrelationId),
                $"correlation id should be a clean generated id, was: '{run.CorrelationId}'");

            // Sanity: a valid id reaches the handler (200) — proves the route + loopback are fine.
            var ok = await client.GetAsync("/__ti/trace?id=abcdefgh");
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

            // And querying the dev endpoint with the corrupt value is rejected pre-lookup (400),
            // never reflected back as a key.
            var devReq = new HttpRequestMessage(HttpMethod.Get, $"/__ti/trace?id={Uri.EscapeDataString(corrupt)}");
            var dev = await client.SendAsync(devReq);
            Assert.Equal(HttpStatusCode.BadRequest, dev.StatusCode);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    private static bool IsCleanId(string id)
        => id.Length is >= 8 and <= 64 && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-');

    // Loopback enforcement: non-loopback remote (default null in TestServer) → 404 even when allowed.
    [Fact]
    public async Task Non_loopback_remote_gets_404_when_loopback_only()
    {
        var (app, client) = TestApp.Build(
            o => { o.Enabled = true; o.Authorize = (_, _) => true; },
            forceLoopbackRemoteIp: false); // RemoteIpAddress stays null → not loopback
        try
        {
            var dev = await client.GetAsync("/__ti/trace?id=abcdefgh");
            Assert.Equal(HttpStatusCode.NotFound, dev.StatusCode);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }
}

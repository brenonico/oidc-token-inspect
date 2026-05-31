using TokenInspect.AspNetCore;
using Xunit;

namespace TokenInspect.AspNetCore.Tests;

public class RingBufferTests
{
    [Fact]
    public void Capacity_eviction_keeps_only_newest_items()
    {
        var ring = new RingBuffer<int>(capacity: 3, ttl: TimeSpan.FromHours(1));
        ring.Append(1);
        ring.Append(2);
        ring.Append(3);
        ring.Append(4); // evicts 1
        ring.Append(5); // evicts 2

        var snapshot = ring.Snapshot();
        Assert.Equal(new[] { 3, 4, 5 }, snapshot);
        Assert.Equal(3, ring.Count);
    }

    [Fact]
    public void Ttl_eviction_drops_expired_entries_on_read()
    {
        var now = DateTimeOffset.UtcNow;
        var clock = () => now;
        var ring = new RingBuffer<int>(capacity: 10, ttl: TimeSpan.FromMinutes(5), clock: () => clock());

        ring.Append(10); // t0
        now = now.AddMinutes(3);
        ring.Append(20); // t0+3m

        // Advance past the TTL of the first entry but not the second.
        now = now.AddMinutes(3); // first is now 6m old (expired), second is 3m old (live)

        var live = ring.Snapshot();
        Assert.Equal(new[] { 20 }, live);
        Assert.Equal(1, ring.Count);

        // Advance past both.
        now = now.AddMinutes(10);
        Assert.Empty(ring.Snapshot());
        Assert.Equal(0, ring.Count);
    }

    [Fact]
    public void Find_returns_only_matching_live_items()
    {
        var ring = new RingBuffer<string>(capacity: 10, ttl: TimeSpan.FromHours(1));
        ring.Append("a-1");
        ring.Append("b-1");
        ring.Append("a-2");

        var matches = ring.Find(s => s.StartsWith("a-"));
        Assert.Equal(new[] { "a-1", "a-2" }, matches);
    }
}

namespace TokenInspect.AspNetCore;

/// <summary>
/// Bounded, thread-safe in-memory ring of items with per-entry TTL.
/// <list type="bullet">
/// <item>Appending past <see cref="_capacity"/> evicts the oldest entry.</item>
/// <item>Expired entries (older than <paramref name="ttl"/>) are evicted lazily on read/append.</item>
/// </list>
/// Decoupled: pure in-memory, no external store.
/// </summary>
public sealed class RingBuffer<T>
{
    private readonly record struct Entry(T Item, DateTimeOffset AddedAt);

    private readonly int _capacity;
    private readonly TimeSpan _ttl;
    private readonly Func<DateTimeOffset> _clock;
    private readonly LinkedList<Entry> _items = new();
    private readonly object _gate = new();

    public RingBuffer(int capacity, TimeSpan ttl, Func<DateTimeOffset>? clock = null)
    {
        if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
        _capacity = capacity;
        _ttl = ttl;
        _clock = clock ?? (static () => DateTimeOffset.UtcNow);
    }

    /// <summary>Appends an item, evicting the oldest if at capacity and any expired entries.</summary>
    public void Append(T item)
    {
        var now = _clock();
        lock (_gate)
        {
            EvictExpired(now);
            _items.AddLast(new Entry(item, now));
            while (_items.Count > _capacity)
                _items.RemoveFirst();
        }
    }

    /// <summary>Current count of live (non-expired) entries. Primarily for tests/diagnostics.</summary>
    public int Count
    {
        get
        {
            var now = _clock();
            lock (_gate)
            {
                EvictExpired(now);
                return _items.Count;
            }
        }
    }

    /// <summary>Snapshot of all live (non-expired) items, oldest first.</summary>
    public IReadOnlyList<T> Snapshot()
    {
        var now = _clock();
        lock (_gate)
        {
            EvictExpired(now);
            var result = new List<T>(_items.Count);
            foreach (var e in _items) result.Add(e.Item);
            return result;
        }
    }

    /// <summary>Returns live (non-expired) items matching <paramref name="predicate"/>, oldest first.</summary>
    public IReadOnlyList<T> Find(Func<T, bool> predicate)
    {
        ArgumentNullException.ThrowIfNull(predicate);
        var now = _clock();
        lock (_gate)
        {
            EvictExpired(now);
            var result = new List<T>();
            foreach (var e in _items)
                if (predicate(e.Item)) result.Add(e.Item);
            return result;
        }
    }

    // Caller must hold _gate.
    private void EvictExpired(DateTimeOffset now)
    {
        if (_ttl <= TimeSpan.Zero) return;
        var cutoff = now - _ttl;
        while (_items.First is { } first && first.Value.AddedAt < cutoff)
            _items.RemoveFirst();
    }
}

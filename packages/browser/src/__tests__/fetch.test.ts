import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFetchWrap } from "../observer/fetch";
import type { NetEvent } from "../observer/types";

let original: typeof window.fetch;

beforeEach(() => {
  original = window.fetch;
});

afterEach(() => {
  window.fetch = original;
  vi.restoreAllMocks();
});

describe("installFetchWrap", () => {
  it("passes through and resolves the ORIGINAL response unchanged", async () => {
    const body = JSON.stringify({ ok: true });
    const resp = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    window.fetch = vi.fn(async () => resp) as unknown as typeof window.fetch;
    const orig = window.fetch;

    const events: NetEvent[] = [];
    const teardown = installFetchWrap((e) => events.push(e));

    const res = await window.fetch("/x");
    expect(res.status).toBe(200);
    // Host body must still be readable — the wrap never consumed it.
    await expect(res.text()).resolves.toBe(body);
    expect(orig).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("an onEvent that THROWS does not break the host call", async () => {
    const resp = new Response("hello", { status: 201 });
    window.fetch = vi.fn(async () => resp) as unknown as typeof window.fetch;

    const teardown = installFetchWrap(() => {
      throw new Error("instrumentation boom");
    });

    await expect(window.fetch("/x")).resolves.toMatchObject({ status: 201 });
    teardown();
  });

  it("a rejected host fetch still rejects (instrumentation swallows its own copy)", async () => {
    const err = new Error("network down");
    window.fetch = vi.fn(async () => {
      throw err;
    }) as unknown as typeof window.fetch;

    const events: NetEvent[] = [];
    const teardown = installFetchWrap((e) => events.push(e));

    await expect(window.fetch("/x")).rejects.toThrow("network down");
    expect(events).toHaveLength(0);
    teardown();
  });

  it("teardown restores window.fetch === original", () => {
    const ref = window.fetch;
    const teardown = installFetchWrap(() => {});
    expect(window.fetch).not.toBe(ref);
    teardown();
    expect(window.fetch).toBe(ref);
  });

  it("refuses to double-wrap", () => {
    const ref = window.fetch;
    const t1 = installFetchWrap(() => {});
    const wrapped = window.fetch;
    const t2 = installFetchWrap(() => {}); // no-op: already wrapped
    expect(window.fetch).toBe(wrapped);
    t2();
    // The no-op teardown must NOT remove the real wrap.
    expect(window.fetch).toBe(wrapped);
    t1();
    expect(window.fetch).toBe(ref);
  });

  it("emits method/url/status metadata for a resolved fetch", async () => {
    const resp = new Response("{}", { status: 200, headers: { "x-test": "1" } });
    window.fetch = vi.fn(async () => resp) as unknown as typeof window.fetch;

    const events: NetEvent[] = [];
    const teardown = installFetchWrap((e) => events.push(e));

    await window.fetch("https://api.example.com/users", { method: "GET" });
    // Allow the promise.then microtask to flush.
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0].req.method).toBe("GET");
    expect(events[0].req.url).toBe("https://api.example.com/users");
    expect(events[0].res.status).toBe(200);
    expect(events[0].res.headers["x-test"]).toBe("1");
    teardown();
  });

  it("does NOT inject any header (init is passed through verbatim)", async () => {
    const seen: Array<RequestInit | undefined> = [];
    window.fetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof window.fetch;

    const teardown = installFetchWrap(() => {});
    const init: RequestInit = { method: "POST", headers: { "content-type": "x" } };
    await window.fetch("/x", init);

    expect(seen[0]).toBe(init); // exact same object, untouched
    teardown();
  });
});

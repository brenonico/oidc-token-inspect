import { beforeEach, describe, expect, it } from "vitest";
import {
  appendAnonymousRunId,
  getOrCreateAnonymousRunId,
} from "../anonymous";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fakeStorage(seed: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("getOrCreateAnonymousRunId", () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
  });

  it("GetOrCreate_ReadsExisting", () => {
    const existing = "11111111-2222-4333-8444-555555555555";
    storage = fakeStorage({ "oidc-ti:anon-id": existing });
    expect(getOrCreateAnonymousRunId(storage)).toBe(existing);
  });

  it("GetOrCreate_GeneratesOnFirstCall", () => {
    const id = getOrCreateAnonymousRunId(storage);
    expect(id).toMatch(UUID_V4);
    expect(storage.data["oidc-ti:anon-id"]).toBe(id);
  });

  it("GetOrCreate_PersistsAcrossCalls", () => {
    const first = getOrCreateAnonymousRunId(storage);
    const second = getOrCreateAnonymousRunId(storage);
    expect(second).toBe(first);
  });

  it("honours a custom storage key", () => {
    const id = getOrCreateAnonymousRunId(storage, "custom-key");
    expect(storage.data["custom-key"]).toBe(id);
    expect(storage.data["oidc-ti:anon-id"]).toBeUndefined();
  });
});

describe("appendAnonymousRunId", () => {
  const anon = "abcdef01-2345-4678-89ab-cdef01234567";

  it("AppendAnonymousRunId_AddsToCleanUrl", () => {
    expect(appendAnonymousRunId("https://app.test/login", anon)).toBe(
      `https://app.test/login?tii_anon=${anon}`,
    );
  });

  it("AppendAnonymousRunId_AppendsToExistingQueryString", () => {
    expect(appendAnonymousRunId("https://app.test/login?return=/home", anon)).toBe(
      `https://app.test/login?return=/home&tii_anon=${anon}`,
    );
  });

  it("AppendAnonymousRunId_DoesNotDoubleAppend", () => {
    const once = appendAnonymousRunId("https://app.test/login", anon);
    expect(appendAnonymousRunId(once, anon)).toBe(once);
  });

  it("preserves a fragment when appending", () => {
    expect(appendAnonymousRunId("https://app.test/login#top", anon)).toBe(
      `https://app.test/login?tii_anon=${anon}#top`,
    );
  });
});

describe("generated id", () => {
  it("Generated_Id_IsValidUuidV4", () => {
    const id = getOrCreateAnonymousRunId(fakeStorage());
    expect(id).toMatch(UUID_V4);
  });
});

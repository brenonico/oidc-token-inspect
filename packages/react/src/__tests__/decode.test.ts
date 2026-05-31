import { describe, it, expect } from "vitest";
import { decodeJwt, shortPreview } from "../decode";

describe("decodeJwt", () => {
  it("decodes header and payload of a JWT", () => {
    const t = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMiLCJzY29wZSI6ImEgYiJ9.x";
    const d = decodeJwt(t)!;
    expect(d.header.alg).toBe("none");
    expect(d.payload.sub).toBe("123");
  });

  it("returns null for non-JWT", () => {
    expect(decodeJwt("not-a-jwt")).toBeNull();
  });
});

describe("shortPreview", () => {
  it("truncates long values keeping head and tail", () => {
    expect(shortPreview("eyJhbGciOiJub25lIn0.payloadpart.signature")).toMatch(/^eyJ.*….*$/);
  });

  it("returns the original value if short enough", () => {
    expect(shortPreview("short")).toBe("short");
  });
});

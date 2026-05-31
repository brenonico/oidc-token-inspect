const DEFAULT_ANON_KEY = "oidc-ti:anon-id";
const ANON_PARAM = "tii_anon";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Read the persisted anonymous run id under `key`, generating and storing a new
 * UUID v4 on first call. Storage access is best-effort: a throwing backend
 * (disabled/quota/SSR) degrades to an in-memory id for the current call.
 */
export function getOrCreateAnonymousRunId(storage: StorageLike, key: string = DEFAULT_ANON_KEY): string {
  let existing: string | null = null;
  try {
    existing = storage.getItem(key);
  } catch {
    existing = null;
  }
  if (existing) return existing;

  const id = generateUuidV4();
  try {
    storage.setItem(key, id);
  } catch {
    // best-effort: an unwritable storage still yields a usable id this session
  }
  return id;
}

/**
 * Append `tii_anon=<id>` to a login URL, preserving any existing query string
 * and fragment. Idempotent: if the parameter is already present the URL is
 * returned unchanged. Works on relative and absolute URLs alike.
 */
export function appendAnonymousRunId(loginUrl: string, anonId: string): string {
  if (new RegExp(`[?&]${ANON_PARAM}=`).test(loginUrl)) return loginUrl;

  const hashAt = loginUrl.indexOf("#");
  const base = hashAt === -1 ? loginUrl : loginUrl.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : loginUrl.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${ANON_PARAM}=${encodeURIComponent(anonId)}${fragment}`;
}

/** RFC 4122 v4 UUID. Uses `crypto.randomUUID` when available, otherwise a
 * `getRandomValues`/`Math.random` fallback so the helper works in any runtime. */
export function generateUuidV4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export { DEFAULT_ANON_KEY, ANON_PARAM };

/**
 * Named config presets (spec §6). A preset applies SANE DEFAULTS for a given
 * architecture without ever overriding a value the user set explicitly.
 *
 * PRECEDENCE (critical, never violate):
 *
 *     defaultConfig  <  preset defaults  <  user's EXPLICIT config
 *
 * A preset is applied ON TOP OF `defaultConfig` (so it can flip a default
 * `false` to `true`), but the user's explicit config is applied LAST and always
 * wins — a preset never turns OFF something the user explicitly turned on, and
 * the user's explicit `false` overrides a preset's `true`.
 *
 * Presets are GENERIC architecture names — no Keycloak/Redis/host hardcoding.
 */
import type { TokenInspectConfig } from "./config";

/** The names a preset can be keyed by (mirrors `TokenInspectConfig.preset`). */
export type PresetName = NonNullable<TokenInspectConfig["preset"]>;

/** A recursive partial used to express the patch a preset contributes. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * Recursively merge `patch` onto `base`, returning a NEW object (inputs are not
 * mutated). Plain nested objects (e.g. `capabilities`, `correlation`) are merged
 * key-by-key; everything else (primitives, arrays) is replaced wholesale — an
 * explicit array in `patch` overrides the base array, it is not concatenated.
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined || patch === null) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    // Non-object base/patch: patch wins (covers primitives + arrays).
    return patch as unknown as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(patch as Record<string, unknown>)) {
    const patchVal = (patch as Record<string, unknown>)[key];
    if (patchVal === undefined) continue; // an absent key never clobbers the base
    const baseVal = (base as Record<string, unknown>)[key];
    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      out[key] = deepMerge(baseVal, patchVal as DeepPartial<unknown>);
    } else {
      out[key] = patchVal;
    }
  }
  return out as T;
}

/** True for a real `{}`-style object (not null, not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The patch each preset contributes ON TOP OF `defaultConfig`. Only the keys a
 * preset cares about are present — every other value is left at its default and
 * remains overridable by the user.
 */
export const presetPatches: Record<PresetName, DeepPartial<TokenInspectConfig>> = {
  // Public client SPA holds tokens in the browser: observe the client and scan
  // storage. No correlation header (the SPA isn't the one validating tokens).
  "public-client-spa": {
    capabilities: {
      clientObserver: true,
      storageScan: true,
      correlation: { enabled: false },
    },
  },
  // BFF / SessionManager: the SERVER records the flow, the browser only shows
  // the panel — so the client observer is OFF (the current BFF mode).
  "bff-sessionmanager": {
    capabilities: {
      clientObserver: false,
    },
  },
  // API validates the token: observe the client AND emit a same-origin
  // correlation header so the server lane can be merged with the client lane.
  "api-validates-token": {
    capabilities: {
      clientObserver: true,
      correlation: { enabled: true, allowlist: ["self"] },
    },
  },
};

/** A merge function per preset name (defaults applied to a given base config). */
export const presets: Record<PresetName, (base: TokenInspectConfig) => TokenInspectConfig> = {
  "public-client-spa": (base) => deepMerge(base, presetPatches["public-client-spa"]),
  "bff-sessionmanager": (base) => deepMerge(base, presetPatches["bff-sessionmanager"]),
  "api-validates-token": (base) => deepMerge(base, presetPatches["api-validates-token"]),
};

/**
 * Resolve the effective config from a base, an optional preset and the user's
 * EXPLICIT config, enforcing the precedence `base < preset < user`.
 *
 * The preset patch is applied to the base FIRST, then the user's explicit config
 * is deep-merged LAST so it always wins — including an explicit `false` over a
 * preset's `true`. `userConfig.preset` itself is preserved on the result.
 */
export function applyPreset(
  base: TokenInspectConfig,
  presetName: PresetName | undefined,
  userConfig?: DeepPartial<TokenInspectConfig>,
): TokenInspectConfig {
  const withPreset = presetName ? presets[presetName](base) : base;
  return userConfig ? deepMerge(withPreset, userConfig) : withPreset;
}

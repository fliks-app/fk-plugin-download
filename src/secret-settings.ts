/**
 * Mirrors `SECRETS_SET_KEY` from `@fliks/plugin-contract/ui` — a `process` plugin has no access to
 * that source at runtime, so the key is restated here. Core's provider list reads it to mask a
 * stored credential it never receives, and to offer erasing it.
 */
export const SECRETS_SET_KEY = 'secretsSet';

/** Strips the named credentials from a settings bag and reports which of them held a value. */
export function redactSecretSettings(
  settings: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out = { ...(settings ?? {}) };
  const set: string[] = [];
  for (const key of keys) {
    if (out[key]) set.push(key);
    delete out[key];
  }
  out[SECRETS_SET_KEY] = set;
  return out;
}

/**
 * Keeps each stored credential when the incoming one is blank or absent — a read never carries it
 * back, so blank cannot mean "erase". An explicit `null` does, the way JSON Merge Patch spells
 * removal. The read-only marker is dropped rather than persisted.
 */
export function mergeSecretSettings(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out = { ...incoming };
  delete out[SECRETS_SET_KEY];
  for (const key of keys) {
    if (out[key] === null) delete out[key];
    else if (!out[key]) {
      const stored = (existing ?? {})[key];
      if (stored) out[key] = stored;
      else delete out[key];
    }
  }
  return out;
}

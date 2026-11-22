import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

const TTL_MS = 60 * 60 * 1000;

// Per-isolate cache keyed by team domain. Failures are never stored.
const cache = new Map<string, { keys: HonoJsonWebKey[]; expiresAt: number }>();

export function clearAccessKeyCache(): void {
  cache.clear();
}

export async function fetchAccessKeys(teamDomain: string): Promise<HonoJsonWebKey[]> {
  const hit = cache.get(teamDomain);
  if (hit && hit.expiresAt > Date.now()) return hit.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`failed to fetch Access keys: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("invalid Access certs response: keys missing");

  const keys = body.keys as HonoJsonWebKey[];
  cache.set(teamDomain, { keys, expiresAt: Date.now() + TTL_MS });
  return keys;
}

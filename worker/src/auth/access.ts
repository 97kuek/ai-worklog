import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { type Authenticate, ConfigError } from "./identity";

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;

export function createAccessAuthenticator(
  getKeys: (teamDomain: string, opts?: { refresh?: boolean }) => Promise<HonoJsonWebKey[]>,
): Authenticate {
  return async (req, env) => {
    const teamDomain = env.ACCESS_TEAM_DOMAIN;
    const aud = env.ACCESS_AUD;
    // Never authenticate without the iss/aud checks.
    if (!nonEmpty(teamDomain) || !nonEmpty(aud)) {
      throw new ConfigError("ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set");
    }

    if (!TEAM_DOMAIN_PATTERN.test(teamDomain)) {
      throw new ConfigError("ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com");
    }

    const token = req.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;

    // Key fetch failures propagate (not an auth failure).
    let kid: string | undefined;
    try {
      kid = Jwt.decode(token).header.kid;
    } catch {
      return null;
    }

    let keys = await getKeys(teamDomain);
    // Signing keys may have rotated since the cache was filled: refetch once.
    if (!keys.some((k) => k.kid === kid)) keys = await getKeys(teamDomain, { refresh: true });

    let payload: Record<string, unknown>;
    try {
      payload = (await Jwt.verifyWithJwks(token, {
        keys,
        allowedAlgorithms: ["RS256"],
        verification: { iss: `https://${teamDomain}`, aud, iat: false },
      })) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (nonEmpty(payload.email)) return { kind: "user", email: payload.email.toLowerCase() };
    if (nonEmpty(payload.common_name)) return { kind: "machine", clientId: payload.common_name };
    return null;
  };
}

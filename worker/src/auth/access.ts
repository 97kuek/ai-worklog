import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { type Authenticate, ConfigError } from "./identity";

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function createAccessAuthenticator(
  getKeys: (teamDomain: string) => Promise<HonoJsonWebKey[]>,
): Authenticate {
  return async (req, env) => {
    const teamDomain = env.ACCESS_TEAM_DOMAIN;
    const aud = env.ACCESS_AUD;
    // Never authenticate without the iss/aud checks.
    if (!nonEmpty(teamDomain) || !nonEmpty(aud)) {
      throw new ConfigError("ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set");
    }

    const token = req.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;

    // Key fetch failures propagate (not an auth failure).
    const keys = await getKeys(teamDomain);

    let payload: Record<string, unknown>;
    try {
      payload = (await Jwt.verifyWithJwks(token, {
        keys,
        allowedAlgorithms: ["RS256"],
        verification: { iss: `https://${teamDomain}`, aud },
      })) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (nonEmpty(payload.email)) return { kind: "user", email: payload.email.toLowerCase() };
    if (nonEmpty(payload.common_name)) return { kind: "machine", clientId: payload.common_name };
    return null;
  };
}

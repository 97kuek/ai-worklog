import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { Jwt } from "hono/utils/jwt";

export async function makeKeyPair(kid: string): Promise<{
  publicJwk: HonoJsonWebKey;
  sign(payload: Record<string, unknown>): Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
    alg: "RS256",
  } as HonoJsonWebKey;
  const privateJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    kid,
    alg: "RS256",
  } as HonoJsonWebKey;
  return {
    publicJwk,
    // Jwt.sign puts kid in the header when the private JWK carries alg + kid.
    sign: (payload) => Jwt.sign(payload, privateJwk, "RS256"),
  };
}

export function accessClaims(extra: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://test-team.cloudflareaccess.com",
    aud: ["test-aud"],
    iat: now,
    exp: now + 3600,
    ...extra,
  };
}

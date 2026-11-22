import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccessAuthenticator } from "../src/auth/access";
import { ConfigError } from "../src/auth/identity";
import { clearAccessKeyCache, fetchAccessKeys } from "../src/auth/keys";
import { accessClaims, makeKeyPair } from "./helpers";

const HEADER = "Cf-Access-Jwt-Assertion";
const req = (token?: string) =>
  new Request("https://example.com/api", token ? { headers: { [HEADER]: token } } : {});

describe("createAccessAuthenticator", () => {
  it("accepts_a_user_token", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(accessClaims({ email: "Owner@Example.com", type: "app" }));
    expect(await auth(req(token), env)).toEqual({ kind: "user", email: "owner@example.com" });
  });

  it("accepts_a_service_token", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(accessClaims({ common_name: "abc.access", type: "app" }));
    expect(await auth(req(token), env)).toEqual({ kind: "machine", clientId: "abc.access" });
  });

  it("accepts_a_service_token_with_string_audience", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const claims = accessClaims({ common_name: "abc.access", type: "app", aud: "test-aud" });
    expect("nbf" in claims).toBe(false); // service tokens carry no nbf
    const token = await kp.sign(claims);
    expect(await auth(req(token), env)).toEqual({ kind: "machine", clientId: "abc.access" });
  });

  it("accepts_a_user_token_with_nbf", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const now = Math.floor(Date.now() / 1000);
    const token = await kp.sign(accessClaims({ email: "owner@example.com", nbf: now - 5 }));
    expect(await auth(req(token), env)).toEqual({ kind: "user", email: "owner@example.com" });
  });

  it("rejects_missing_header", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    expect(await auth(req(), env)).toBeNull();
  });

  it("rejects_wrong_audience", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(accessClaims({ email: "owner@example.com", aud: ["other-aud"] }));
    expect(await auth(req(token), env)).toBeNull();
  });

  it("rejects_wrong_issuer", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(
      accessClaims({ email: "owner@example.com", iss: "https://other.cloudflareaccess.com" }),
    );
    expect(await auth(req(token), env)).toBeNull();
  });

  it("rejects_expired_token", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const now = Math.floor(Date.now() / 1000);
    const token = await kp.sign(accessClaims({ email: "owner@example.com", exp: now - 60 }));
    expect(await auth(req(token), env)).toBeNull();
  });

  it("rejects_bad_signature", async () => {
    const good = await makeKeyPair("k1");
    const other = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [good.publicJwk]);
    const token = await other.sign(accessClaims({ email: "owner@example.com" }));
    expect(await auth(req(token), env)).toBeNull();
  });

  it("rejects_unknown_kid", async () => {
    const kp = await makeKeyPair("k1");
    const stranger = await makeKeyPair("not-listed");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await stranger.sign(accessClaims({ email: "owner@example.com" }));
    expect(await auth(req(token), env)).toBeNull();
  });

  it("rejects_token_without_identity", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(accessClaims({ type: "app" }));
    expect(await auth(req(token), env)).toBeNull();
  });

  it("prefers_email_when_both_present", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(
      accessClaims({ email: "owner@example.com", common_name: "abc.access" }),
    );
    expect(await auth(req(token), env)).toEqual({ kind: "user", email: "owner@example.com" });
  });

  it("throws_config_error_when_team_or_aud_is_empty", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => [kp.publicJwk]);
    const token = await kp.sign(accessClaims({ email: "owner@example.com" }));
    await expect(auth(req(token), { ...env, ACCESS_AUD: "" })).rejects.toBeInstanceOf(ConfigError);
    await expect(auth(req(token), { ...env, ACCESS_TEAM_DOMAIN: "" })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("propagates_key_fetch_failure", async () => {
    const kp = await makeKeyPair("k1");
    const auth = createAccessAuthenticator(async () => {
      throw new Error("keys unavailable");
    });
    const token = await kp.sign(accessClaims({ email: "owner@example.com" }));
    await expect(auth(req(token), env)).rejects.toThrow("keys unavailable");
  });
});

describe("fetchAccessKeys", () => {
  beforeEach(() => clearAccessKeyCache());
  afterEach(() => vi.restoreAllMocks());

  it("caches_keys_per_team_domain", async () => {
    const kp = await makeKeyPair("k1");
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ keys: [kp.publicJwk] }));
    const domain = "test-team.cloudflareaccess.com";
    expect(await fetchAccessKeys(domain)).toEqual([kp.publicJwk]);
    expect(await fetchAccessKeys(domain)).toEqual([kp.publicJwk]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toBe(`https://${domain}/cdn-cgi/access/certs`);
  });

  it("throws_and_does_not_cache_on_non_200", async () => {
    const kp = await makeKeyPair("k1");
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => new Response("nope", { status: 503 }))
      .mockImplementation(async () => Response.json({ keys: [kp.publicJwk] }));
    const domain = "test-team.cloudflareaccess.com";
    await expect(fetchAccessKeys(domain)).rejects.toThrow();
    expect(await fetchAccessKeys(domain)).toEqual([kp.publicJwk]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws_and_does_not_cache_on_network_error", async () => {
    const kp = await makeKeyPair("k1");
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        throw new TypeError("network down");
      })
      .mockImplementation(async () => Response.json({ keys: [kp.publicJwk] }));
    const domain = "test-team.cloudflareaccess.com";
    await expect(fetchAccessKeys(domain)).rejects.toThrow();
    expect(await fetchAccessKeys(domain)).toEqual([kp.publicJwk]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

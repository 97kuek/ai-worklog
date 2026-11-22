// Secrets are set per install (.dev.vars locally, `wrangler secret put` in
// production), not in wrangler.jsonc, so `wrangler types` does not know them.
interface AccessSecrets {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}

interface Env extends AccessSecrets {}

declare namespace Cloudflare {
  interface Env extends AccessSecrets {}
}

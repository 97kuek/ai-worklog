export type Identity = { kind: "user"; email: string } | { kind: "machine"; clientId: string };

/** null: could not authenticate (respond 401). throw: misconfiguration (respond 500). */
export type Authenticate = (req: Request, env: Env) => Promise<Identity | null>;

export class ConfigError extends Error {}

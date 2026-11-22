// Stable identifiers are shared across ingestion, usage reports and skill inventories.
export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export interface RateWindow {
  window_seconds: number;
  used_percentage: number;
  resets_at: number | null; // Unix seconds
}
export interface AccountUsage {
  provider: string;
  account: string;
  observed_at: number;
  sessions: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  cost_sessions: number;
  limits: (RateWindow & { observed_at: number })[];
}

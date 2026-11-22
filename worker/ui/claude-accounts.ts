export const CLAUDE_ACCOUNTS = ["p-claude", "w-claude"] as const;
export type ClaudeAccount = typeof CLAUDE_ACCOUNTS[number];
export const isClaudeAccount = (v: unknown): v is ClaudeAccount => CLAUDE_ACCOUNTS.some(account => account === v);
export const LIMIT_WINDOWS = ["five_hour", "seven_day"] as const;
export type LimitWindow = typeof LIMIT_WINDOWS[number];
export interface RateWindow {
  used_percentage: number;
  resets_at: number | null; // Claude reports epoch seconds.
}
export interface AccountUsage {
  account: ClaudeAccount;
  observed_at: number | null; // Collector observations use epoch milliseconds.
  sessions: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  cost_sessions: number;
  five_hour: (RateWindow & { observed_at: number }) | null;
  seven_day: (RateWindow & { observed_at: number }) | null;
}

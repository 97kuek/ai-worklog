import { duration } from "./activity.js";
import { el } from "./shared.js";
import { type AccountUsage } from "./accounts.js";

const counts = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const localTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function windowLabel(seconds: number) {
  for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"]] as const) {
    if (seconds % size === 0) return (seconds / size) + "-" + unit + " limit";
  }
  return seconds + "-second limit";
}
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function resetLabel(epochSeconds: number, now: number) {
  const reset = epochSeconds * 1000;
  return "Resets in " + duration(reset - now) + " (" + localTime.format(reset) + ")";
}

function metric(list: HTMLElement, label: string, value: string) {
  const row = el("div");
  row.append(el("dt", "", label), el("dd", "", value));
  list.append(row);
}

export function renderUsage(root: HTMLElement, accounts: AccountUsage[]) {
  const now = Date.now();
  const grid = el("div", "usage-accounts");
  for (const account of accounts) {
    const panel = el("section", "stats-chart usage-panel");
    panel.append(el("h2", "", account.account));
    panel.append(el("p", "usage-caption", account.provider === "claude" ? "Claude Code" : account.provider));
    const limits = el("div", "usage-limits");
    if (!account.limits.length) limits.append(el("p", "usage-caption", "No rate limits reported yet."));
    for (const limit of account.limits) {
      const label = windowLabel(limit.window_seconds);
      const expired = limit.resets_at !== null && limit.resets_at * 1000 <= now;
      const section = el("div");
      const heading = el("div", "stats-head");
      const remaining = !expired ? Math.max(0, 100 - limit.used_percentage) : null;
      heading.append(el("strong", "", label), el("span", "", remaining === null ? "Not reported" : percent.format(remaining) + "% left"));
      section.append(heading);
      if (remaining !== null) {
        const meter = el("progress");
        meter.max = 100;
        meter.value = remaining;
        meter.setAttribute("aria-label", label + " remaining");
        section.append(meter);
        section.append(el("div", "usage-caption", (limit.resets_at === null ? "" : resetLabel(limit.resets_at, now) + " · ")
          + "As of " + localTime.format(limit.observed_at)));
      } else if (expired) section.append(el("div", "usage-caption", "Window ended. Awaiting the next report."));
      limits.append(section);
    }
    const metrics = el("dl", "usage-metrics");
    metric(metrics, "Input tokens", account.input_tokens === null ? "—" : counts.format(account.input_tokens));
    metric(metrics, "Output tokens", account.output_tokens === null ? "—" : counts.format(account.output_tokens));
    metric(metrics, "Estimated cost", account.cost_usd === null ? "—" : money.format(account.cost_usd));
    panel.append(limits, el("h3", "", "Tracked sessions"), metrics);
    const coverage = account.cost_sessions < account.sessions ? " · Cost reported for " + counts.format(account.cost_sessions) : "";
    panel.append(el("p", "usage-caption", counts.format(account.sessions) + (account.sessions === 1 ? " session" : " sessions") + coverage),
      el("p", "usage-caption", "Last observation " + localTime.format(account.observed_at)));
    grid.append(panel);
  }
  if (!accounts.length) {
    root.replaceChildren(el("p", "empty-line", "No account usage reported yet."));
    return;
  }
  const note = el("p", "usage-caption", "Costs are session estimates in USD.");
  root.replaceChildren(grid, note);
}

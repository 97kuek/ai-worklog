import { el } from "./shared.js";
import { LIMIT_WINDOWS, type AccountUsage } from "./claude-accounts.js";

const counts = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const localTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const windowLabels = { five_hour: "5-hour limit", seven_day: "7-day limit" };
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function metric(list: HTMLElement, label: string, value: string) {
  const row = el("div");
  row.append(el("dt", "", label), el("dd", "", value));
  list.append(row);
}

export function renderClaudeUsage(root: HTMLElement, accounts: AccountUsage[]) {
  const grid = el("div", "usage-accounts");
  for (const account of accounts) {
    const panel = el("section", "stats-chart usage-panel");
    panel.append(el("h2", "", account.account));
    if (account.observed_at === null) {
      panel.append(el("p", "", "Waiting for the first usage report from this profile."));
      grid.append(panel);
      continue;
    }
    const limits = el("div", "usage-limits");
    for (const key of LIMIT_WINDOWS) {
      const limit = account[key];
      const expired = limit?.resets_at != null && limit.resets_at * 1000 <= Date.now();
      const section = el("div");
      const heading = el("div", "stats-head");
      const remaining = limit && !expired ? Math.max(0, 100 - limit.used_percentage) : null;
      heading.append(el("strong", "", windowLabels[key]), el("span", "", remaining === null ? "Not reported" : percent.format(remaining) + "% left"));
      section.append(heading);
      if (limit && remaining !== null) {
        const meter = el("progress");
        meter.max = 100;
        meter.value = remaining;
        meter.setAttribute("aria-label", windowLabels[key] + " remaining");
        section.append(meter);
        section.append(el("div", "usage-caption", (limit.resets_at === null ? "" : "Resets " + localTime.format(limit.resets_at * 1000) + " · ")
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
  root.replaceChildren(grid);
}

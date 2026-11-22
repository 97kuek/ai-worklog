import { duration, summarizeActivity } from "./activity.js";
import { el, engineName, type WeekData } from "./shared.js";

function hourLabel(hour: number) {
  return String(hour).padStart(2, "0") + ":00–" + String(hour + 1).padStart(2, "0") + ":00";
}

function chartCeiling(peakMs: number) {
  const peakMinutes = peakMs / 60_000;
  const step = [2, 10, 30, 60, 120, 240, 480, 720].find((minutes) => minutes >= peakMinutes);
  return (step ?? Math.ceil(peakMinutes / 240) * 240) * 60_000;
}

export function renderStats(root: HTMLElement, data: WeekData, start: Date, end: Date) {
  const stats = summarizeActivity(data, start, end);
  if (!stats.tasks.size) {
    root.replaceChildren(el("p", "stats-empty", "No work blocks recorded in this period."));
    return;
  }
  const chart = el("section", "stats-chart");
  const head = el("div", "stats-head");
  const title = el("h2", "", "Active time by hour");
  const total = el("div", "stats-total");
  total.append(el("strong", "", duration(stats.totalMs)));
  head.append(title, total);
  const ceiling = chartCeiling(Math.max(...stats.hours.map((h) => h.ms)));
  const plot = el("div", "stats-plot");
  const axis = el("div", "stats-axis");
  axis.setAttribute("aria-hidden", "true");
  for (const ms of [ceiling, ceiling / 2, 0]) axis.append(el("span", "", duration(ms)));
  const area = el("div", "stats-bars");
  area.setAttribute("role", "group");
  area.setAttribute("aria-label", "Active time by hour");
  const ticks = el("div", "stats-ticks");
  ticks.setAttribute("aria-hidden", "true");
  const bars = stats.hours.map((bucket, hour) => {
    const button = el("button", "stats-hour");
    button.type = "button";
    const label = hourLabel(hour) + ", " + duration(bucket.ms);
    button.title = label;
    button.setAttribute("aria-label", label);
    const bar = el("span", "stats-bar");
    bar.style.height = (100 * bucket.ms) / ceiling + "%";
    if (bucket.ms > 0) bar.classList.add("has-time");
    button.append(bar);
    button.onclick = () => selectHour(select.value === String(hour) ? "" : String(hour));
    area.append(button);
    ticks.append(el("span", "", hour % 3 === 0 || hour === 23 ? String(hour).padStart(2, "0") : ""));
    return button;
  });
  plot.append(axis, area, ticks);
  chart.append(head, plot);

  const models = el("section", "stats-models");
  const modelHead = el("div", "stats-head");
  const select = el("select");
  select.setAttribute("aria-label", "Filter model usage by hour");
  select.add(new Option("All hours", ""));
  for (let h = 0; h < 24; h++) select.add(new Option(hourLabel(h), String(h)));
  select.onchange = () => selectHour(select.value);
  const selection = el("span", "stats-selection");
  selection.setAttribute("role", "status");
  const controls = el("div", "stats-controls");
  controls.append(selection, select);
  modelHead.append(el("h2", "", "Model usage"), controls);
  const results = el("div", "stats-table-scroll");
  models.append(modelHead, results);
  function selectHour(value: string) {
    select.value = value;
    bars.forEach((button, i) => button.setAttribute("aria-pressed", String(value === String(i))));
    const bucket = value === "" ? undefined : stats.hours[Number(value)];
    selection.textContent = bucket ? duration(bucket.ms) : "";
    const counts = stats.modelCounts(bucket?.tasks ?? stats.tasks);
    if (!counts.length) {
      results.replaceChildren(el("p", "stats-empty-hour", "No work blocks recorded during this hour."));
      return;
    }
    const table = el("table", "stats-table");
    table.setAttribute("aria-label", "Models used by the selected tasks");
    const heading = table.createTHead().insertRow();
    for (const name of ["Engine", "Model", "Effort", "Tasks"]) {
      const th = el("th", "", name);
      th.scope = "col";
      heading.append(th);
    }
    const body = table.createTBody();
    for (const { tool, model, effort, count } of counts) {
      const row = body.insertRow();
      row.insertCell().textContent = engineName(tool);
      row.insertCell().textContent = model || "—";
      row.insertCell().textContent = effort ?? "—";
      row.insertCell().textContent = String(count);
    }
    results.replaceChildren(table);
  }
  selectHour(root.querySelector<HTMLSelectElement>(".stats-controls select")?.value ?? "");
  root.replaceChildren(chart, models);
}

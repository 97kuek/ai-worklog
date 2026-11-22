import { filterMenu } from "./filter-menu.js";
import { duration, summarizeActivity, type ActivityBucket, type ProjectKey } from "./activity.js";
import { addDays, dayLabel, el, engineName, weekday, type WeekData } from "./shared.js";

function clockMinute(minutes: number) {
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
}

const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" });

function chartCeiling(peakMs: number) {
  const peakMinutes = peakMs / 60_000;
  const step = [2, 10, 30, 60, 120, 240, 480, 720].find((minutes) => minutes >= peakMinutes);
  return (step ?? Math.ceil(peakMinutes / 240) * 240) * 60_000;
}

function projectName(key: ProjectKey) {
  return key ?? "Unassigned";
}

function rankedProjects(bucket: ActivityBucket) {
  return Array.from(bucket.projects).sort(([left, a], [right, b]) =>
    b.ms - a.ms || b.tasks.size - a.tasks.size || projectName(left).localeCompare(projectName(right)));
}

function projectTable(bucket: ActivityBucket) {
  if (!bucket.projects.size) return el("p", "stats-empty-hour", "No projects in this period.");
  const table = el("table", "stats-table project-table");
  table.setAttribute("aria-label", "Project activity");
  const header = table.createTHead().insertRow();
  for (const label of ["Project", "Active time", "Tasks"]) {
    const th = el("th", "", label);
    th.scope = "col";
    header.append(th);
  }
  const body = table.createTBody();
  for (const [key, entry] of rankedProjects(bucket)) {
    const row = body.insertRow();
    row.insertCell().textContent = projectName(key);
    row.insertCell().textContent = duration(entry.ms);
    row.insertCell().textContent = String(entry.tasks.size);
  }
  return table;
}

interface StatsOptions {
  weekly: boolean;
  weekProjects?: ProjectKey[];
  openDay: (date: Date, namedProjects: ProjectKey[]) => void;
}

export function renderStats(root: HTMLElement, data: WeekData, start: Date, end: Date, options: StatsOptions) {
  const stats = summarizeActivity(data, start, end);
  const ranked = rankedProjects(stats.period).map(([key]) => key);
  // Reserve the fourth treatment for the remainder when more than four projects are present.
  const named = options.weekProjects ?? ranked.slice(0, ranked.length > 4 ? 3 : 4);
  const series = named.map((key, index) => ({ name: projectName(key), keys: [key], style: index }));
  const rest = ranked.filter(key => !named.includes(key));
  if (rest.length) series.push({ name: "Other projects", keys: rest, style: 4 });

  const weekly = options.weekly;
  const chart = el("section", "stats-chart");
  const head = el("div", "stats-head");
  const title = el("h2", "", weekly ? "Active time by day" : "Active time by hour");
  const total = el("div", "stats-total");
  total.append(el("strong", "", duration(stats.totalMs)));
  head.append(title, total);
  const buckets = weekly ? stats.days : stats.hourlySlots.map(slot => slot.activity);
  const ceiling = weekly ? chartCeiling(Math.max(...buckets.map(b => b.ms))) : 3_600_000;
  const hourLabels = weekly
    ? stats.hours.map((_, hour) => clockMinute(hour * 60) + "–" + clockMinute((hour + 1) * 60))
    : stats.hourlySlots.map(({ from, to, hour }) => {
      const date = new Date(from);
      const minutes = hour * 60 + date.getMinutes();
      const range = clockMinute(minutes) + "–" + clockMinute(minutes + (to - from) / 60_000);
      if (stats.hourlySlots.filter(slot => slot.hour === hour).length === 1) return range;
      const offset = zone.formatToParts(date).find(part => part.type === "timeZoneName")!.value;
      return range + " " + offset;
    });
  const plot = el("div", weekly ? "stats-plot weekly-plot" : "stats-plot");
  const axis = el("div", "stats-axis");
  axis.setAttribute("aria-hidden", "true");
  for (const ms of [ceiling, ceiling / 2, 0]) axis.append(el("span", "", duration(ms)));
  const area = el("div", "stats-bars");
  area.setAttribute("role", "group");
  area.setAttribute("aria-label", title.textContent!);
  const ticks = el("div", "stats-ticks");
  ticks.setAttribute("aria-hidden", "true");
  if (!weekly) {
    area.style.gridTemplateColumns = ticks.style.gridTemplateColumns = `repeat(${buckets.length}, minmax(0, 1fr))`;
  }
  const bars = buckets.map((bucket, index) => {
    const button = el("button", "stats-hour");
    button.type = "button";
    const date = addDays(start, index);
    const label = [weekly ? dayLabel.format(date) : hourLabels[index], duration(bucket.ms)];
    const stack = el("span", "stats-stack");
    stack.style.height = (100 * bucket.ms / ceiling) + "%";
    for (const group of series) {
      const ms = group.keys.reduce((sum, key) => sum + (bucket.projects.get(key)?.ms ?? 0), 0);
      if (!ms) continue;
      const segment = el("span", "series-" + group.style);
      segment.style.height = (100 * ms / bucket.ms) + "%";
      stack.append(segment);
      label.push(group.name + " " + duration(ms));
    }
    button.title = label.join(" · ");
    button.setAttribute("aria-label", button.title);
    button.append(stack);
    if (weekly) {
      button.append(el("span", "stats-day-label", weekday.format(date)));
      button.onclick = () => options.openDay(date, named);
    } else {
      button.onclick = () => selectHour(select.trigger.value === String(index) ? "" : String(index));
      const hour = stats.hourlySlots[index]!.hour;
      ticks.append(el("span", "", hour % 3 === 0 || hour === 23 ? String(hour).padStart(2, "0") : ""));
    }
    area.append(button);
    return button;
  });
  plot.append(axis, area);
  if (!weekly) plot.append(ticks);
  const legend = el("ul", "stats-legend");
  legend.setAttribute("aria-label", "Projects in chart");
  for (const group of series) {
    if (!group.keys.some(key => stats.period.projects.has(key))) continue;
    const item = el("li");
    const swatch = el("span", "stats-swatch series-" + group.style);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, group.name);
    legend.append(item);
  }
  chart.append(head, plot);
  head.title = "Overlapping work counts once. Shared time is split equally between active projects.";
  if (legend.childElementCount) chart.append(legend);

  const projects = el("section", "stats-models");
  const projectHead = el("div", "stats-head");
  projectHead.append(el("h2", "", "Projects"));
  const projectResults = el("div");
  projects.append(projectHead, projectResults);

  const models = el("section", "stats-models");
  const modelHead = el("div", "stats-head");
  const hours: [string, string][] = hourLabels.map((label, i) => [String(i), label]);
  const select = filterMenu("stats-hour-filter", "Filter by hour", [["", "All hours"], ...hours],
    root.querySelector<HTMLButtonElement>("#stats-hour-filter")?.value ?? "", selectHour);
  const selection = el("span", "stats-selection");
  selection.setAttribute("role", "status");
  const controls = el("div", "stats-controls");
  controls.append(selection, select.root);
  projectHead.append(controls);
  modelHead.append(el("h2", "", "Model usage"));
  const results = el("div", "stats-table-scroll");
  models.append(modelHead, results);
  function selectHour(value: string) {
    select.setValue(value);
    if (!weekly) bars.forEach((button, i) => button.setAttribute("aria-pressed", String(value === String(i))));
    const bucket = value === "" ? undefined : (weekly ? stats.hours : buckets)[Number(value)];
    selection.textContent = bucket ? duration(bucket.ms) : "";
    const selected = bucket ?? stats.period;
    projectResults.replaceChildren(projectTable(selected));
    const counts = stats.modelCounts(selected.tasks);
    if (!counts.length) {
      results.replaceChildren(el("p", "stats-empty-hour", bucket ? "No work blocks in this hour." : "No work blocks in this period."));
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
  selectHour(select.trigger.value);
  root.replaceChildren(chart, projects, models);
}

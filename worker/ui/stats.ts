import { filterMenu } from "./filter-menu.js";
import { duration, summarizeActivity, type ActivityBucket, type ProjectKey } from "./activity.js";
import { addDays, dayLabel, dataTable, el, engineName, weekday, type WeekData } from "./shared.js";

function clockMinute(minutes: number) {
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
}

const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" });

function chartCeiling(peakMs: number) {
  const peakMinutes = peakMs / 60_000;
  const step = [2, 10, 30, 60, 120, 240, 480, 720].find((minutes) => minutes >= peakMinutes);
  return (step ?? Math.ceil(peakMinutes / 240) * 240) * 60_000;
}

function percentage(value: number, total: number) {
  if (!total) return "—";
  const percent = 100 * value / total;
  return percent > 0 && percent < 1 ? "<1%" : Math.round(percent) + "%";
}

function projectName(key: ProjectKey) {
  return key ?? "Unassigned";
}

function rankedProjects(bucket: ActivityBucket) {
  return Array.from(bucket.projects).sort(([left, a], [right, b]) =>
    b.ms - a.ms || b.tasks.size - a.tasks.size || projectName(left).localeCompare(projectName(right)));
}

interface ProjectSeries {
  name: string;
  keys: ProjectKey[];
  style: number;
}

function seriesTime(bucket: ActivityBucket, series: ProjectSeries) {
  return series.keys.reduce<number>((sum, key) => sum + (bucket.projects.get(key)?.ms ?? 0), 0);
}

function projectPie(bucket: ActivityBucket, series: ProjectSeries[]) {
  if (!bucket.ms) return el("p", "stats-empty-hour", "No active time in this period.");
  const pie = el("div", "project-pie");
  // The project table gives the exact values in reading order.
  pie.setAttribute("aria-hidden", "true");
  let elapsed = 0;
  for (const group of series) {
    const ms = seriesTime(bucket, group);
    if (!ms) continue;
    const start = elapsed / bucket.ms;
    elapsed += ms;
    const slice = el("span", "series-" + group.style);
    slice.style.maskImage = `conic-gradient(transparent 0 ${start}turn, black ${start}turn ${elapsed / bucket.ms}turn, transparent 0)`;
    pie.append(slice);
  }
  return pie;
}

function projectTable(bucket: ActivityBucket, series: ProjectSeries[]) {
  const table = dataTable("stats-table project-table", "Project activity", ["Project", "Active time", "Share", "Tasks"]);
  const body = table.createTBody();
  for (const [key, entry] of rankedProjects(bucket)) {
    const row = body.insertRow();
    const group = series.find(group => group.keys.includes(key))!;
    const swatch = el("span", "stats-swatch series-" + group.style);
    swatch.setAttribute("aria-hidden", "true");
    const name = el("span", "project-key");
    name.append(swatch, projectName(key));
    if (group.keys.length > 1 || group.style === 4) {
      name.title = group.name;
      name.setAttribute("aria-label", projectName(key) + " (" + group.name + ")");
    }
    row.insertCell().append(name);
    row.insertCell().textContent = duration(entry.ms);
    row.insertCell().textContent = percentage(entry.ms, bucket.ms);
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
  total.append(el("span", "", "Total"), el("strong", "", duration(stats.totalMs)));
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
  const gridLabels = [ceiling, ceiling / 2, 0].map(duration);
  for (const label of gridLabels) axis.append(el("span", "", label));
  const area = el("div", "stats-bars");
  area.setAttribute("role", "group");
  area.setAttribute("aria-label", title.textContent!);
  const ticks = el("div", "stats-ticks");
  ticks.setAttribute("aria-hidden", "true");
  if (!weekly) {
    area.style.gridTemplateColumns = ticks.style.gridTemplateColumns = `repeat(${buckets.length}, minmax(0, 1fr))`;
  }
  const now = Date.now();
  const bars = buckets.map((bucket, index) => {
    const button = el("button", "stats-hour");
    button.type = "button";
    const date = addDays(start, index);
    const from = weekly ? +date : stats.hourlySlots[index]!.from;
    const label = [weekly ? dayLabel.format(date) : hourLabels[index]];
    if (from > now) label.push("Upcoming");
    else label.push(duration(bucket.ms));
    const stack = el("span", "stats-stack");
    stack.style.height = (100 * bucket.ms / ceiling) + "%";
    for (const group of series) {
      const ms = seriesTime(bucket, group);
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

  const breakdown = el("section", "stats-models");
  const detailHead = el("div", "stats-head");
  const detailsTitle = el("h2", "", "Activity breakdown");
  const hours: [string, string][] = hourLabels.map((label, i) => [String(i), label]);
  const select = filterMenu("stats-hour-filter", "Filter breakdown by hour", [["", "All hours"], ...hours],
    root.querySelector<HTMLButtonElement>("#stats-hour-filter")?.value ?? "", selectHour);
  detailHead.append(detailsTitle, select.root);
  const selection = el("p", "stats-selection");
  selection.setAttribute("role", "status");
  const projects = el("section", "stats-detail");
  const projectResults = el("div", "project-share");
  projects.append(el("h3", "", "Project share of active time"), projectResults);
  const models = el("section", "stats-detail");
  const results = el("div", "stats-table-scroll");
  models.append(el("h3", "", "Model usage"), results);
  breakdown.append(detailHead, selection, projects, models);

  function selectHour(value: string) {
    select.setValue(value);
    if (!weekly) bars.forEach((button, i) => button.setAttribute("aria-pressed", String(value === String(i))));
    const bucket = value === "" ? undefined : (weekly ? stats.hours : buckets)[Number(value)];
    const selected = bucket ?? stats.period;
    const scope = weekly ? "across all days this week" : "on this day";
    const range = bucket ? hourLabels[Number(value)] : "All hours";
    selection.textContent = range + " " + scope + " · " + duration(selected.ms) + " active";
    projectResults.replaceChildren(projectPie(selected, series), ...(selected.projects.size ? [projectTable(selected, series)] : []));
    const counts = stats.modelCounts(selected.tasks);
    if (!counts.length) {
      results.replaceChildren(el("p", "stats-empty-hour", bucket ? "No work blocks in this hour." : "No work blocks in this period."));
      return;
    }
    const table = dataTable("stats-table", "Models used by the selected tasks", ["Engine", "Model", "Effort", "Tasks"]);
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
  root.replaceChildren(chart, breakdown);
}

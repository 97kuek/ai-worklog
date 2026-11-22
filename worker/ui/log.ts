import { filterMenu } from "./filter-menu.js";
import {
  addDays,
  statusText,
  blockTimeRange,
  countLabel,
  dayLabel,
  el,
  engineName,
  labels,
  localDate,
  stateOf,
  titleOf,
  weekday,
} from "./shared.js";
import type { Block, WeekData } from "./shared.js";

export interface LogFilters {
  day: number | null;
  status: string;
  newest: boolean;
}
export function renderLog(
  root: HTMLElement,
  data: WeekData,
  start: Date,
  filters: LogFilters,
  open: (id: string, block?: Block) => void,
) {
  const sessions = new Map(data.sessions.map((s) => [s.id, s]));
  const valid = data.blocks.filter((b) => sessions.has(b.session_id));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  function overlaps(b: Block, day: Date) {
    const begin = Date.parse(b.started_at),
      end = Date.parse(b.ended_at);
    return begin < +addDays(day, 1) && (end > +day || (end === begin && begin >= +day));
  }
  function draw(focus?: string) {
    const week = valid.filter((b) => days.some((day) => overlaps(b, day)));
    const matched = week.filter(
      (b) => !filters.status || stateOf(sessions.get(b.session_id)!) === filters.status,
    );
    const rows = matched.filter((b) => filters.day === null || overlaps(b, days[filters.day]!));
    rows.sort(
      (a, b) =>
        (Date.parse(a.started_at) - Date.parse(b.started_at)) * (filters.newest ? -1 : 1) ||
        a.session_id.localeCompare(b.session_id) ||
        a.seq - b.seq,
    );

    const strip = el("section", "week-strip");
    strip.setAttribute("aria-label", "Filter work blocks by day");
    const counts = days.map((d) => matched.filter((b) => overlaps(b, d)).length);
    const max = Math.max(1, ...counts);
    days.forEach((d, i) => {
      const button = el("button", "strip-day");
      button.id = "day-" + i;
      button.setAttribute("aria-pressed", String(filters.day === i));
      const count = countLabel(counts[i]!, "block");
      button.setAttribute("aria-label", filters.day === i
        ? "Clear filter for " + dayLabel.format(d)
        : "Filter by " + dayLabel.format(d) + ", " + count);
      if (localDate(d) === localDate(new Date())) button.classList.add("is-today");
      const top = el("span", "strip-top");
      top.append(
        el("span", "weekday", weekday.format(d)),
        el("span", "strip-date", String(d.getDate())),
      );
      const bar = el("span", "bar-track");
      const fill = el("span", "bar-fill");
      fill.style.width = (100 * counts[i]!) / max + "%";
      bar.append(fill);
      button.append(top, el("span", "strip-count", String(counts[i])), bar);
      button.onclick = () => {
        filters.day = filters.day === i ? null : i;
        draw(button.id);
      };
      strip.append(button);
    });

    const panel = el("section", "log-panel");
    const tools = el("div", "log-tools");
    const heading = el("div", "results-heading");
    heading.append(el("h2", "", "Work blocks"), el("span", "count", String(rows.length)));
    const options = el("div", "filters");
    const status = filterMenu("status-filter", "Filter by status", [["", "All statuses"], ...Object.entries(labels)],
      filters.status, value => {
        filters.status = value;
        draw("status-filter");
      });
    options.append(status.root);
    tools.append(heading, options);
    panel.append(tools);
    const table = el("table", "log-table");
    table.setAttribute("aria-label", "Work block log");
    const header = table.createTHead().insertRow();
    const sort = el("button", "sort-btn", "Start time");
    const arrow = el("img");
    arrow.src = filters.newest ? "/icons/lucide/arrow-down.svg" : "/icons/lucide/arrow-up.svg";
    arrow.alt = "";
    arrow.width = arrow.height = 18;
    sort.append(arrow);
    sort.id = "sort-date";
    sort.setAttribute(
      "aria-label",
      filters.newest ? "Sort by start time, oldest first" : "Sort by start time, newest first",
    );
    sort.onclick = () => {
      filters.newest = !filters.newest;
      draw(sort.id);
    };
    const dateHead = el("th");
    dateHead.scope = "col";
    dateHead.setAttribute("aria-sort", filters.newest ? "descending" : "ascending");
    dateHead.append(sort);
    for (const text of ["Task", "Status", "Project", "Engine"]) {
      const th = el("th", "", text);
      th.scope = "col";
      header.append(th);
    }
    header.append(dateHead);
    const tbody = table.createTBody();
    for (const b of rows) {
      const s = sessions.get(b.session_id)!;
      const row = tbody.insertRow();
      row.dataset.state = stateOf(s);
      const action = el("button", "task-link", titleOf(s));
      action.onclick = () => open(s.id, b);
      row.insertCell().append(action);
      row.insertCell().append(statusText(s));
      row.insertCell().textContent = s.project || "—";
      row.insertCell().textContent = engineName(s.tool);
      row.insertCell().append(blockTimeRange(b));
    }
    const scroll = el("div", "log-table-scroll");
    scroll.append(table);
    panel.append(scroll);
    if (!rows.length)
      panel.append(
        el(
          "p",
          "empty-line",
          week.length ? "No work blocks match these filters." : "No work blocks recorded this week.",
        ),
      );
    root.replaceChildren(strip, panel);
    if (focus) document.getElementById(focus)?.focus();
  }
  draw();
}

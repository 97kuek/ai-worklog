import { clockRanges } from "./local-time.js";
import { addDays, modelSettings, type WeekData } from "./shared.js";

export type ProjectKey = string | null;

interface ProjectActivity {
  ms: number;
  tasks: Set<string>;
}

export interface ActivityBucket extends ProjectActivity {
  projects: Map<ProjectKey, ProjectActivity>;
}

function bucket(): ActivityBucket {
  return { ms: 0, tasks: new Set(), projects: new Map() };
}

function projectEntry(bucket: ActivityBucket, project: ProjectKey) {
  let entry = bucket.projects.get(project);
  if (!entry) {
    entry = { ms: 0, tasks: new Set() };
    bucket.projects.set(project, entry);
  }
  return entry;
}

function combine(target: ActivityBucket, source: ActivityBucket) {
  target.ms += source.ms;
  for (const [project, activity] of source.projects) {
    const entry = projectEntry(target, project);
    entry.ms += activity.ms;
    for (const id of activity.tasks) {
      target.tasks.add(id);
      entry.tasks.add(id);
    }
  }
}

const hourMs = 3_600_000;

// Split at real local hour boundaries, including shortened or repeated hours on DST days.
function hourSlots(start: Date, end: Date) {
  const slots: { from: number; to: number; hour: number; day: number }[] = [];
  for (let day = start, index = 0; day < end; day = addDays(day, 1), index++) {
    for (const range of clockRanges(+day, +addDays(day, 1))) {
      let from = range.start;
      while (from < range.end) {
        const local = from - range.offset * 60_000;
        const next = (Math.floor(local / hourMs) + 1) * hourMs + range.offset * 60_000;
        const to = Math.min(next, range.end);
        slots.push({ from, to, hour: new Date(from).getHours(), day: index });
        from = to;
      }
    }
  }
  return slots;
}

export function summarizeActivity(data: WeekData, start: Date, end: Date) {
  const sessions = new Map(data.sessions.map((session) => [session.id, session]));
  const hours = Array.from({ length: 24 }, bucket);
  const days: ActivityBucket[] = [];
  for (let date = start; date < end; date = addDays(date, 1)) days.push(bucket());
  const period = bucket();
  const slots = hourSlots(start, end).map(slot => ({
    ...slot, activity: bucket(), edges: [] as { at: number; project: ProjectKey; delta: number }[],
  }));
  for (const block of data.blocks) {
    const session = sessions.get(block.session_id);
    if (!session) continue;
    const project = session.project?.trim() || null;
    const from = Date.parse(block.started_at);
    const to = Date.parse(block.ended_at);
    for (const slot of slots) {
      if (slot.from > to) break;
      const begin = Math.max(slot.from, from);
      const finish = Math.min(slot.to, to);
      const instant = from === to && slot.from <= from && from < slot.to;
      if (!(begin < finish) && !instant) continue;
      slot.activity.tasks.add(session.id);
      projectEntry(slot.activity, project).tasks.add(session.id);
      if (begin < finish) slot.edges.push({ at: begin, project, delta: 1 }, { at: finish, project, delta: -1 });
    }
  }
  for (const { activity, edges, from, day, hour } of slots) {
    // Split each occupied interval once, equally among distinct active projects.
    // Multiple blocks keep a project active until its last overlapping block ends.
    const active = new Map<ProjectKey, number>();
    let previous = from;
    for (const { at, project, delta } of edges.sort((a, b) => a.at - b.at)) {
      const elapsed = at - previous;
      if (elapsed > 0 && active.size) {
        activity.ms += elapsed;
        const share = elapsed / active.size;
        for (const key of active.keys()) activity.projects.get(key)!.ms += share;
      }
      const count = (active.get(project) ?? 0) + delta;
      if (count) active.set(project, count);
      else active.delete(project);
      previous = at;
    }
    combine(hours[hour]!, activity);
    combine(days[day]!, activity);
    combine(period, activity);
  }
  function modelCounts(ids: Set<string>) {
    const counts = new Map<string, { tool: string; model: string; effort: string | null; count: number }>();
    for (const id of ids) {
      const session = sessions.get(id)!;
      const settings = modelSettings(session);
      if (!settings.length) settings.push({ model: "", effort: null });
      for (const { model, effort } of settings) {
        const key = JSON.stringify([session.tool, model, effort]);
        const group = counts.get(key);
        if (group) group.count++;
        else counts.set(key, { tool: session.tool, model, effort, count: 1 });
      }
    }
    return Array.from(counts.values()).sort((a, b) =>
      b.count - a.count || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model) ||
      (a.effort ?? "").localeCompare(b.effort ?? ""),
    );
  }
  const hourlySlots = slots.map(({ from, to, hour, activity }) => ({ from, to, hour, activity }));
  return { hours, hourlySlots, days, period, tasks: period.tasks, modelCounts, totalMs: period.ms };
}

export function duration(ms: number) {
  if (ms > 0 && ms < 60_000) return "<1m";
  const minutes = Math.floor(Math.round(ms) / 60_000);
  const rest = minutes % 60;
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h" + (rest ? " " + rest + "m" : "");
}

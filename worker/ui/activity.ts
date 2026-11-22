import { clockRanges } from "./local-time.js";
import { addDays, modelSettings, type WeekData } from "./shared.js";

const hourMs = 3_600_000;

// Split at real local hour boundaries, including shortened or repeated hours on DST days.
function hourSlots(start: Date, end: Date) {
  const slots: { from: number; to: number; hour: number }[] = [];
  for (let day = start; day < end; day = addDays(day, 1)) {
    for (const range of clockRanges(+day, +addDays(day, 1))) {
      let from = range.start;
      while (from < range.end) {
        const local = from - range.offset * 60_000;
        const next = (Math.floor(local / hourMs) + 1) * hourMs + range.offset * 60_000;
        const to = Math.min(next, range.end);
        slots.push({ from, to, hour: new Date(from).getHours() });
        from = to;
      }
    }
  }
  return slots;
}

export function summarizeActivity(data: WeekData, start: Date, end: Date) {
  const sessions = new Map(data.sessions.map((session) => [session.id, session]));
  const hours = Array.from({ length: 24 }, () => ({ ms: 0, tasks: new Set<string>() }));
  const tasks = new Set<string>();
  const slots = hourSlots(start, end);
  for (const block of data.blocks) {
    const id = block.session_id;
    if (!sessions.has(id)) continue;
    const from = Date.parse(block.started_at);
    const to = Date.parse(block.ended_at);
    if (from === to && from >= +start && from < +end) {
      hours[new Date(from).getHours()]!.tasks.add(id);
      tasks.add(id);
      continue;
    }
    for (const slot of slots) {
      const ms = Math.min(to, slot.to) - Math.max(from, slot.from);
      if (!(ms > 0)) continue;
      const bucket = hours[slot.hour]!;
      bucket.ms += ms;
      bucket.tasks.add(id);
      tasks.add(id);
    }
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
  return { hours, tasks, modelCounts, totalMs: hours.reduce((sum, hour) => sum + hour.ms, 0) };
}

export function duration(ms: number) {
  if (ms > 0 && ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  const rest = minutes % 60;
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h" + (rest ? " " + rest + "m" : "");
}

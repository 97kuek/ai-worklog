export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}
export interface ModelEffort {
  model: string;
  effort: string | null;
}
export interface Session {
  id: string;
  title: string | null;
  manual_title?: string | null;
  tool: string;
  project: string | null;
  git_branch: string | null;
  models: string[];
  machine_name: string | null;
  invoked_by: string | null;
  observed_status?: { state: string; at: string };
  completed_at?: string | null;
  model_efforts?: ModelEffort[];
  started_at: string;
  ended_at: string;
  active_minutes: number;
  tokens: Tokens;
}
export interface Block {
  session_id: string;
  seq: number;
  started_at: string;
  ended_at: string;
  message_count: number;
  tokens: Tokens;
}
export interface WeekData {
  sessions: Session[];
  blocks: Block[];
}
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function titleOf(s: Session) {
  if (s.title?.trim()) return s.title.trim();
  const started = new Date(s.started_at);
  return "Task started " + monthDay.format(started) + " at " + clock.format(started);
}
export function countLabel(count: number, noun: string) {
  return count.toLocaleString("en-US") + " " + noun + (count === 1 ? "" : "s");
}
export function engineName(tool: string) {
  return ({ claude_code: "Claude Code", codex: "Codex" } as Record<string, string>)[tool] ?? tool;
}
// Older collectors only sent model names. Keep those rows visible with an unknown effort.
export function modelSettings(session: Session): ModelEffort[] {
  const pairs = new Map<string, ModelEffort>();
  const recorded = new Set<string>();
  for (const entry of session.model_efforts ?? []) {
    const model = entry.model.trim();
    if (!model) continue;
    const effort = entry.effort?.trim() || null;
    pairs.set(JSON.stringify([model, effort]), { model, effort });
    recorded.add(model);
  }
  for (const name of session.models) {
    const model = name.trim();
    if (model && !recorded.has(model)) pairs.set(JSON.stringify([model, null]), { model, effort: null });
  }
  return Array.from(pairs.values());
}
export function modelLabels(session: Session) {
  return modelSettings(session).map(({ model, effort }) => effort ? model + " (" + effort + ")" : model);
}
export function stateOf(s: Session) {
  return s.completed_at ? "completed" : (s.observed_status?.state ?? "unobserved");
}
export const labels: Record<string, string> = {
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  unknown: "Unknown",
  unobserved: "Unobserved",
};
export const statusLabel = (state: string) => labels[state] ?? labels.unknown!;
export function statusText(s: Session) {
  const state = stateOf(s);
  return el("span", "status-text s-" + (state in labels ? state : "unknown"), statusLabel(state));
}
export function addDays(d: Date, n: number) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}
export function sunday(d: Date) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(day, -day.getDay());
}
export function localDate(d: Date) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}
export const clock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
export const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });
export const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  weekday: "short",
});
export const fullDate = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Compact local dates shared by log rows and the detail block list. */
export function blockTimeRange(block: Block) {
  const start = new Date(block.started_at);
  const end = new Date(block.ended_at);
  const range = el("span", "time-range");
  const date = el("time", "range-date", monthDay.format(start));
  date.dateTime = block.started_at;
  const endDate = localDate(start) === localDate(end) ? "" : monthDay.format(end) + " ";
  if (endDate) range.classList.add("cross-day");
  const times = el("span", "range-clock", clock.format(start) + "–" + endDate + clock.format(end));
  range.append(date, " ", times);
  range.title = fullDate.format(start) + " – " + fullDate.format(end);
  return range;
}

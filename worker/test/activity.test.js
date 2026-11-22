import { summarizeActivity } from "../ui/activity";
import { addDays } from "../ui/shared";

const start = new Date(2026, 10, 22);
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);
function block(id, from, to) {
  return { session_id: id, started_at: from.toISOString(), ended_at: to.toISOString() };
}
const sessions = [
  { id: "a", tool: "codex", models: ["model A", "model B", "model B"] },
  { id: "b", tool: "codex", models: ["model B"] },
  { id: "c", tool: "unknown", models: [] },
];

it("begins the following reporting day at midnight when the starting day begins at 01:00", () => {
  // Some time zones advance clocks at midnight. The first valid instant then has hour 1.
  const day = at(22, 1);
  const next = addDays(day, 1);
  const blocks = [
    block("a", at(22, 23), at(23, 1)),
    block("b", at(23, 0), at(23, 0)),
  ];
  const stats = summarizeActivity({ sessions, blocks }, day, next);
  expect(next).toEqual(at(23, 0));
  expect(stats.hourlySlots).toHaveLength(23);
  expect(stats.totalMs).toBe(60 * 60000);
  expect([...stats.tasks]).toEqual(["a"]);
});

it("clips to the reporting day, merges concurrent tasks and counts unique model users", () => {
  const blocks = [
    block("a", at(21, 23, 50), at(22, 0, 15)),
    block("a", at(22, 0, 30), at(22, 1, 30)),
    block("b", at(22, 1), at(22, 1, 30)),
    block("c", at(22, 1, 59), at(22, 1, 59)),
    block("b", at(23, 0), at(23, 0)),
    block("b", at(21, 23), start),
  ];
  const s = summarizeActivity({ sessions, blocks }, start, at(23, 0));
  expect(s.hours[0].ms).toBe(45 * 60000);
  expect(s.hours[1].ms).toBe(30 * 60000);
  expect(s.totalMs).toBe(75 * 60000);
  expect(s.modelCounts(s.tasks)).toEqual([
    { tool: "codex", model: "model B", effort: null, count: 2 },
    { tool: "codex", model: "model A", effort: null, count: 1 },
    { tool: "unknown", model: "", effort: null, count: 1 },
  ]);
  expect(s.modelCounts(s.hours[0].tasks)).toEqual([
    { tool: "codex", model: "model A", effort: null, count: 1 },
    { tool: "codex", model: "model B", effort: null, count: 1 },
  ]);
});

it("combines the same hour across seven days and excludes the following week", () => {
  const blocks = [
    block("a", at(16, 9), at(16, 9, 10)),
    block("a", at(22, 9), at(22, 9, 15)),
    block("b", at(22, 23, 50), at(23, 0, 20)),
    block("c", at(23, 0), at(23, 0)),
  ];
  const s = summarizeActivity({ sessions, blocks }, at(16, 0), at(23, 0));
  expect(s.hours[9].ms).toBe(25 * 60000);
  expect(s.hours[23].ms).toBe(10 * 60000);
  expect(s.totalMs).toBe(35 * 60000);
  expect(s.modelCounts(s.tasks)).toEqual([
    { tool: "codex", model: "model B", effort: null, count: 2 },
    { tool: "codex", model: "model A", effort: null, count: 1 },
  ]);
});

it("keeps recorded engine, model and effort pairs distinct, counting each task once per pair", () => {
  const high = { model: "m", effort: "high" };
  const settings = [
    { id: "a", tool: "codex", models: ["m", "legacy"], model_efforts: [high, high, { model: "m", effort: "low" }] },
    { id: "b", tool: "codex", models: ["m"], model_efforts: [high] },
    { id: "c", tool: "claude_code", models: ["m"], model_efforts: [high] },
  ];
  const blocks = settings.map(({ id }) => block(id, at(22, 10), at(22, 11)));
  const stats = summarizeActivity({ sessions: settings, blocks }, start, at(23, 0));
  expect(stats.modelCounts(stats.hours[10].tasks)).toEqual([
    { tool: "codex", model: "m", effort: "high", count: 2 },
    { tool: "claude_code", model: "m", effort: "high", count: 1 },
    { tool: "codex", model: "legacy", effort: null, count: 1 },
    { tool: "codex", model: "m", effort: "low", count: 1 },
  ]);
});

it("groups clipped work by weekday and project and counts unique tasks in each scope", () => {
  const projects = [
    { ...sessions[0], project: "studio" }, { ...sessions[1], project: "studio" }, { ...sessions[2], project: null },
  ];
  const blocks = [
    block("a", at(21, 23), at(22, 1)),
    block("a", at(22, 23, 30), at(23, 0, 30)),
    block("b", at(22, 0), at(22, 0, 45)),
    block("c", at(23, 0), at(23, 0, 10)),
    block("c", at(24, 9), at(24, 9)),
    block("c", at(29, 0), at(29, 1)),
  ];
  const s = summarizeActivity({ sessions: projects, blocks }, start, at(29, 0));
  expect(s.days.map(day => day.ms / 60000)).toEqual([90, 30, 0, 0, 0, 0, 0]);
  expect(s.period.projects.get("studio")).toEqual({ ms: 115 * 60000, tasks: new Set(["a", "b"]) });
  expect(s.days[1].projects.get("studio").tasks.size).toBe(1);
  expect(s.days[2].projects.get(null)).toEqual({ ms: 0, tasks: new Set(["c"]) });
  expect(s.hours[0].projects.get(null).ms).toBe(5 * 60000);
  expect(s.days.reduce((sum, day) => sum + day.ms, 0)).toBe(s.totalMs);
});

it("splits only shared minutes across distinct projects even with duplicate or overlapping blocks", () => {
  const projects = [{ ...sessions[0], project: "A" }, { ...sessions[1], project: "A" }, { ...sessions[2], project: "B" }];
  const whole = block("a", at(22, 15), at(22, 16));
  const blocks = [whole, whole, block("b", at(22, 15, 10), at(22, 15, 55)), block("c", at(22, 15, 20), at(22, 15, 50))];
  const stats = summarizeActivity({ sessions: projects, blocks }, start, at(23, 0));
  for (const bucket of [stats.period, stats.days[0], stats.hours[15], stats.hourlySlots[15].activity]) {
    expect(bucket.ms).toBe(60 * 60000);
    expect(bucket.projects.get("A")).toEqual({ ms: 45 * 60000, tasks: new Set(["a", "b"]) });
    expect(bucket.projects.get("B")).toEqual({ ms: 15 * 60000, tasks: new Set(["c"]) });
  }
});

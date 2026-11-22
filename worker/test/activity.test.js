import { summarizeActivity } from "../ui/activity";

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

it("clips to the reporting day, sums concurrent tasks and counts unique model users", () => {
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
  expect(s.hours[1].ms).toBe(60 * 60000);
  expect(s.totalMs).toBe(105 * 60000);
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

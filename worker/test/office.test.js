import { assignDesks } from "../ui/office";
import { localDate, sunday } from "../ui/shared";

function task(id, state = "running", completed_at = null) {
  return { id, observed_status: state ? { state } : undefined, completed_at };
}

it("keeps only running tasks and preserves seats when the order of a poll changes", () => {
  const first = assignDesks(new Map(), [task("a"), task("b"), task("c")]);
  const next = assignDesks(first, [
    task("c"), task("d"), task("a"), task("b", "waiting"), task("e", "running", "2026-11-22"),
    task("f", null), task("g", "unknown"),
  ]);
  expect(next).toEqual(new Map([["a", 0], ["d", 1], ["c", 2]]));
});

it("moves employees from a closing room into vacant desks and empties all seats when work stops", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(String(i)));
  const first = assignDesks(new Map(), tasks);
  expect(new Set(first.values()).size).toBe(12);
  const remaining = assignDesks(first, tasks.slice(3));
  expect([...remaining.values()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(remaining.get("4")).toBe(4);
  expect(assignDesks(remaining, []).size).toBe(0);
});

it("opens Sunday as a new calendar week including across a month and year boundary", () => {
  for (const [day, expected] of [
    [new Date(2026, 10, 22, 23), "2026-11-22"],
    [new Date(2027, 0, 2, 14), "2026-12-27"],
    [new Date(2027, 0, 3, 1), "2027-01-03"],
  ]) {
    expect(localDate(sunday(day))).toBe(expected);
    expect(sunday(day).getHours()).toBe(0);
  }
});

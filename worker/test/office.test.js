import { Group, Vector3 } from "three";
import { OfficeEmployee } from "../ui/office-employee";
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

it("starts a new task with a rested employee when a colleague finishes in the same poll", () => {
  const assigned = assignDesks(new Map(), [task("first")]);
  const next = assignDesks(assigned, [task("first", "waiting"), task("second")]);
  expect(next).toEqual(new Map([["second", 1]]));
});

it("retains employee assignments across rooms and reuses vacant seats for new tasks", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(String(i)));
  const first = assignDesks(new Map(), tasks);
  expect(new Set(first.values()).size).toBe(12);
  const remaining = assignDesks(first, [tasks[10], tasks[11], task("new"), tasks[10]]);
  expect(remaining).toEqual(new Map([["10", 10], ["11", 11], ["new", 0]]));
  expect(assignDesks(remaining, []).size).toBe(0);
});

function employee(slot = 0) {
  const figure = new Group();
  for (const [name, position] of Object.entries({
    Head: [0, 1.32, 0.55], Arm: [0.218, 1.204, 0.541], Forearm: [0.284, 1.067, 0.382],
    Thigh: [0.124, 0.737, 0.557], Shin: [0.124, 0.735, 0.28], Foot: [0.124, 0.241, 0.209],
  })) {
    for (const side of name === "Head" ? [""] : ["_L", "_R"]) {
      const part = new Group();
      part.name = name + side;
      part.position.fromArray(position);
      if (side === "_L") part.position.x *= -1;
      figure.add(part);
    }
  }
  const x = [-2.88, -0.71, 1.46][slot];
  return new OfficeEmployee(figure, new Vector3(x, 0, -1.8), new Vector3(x, 0, 1), new Group(), slot);
}

it("keeps three residents drinking at rest and settles immediately for reduced motion", () => {
  for (const [slot, drink] of ["Coffee", "Tea", "Latte"].entries()) {
    const worker = employee(slot);
    worker.pose(0, 0, false, true);
    expect(worker.root.position.z).toBeCloseTo(-1.8);
    expect(worker.cup.name).toBe(drink);
    expect(worker.cup.getObjectByName("Handle")).toBeDefined();
    expect(worker.cup.rotation.x).toBeGreaterThan(0.1);
    worker.pose(0, 0, true, true);
    expect(worker.root.position.z).toBeCloseTo(1.557);
    expect(worker.root.position.y).toBeCloseTo(0);
    expect(worker.cup.position.y).toBeCloseTo(1.08);
    expect(worker.cup.rotation.x).toBe(0);
    worker.pose(0, 0, false, true);
    expect(worker.root.position.z).toBeCloseTo(-1.8);
    expect(worker.cup.position.y).toBeGreaterThan(1.25);
  }
});

it("sets down the drink, goes around the desks, types, and returns to the same cafe stool", () => {
  const worker = employee();
  const step = 1 / 24;
  let atRightAisle = false, behindDesks = false, movingLeg = false;
  for (let frame = 0; frame < 600; frame++) {
    worker.pose(step, frame * step, true, false);
    const pos = worker.root.position;
    if (frame === 23) {
      expect(worker.cup.position.y).toBeCloseTo(1.08);
      expect(pos.z).toBeCloseTo(-1.8);
    }
    if (pos.x > 3.5 && pos.z > 0) atRightAisle = true;
    if (atRightAisle && pos.z > 2.25 && pos.x < 0) behindDesks = true;
    const leg = worker.root.getObjectByName("Thigh_R");
    if (pos.z > -1.3 && leg.rotation.x < -0.2) movingLeg = true;
  }
  expect([atRightAisle, behindDesks, movingLeg]).toEqual([true, true, true]);
  expect(worker.root.position.toArray()).toEqual([-2.88, 0, 1.557]);
  const arm = worker.root.getObjectByName("Forearm_R");
  const lastAngle = arm.rotation.x;
  worker.pose(step, 30, true, false);
  expect(arm.rotation.x).not.toBe(lastAngle);
  for (let frame = 0; frame < 600; frame++) worker.pose(step, frame * step, false, false);
  expect(worker.root.position.x).toBeCloseTo(-2.88);
  expect(worker.root.position.z).toBeCloseTo(-1.8);
  expect(worker.cup.position.y).toBeGreaterThan(1.1);
});

it("changes direction during a walk without teleporting or replacing the employee", () => {
  const worker = employee();
  const root = worker.root;
  let time = 0;
  for (const [working, frames] of [[true, 95], [false, 25], [true, 65], [false, 500]]) {
    for (let frame = 0; frame < frames; frame++) {
      const last = root.position.clone(), facing = root.rotation.y;
      time += 1 / 24;
      worker.pose(1 / 24, time, working, false);
      expect(last.distanceTo(root.position)).toBeLessThan(0.085);
      expect(Math.abs(facing - root.rotation.y)).toBeLessThan(0.25);
      expect(root.visible).toBe(true);
    }
  }
  expect(worker.root).toBe(root);
  expect(root.position.z).toBeCloseTo(-1.8);
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

import example from "../../contract/ingest.example.json";
import { LIMITS, parseIngestPayload } from "../src/domain/ingest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = () => structuredClone(example) as any;

it("accepts the contract example and converts timestamps", () => {
  const r = parseIngestPayload(example);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.sessions).toHaveLength(2);
  expect(r.value.sessions[0].started_at).toBe(Date.UTC(2026, 10, 20, 1, 0, 0));
  expect(r.value.sessions[0].blocks[1].seq).toBe(1);
  expect(r.value.sessions[1].invoked_by).toBe("claude_code");
});

it("ignores unknown fields such as source_title", () => {
  const p = clone();
  p.sessions[0].source_title = "スレッド名";
  p.extra = 1;
  p.sessions[0].blocks[0].extra = 1;
  const r = parseIngestPayload(p);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect("source_title" in r.value.sessions[0]).toBe(false);
  expect("extra" in r.value).toBe(false);
  expect("extra" in r.value.sessions[0].blocks[0]).toBe(false);
});

it("exposes the limits", () => {
  expect(LIMITS).toEqual({ maxSessions: 50, maxBlocksTotal: 500, maxBodyBytes: 1_048_576 });
});

it("accepts RFC 3339 offsets and converts them to UTC", () => {
  const p = clone();
  p.sessions[0].started_at = "2026-11-20T10:00:00+09:00";
  const r = parseIngestPayload(p);
  expect(r.ok && r.value.sessions[0].started_at).toBe(Date.UTC(2026, 10, 20, 1, 0, 0));
});

it("counts code points, not UTF-16 units", () => {
  const p = clone();
  p.sessions[0].title = "😀".repeat(200);
  expect(parseIngestPayload(p).ok).toBe(true);
});

const session = (i: number) => {
  const s = clone().sessions[0];
  s.native_session_id = `s-${i}`;
  return s;
};

const cases: [string, (p: any) => void, string][] = [
  ["root is not an object", (p) => { p.__root = []; }, ""],
  ["machine_name empty", (p) => { p.machine_name = ""; }, "machine_name"],
  ["sessions empty", (p) => { p.sessions = []; }, "sessions"],
  ["51 sessions", (p) => { p.sessions = Array.from({ length: 51 }, (_, i) => session(i)); }, "sessions"],
  [
    "501 blocks in total",
    (p) => {
      p.sessions = Array.from({ length: 6 }, (_, i) => {
        const s = session(i);
        s.blocks = Array.from({ length: i < 5 ? 100 : 1 }, (_, j) => ({ ...clone().sessions[0].blocks[0], seq: j }));
        return s;
      });
    },
    "sessions",
  ],
  ["tool invalid", (p) => { p.sessions[0].tool = "Claude Code"; }, "sessions[0].tool"],
  ["native_session_id 129 chars", (p) => { p.sessions[0].native_session_id = "a".repeat(129); }, "sessions[0].native_session_id"],
  ["title 201 chars", (p) => { p.sessions[0].title = "a".repeat(201); }, "sessions[0].title"],
  ["cwd 1025 chars", (p) => { p.sessions[0].cwd = "a".repeat(1025); }, "sessions[0].cwd"],
  ["models 21 items", (p) => { p.sessions[0].models = Array.from({ length: 21 }, (_, i) => `m${i}`); }, "sessions[0].models"],
  ["started_at bad format", (p) => { p.sessions[0].started_at = "2026-11-20 01:00"; }, "sessions[0].started_at"],
  ["started_at after ended_at", (p) => { p.sessions[0].started_at = "2026-11-20T03:00:00.000Z"; }, "sessions[0].ended_at"],
  ["active_minutes negative", (p) => { p.sessions[0].active_minutes = -1; }, "sessions[0].active_minutes"],
  ["tokens.output negative", (p) => { p.sessions[0].tokens.output = -1; }, "sessions[0].tokens.output"],
  ["tokens.input fractional", (p) => { p.sessions[0].tokens.input = 1.5; }, "sessions[0].tokens.input"],
  ["blocks empty", (p) => { p.sessions[0].blocks = []; }, "sessions[0].blocks"],
  ["blocks[1].seq skips", (p) => { p.sessions[0].blocks[1].seq = 2; }, "sessions[0].blocks[1].seq"],
  ["blocks[0].message_count zero", (p) => { p.sessions[0].blocks[0].message_count = 0; }, "sessions[0].blocks[0].message_count"],
  ["block started_at after ended_at", (p) => { p.sessions[0].blocks[0].started_at = "2026-11-20T01:30:00.000Z"; }, "sessions[0].blocks[0].ended_at"],
  [
    "duplicate (tool, native_session_id)",
    (p) => { p.sessions[1].tool = p.sessions[0].tool; p.sessions[1].native_session_id = p.sessions[0].native_session_id; },
    "sessions[1].native_session_id",
  ],
];

it.each(cases)("rejects: %s", (_name, mutate, path) => {
  let p = clone();
  mutate(p);
  if ("__root" in p) p = p.__root;
  const r = parseIngestPayload(p);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.path).toBe(path);
  expect(r.message.length).toBeGreaterThan(0);
});

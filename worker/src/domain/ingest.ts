export type TokenCounts = { input: number; output: number; cache_read: number; cache_write: number };
export type IngestBlock = { seq: number; started_at: number; ended_at: number; message_count: number; tokens: TokenCounts };
export type IngestSession = {
  tool: string;
  native_session_id: string;
  title: string | null;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  models: string[];
  invoked_by: string | null;
  started_at: number;
  ended_at: number;
  active_minutes: number;
  tokens: TokenCounts;
  blocks: IngestBlock[];
};
export type IngestPayload = { machine_name: string; sessions: IngestSession[] };
export type ParseResult = { ok: true; value: IngestPayload } | { ok: false; path: string; message: string };

export const LIMITS = { maxSessions: 50, maxBlocksTotal: 500, maxBodyBytes: 1_048_576 } as const;

const IDENT = /^[a-z_]{1,32}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

class Invalid extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (path: string, message: string): never => {
  throw new Invalid(path, message);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const len = (s: string) => [...s].length;

function str(v: unknown, path: string, min: number, max: number): string {
  if (typeof v !== "string") return fail(path, "must be a string");
  const n = len(v);
  if (n < min || n > max) return fail(path, `must be ${min} to ${max} characters`);
  return v;
}

function nullableStr(v: unknown, path: string, max: number): string | null {
  return v === null ? null : str(v, path, 0, max);
}

function ident(v: unknown, path: string): string {
  if (typeof v !== "string" || !IDENT.test(v)) return fail(path, "must match ^[a-z_]{1,32}$");
  return v;
}

function timestamp(v: unknown, path: string): number {
  if (typeof v !== "string" || !RFC3339.test(v)) return fail(path, "must be an RFC 3339 timestamp");
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return fail(path, "must be a valid timestamp");
  return ms;
}

function count(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
    return fail(path, `must be an integer of at least ${min}`);
  }
  return v;
}

function tokens(v: unknown, path: string): TokenCounts {
  if (!isObject(v)) return fail(path, "must be an object");
  return {
    input: count(v.input, `${path}.input`, 0),
    output: count(v.output, `${path}.output`, 0),
    cache_read: count(v.cache_read, `${path}.cache_read`, 0),
    cache_write: count(v.cache_write, `${path}.cache_write`, 0),
  };
}

function timeRange(o: Record<string, unknown>, path: string): { started_at: number; ended_at: number } {
  const started_at = timestamp(o.started_at, `${path}.started_at`);
  const ended_at = timestamp(o.ended_at, `${path}.ended_at`);
  if (started_at > ended_at) return fail(`${path}.ended_at`, "must not be before started_at");
  return { started_at, ended_at };
}

function block(v: unknown, path: string, index: number): IngestBlock {
  if (!isObject(v)) return fail(path, "must be an object");
  const seq = count(v.seq, `${path}.seq`, 0);
  if (seq !== index) return fail(`${path}.seq`, `must be ${index} (sequential from 0)`);
  const range = timeRange(v, path);
  return {
    seq,
    ...range,
    message_count: count(v.message_count, `${path}.message_count`, 1),
    tokens: tokens(v.tokens, `${path}.tokens`),
  };
}

function session(v: unknown, path: string): IngestSession {
  if (!isObject(v)) return fail(path, "must be an object");
  const tool = ident(v.tool, `${path}.tool`);
  const native_session_id = str(v.native_session_id, `${path}.native_session_id`, 1, 128);
  const title = nullableStr(v.title, `${path}.title`, 200);
  const project = nullableStr(v.project, `${path}.project`, 200);
  const cwd = nullableStr(v.cwd, `${path}.cwd`, 1024);
  const git_branch = nullableStr(v.git_branch, `${path}.git_branch`, 256);

  if (!Array.isArray(v.models)) return fail(`${path}.models`, "must be an array");
  if (v.models.length > 20) return fail(`${path}.models`, "must have at most 20 items");
  const models = v.models.map((m, i) => str(m, `${path}.models[${i}]`, 0, 100));

  const invoked_by = v.invoked_by === null ? null : ident(v.invoked_by, `${path}.invoked_by`);
  const range = timeRange(v, path);

  const am = v.active_minutes;
  if (typeof am !== "number" || !Number.isFinite(am) || am < 0) {
    return fail(`${path}.active_minutes`, "must be a finite number of at least 0");
  }

  const sessionTokens = tokens(v.tokens, `${path}.tokens`);

  if (!Array.isArray(v.blocks) || v.blocks.length === 0) return fail(`${path}.blocks`, "must be a non-empty array");
  const blocks = v.blocks.map((b, i) => block(b, `${path}.blocks[${i}]`, i));

  return {
    tool,
    native_session_id,
    title,
    project,
    cwd,
    git_branch,
    models,
    invoked_by,
    ...range,
    active_minutes: am,
    tokens: sessionTokens,
    blocks,
  };
}

function parse(input: unknown): IngestPayload {
  if (!isObject(input)) return fail("", "must be an object");
  const machine_name = str(input.machine_name, "machine_name", 1, 100);

  const raw = input.sessions;
  if (!Array.isArray(raw)) return fail("sessions", "must be an array");
  if (raw.length < 1 || raw.length > LIMITS.maxSessions) {
    return fail("sessions", `must have 1 to ${LIMITS.maxSessions} sessions`);
  }
  let totalBlocks = 0;
  for (const s of raw) {
    if (isObject(s) && Array.isArray(s.blocks)) totalBlocks += s.blocks.length;
  }
  if (totalBlocks > LIMITS.maxBlocksTotal) {
    return fail("sessions", `must have at most ${LIMITS.maxBlocksTotal} blocks in total`);
  }

  const seen = new Set<string>();
  const sessions = raw.map((s, i) => {
    const parsed = session(s, `sessions[${i}]`);
    const key = JSON.stringify([parsed.tool, parsed.native_session_id]);
    if (seen.has(key)) return fail(`sessions[${i}].native_session_id`, "duplicate (tool, native_session_id)");
    seen.add(key);
    return parsed;
  });

  return { machine_name, sessions };
}

export function parseIngestPayload(input: unknown): ParseResult {
  try {
    return { ok: true, value: parse(input) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, message: e.message };
    throw e;
  }
}

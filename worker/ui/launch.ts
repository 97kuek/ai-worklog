export interface Launch {
  attempt_id: string;
  state: "pending" | "claimed" | "running" | "completed" | "failed";
  error?: string | null;
}

export type StartRequest = (id: string, attempt: string) => Promise<{ launch: Launch }>;

export const launchConflictMessages: Record<string, string> = {
  launch_conflict: "Another launch already exists. Refresh the board to see its status.",
  not_queued: "Move this request to Queued before starting it.",
  engine_required: "Edit the request and select an engine.",
  project_required: "Edit the request and select a project.",
  runner_unavailable: "No Mac is available for this project and engine. Check the project registration and make sure the Mac runner can find the engine.",
};

const failureMessages: Record<string, string> = {
  runner_timeout: "The Mac did not start this request in time. Check the runner is online before retrying.",
  invalid_project: "Check the project name and its registered folder on the Mac.",
  unsupported_engine: "Select an engine the Mac supports.",
  invalid_model: "Select a model supported by this engine or use its default.",
  invalid_effort: "Select an effort supported by this engine or use its default.",
  invalid_prompt: "Edit the request text before retrying.",
  provider_start_failed: "Check that the selected engine is installed and available to the Mac runner.",
  provider_failed: "The engine exited with an error. Check its configuration on the Mac before retrying.",
  runner_interrupted: "The runner was interrupted. Check the result on the Mac before retrying.",
};

export function failureMessage(error?: string | null) {
  return error ? failureMessages[error] ?? error : "Check the runner on your Mac before retrying.";
}

// Preserve the same start across a lost response or a reload in this tab.
const attempts = new Map<string, string>();
export function startAttempt(id: string, previous = "") {
  const key = "taskfolio.start." + id;
  let stored = attempts.get(key);
  try { stored ??= sessionStorage.getItem(key) ?? undefined; } catch { /* Storage may be unavailable. */ }
  const [prior, attempt] = stored?.split("/") ?? [];
  if (prior === previous && attempt) return attempt;
  const next = crypto.randomUUID();
  const entry = previous + "/" + next;
  attempts.set(key, entry);
  try { sessionStorage.setItem(key, entry); } catch { /* Keep the in-memory entry. */ }
  return next;
}

export function confirmAttempt(id: string) {
  const key = "taskfolio.start." + id;
  attempts.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

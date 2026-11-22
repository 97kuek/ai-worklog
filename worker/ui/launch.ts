export const queueWaitLabels = {
  waiting_for_mac: "Waiting for Mac",
  mac_busy: "Mac is busy",
  next_poll: "Waiting for next check-in",
  check_settings: "Check project and engine in Settings",
} as const;

export interface Launch {
  attempt_id: string;
  state: "pending" | "claimed" | "running" | "completed" | "failed";
  error?: string | null;
}

export const requestErrorMessages: Record<string, string> = {
  launch_conflict: "The Mac has already picked up this request. Refresh the board to see its status.",
  engine_required: "Edit this request and select an engine before queuing it.",
  project_required: "Select a project for this request.",
  project_unregistered: "Select a project registered on the Mac before queuing this request.",
  engine_unavailable: "The registered Mac does not support this engine for the selected project.",
};

const failureMessages: Record<string, string> = {
  runner_timeout: "The Mac did not start this request in time. Check the runner is online before retrying.",
  invalid_project: "Check the project name and its registered folder on the Mac.",
  project_disabled: "This working folder was paused before the task started. Enable it in Settings before retrying.",
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

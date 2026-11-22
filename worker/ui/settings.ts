import { el, engineName } from "./shared.js";

interface ConnectionTest {
  requested_at: number;
  acknowledged_at: number | null;
}

interface Machine {
  id: string;
  name: string;
  online: boolean;
  seen_at: number | null;
  engines: string[];
  projects: { key: string; enabled: boolean }[];
  connection_test: ConnectionTest | null;
}

export interface RunnerSettings { machines: Machine[] }

interface Actions {
  read(): Promise<RunnerSettings>;
  updateFolder(id: string, project: string, enabled: boolean): Promise<unknown>;
  test(id: string): Promise<{ requested_at: number }>;
}

const stamp = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const testWindow = 90_000;

function machinePanel(machine: Machine, actions: Actions, signal: AbortSignal) {
  const panel = el("section", "machine-panel");
  const header = el("div", "machine-header");
  const heading = el("div");
  const name = el("h2", "", machine.name);
  const status = el("p", "machine-status");
  const testButton = el("button", "small-button", "Test connection");
  testButton.type = "button";
  heading.append(name, status);
  header.append(heading, testButton);

  const testResult = el("p", "connection-result");
  testResult.setAttribute("role", "status");
  const engineList = el("dl", "engine-status");
  const showStatus = (m: Machine) => {
    status.textContent = m.seen_at === null ? "Runner has not connected yet"
      : (m.online ? "Online" : "Offline") + " · Last check-in " + stamp.format(m.seen_at);
    engineList.replaceChildren();
    for (const key of ["claude_code", "codex"]) {
      const available = m.engines.includes(key) ? "Available" : m.seen_at === null ? "Unknown" : "Unavailable";
      engineList.append(el("dt", "", engineName(key)), el("dd", "", available));
    }
  };
  showStatus(machine);
  panel.append(header, testResult);

  // A test succeeds only after the selected Mac polls again.
  let timer: number | undefined;
  signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
  const track = (probe: ConnectionTest) => {
    window.clearTimeout(timer);
    const waiting = probe.acknowledged_at === null && Date.now() - probe.requested_at < testWindow;
    testButton.disabled = waiting;
    if (probe.acknowledged_at !== null) {
      testResult.textContent = "Connection verified · " + stamp.format(probe.acknowledged_at);
    } else if (waiting) {
      testResult.textContent = "Waiting for this Mac to check in…";
      timer = window.setTimeout(async () => {
        try {
          const latest = (await actions.read()).machines.find(m => m.id === machine.id);
          if (signal.aborted) return;
          if (!latest) throw new Error("This Mac is no longer registered.");
          showStatus(latest);
          track(latest.connection_test ?? probe);
        } catch (error) {
          if (signal.aborted) return;
          testButton.disabled = false;
          testResult.textContent = error instanceof Error ? error.message : "Could not check the connection.";
        }
      }, 3000);
    } else {
      testResult.textContent = "No reply yet. A busy runner checks in after its current task. If idle, check that the Mac is awake.";
    }
  };
  if (machine.connection_test) track(machine.connection_test);
  testButton.onclick = async () => {
    testButton.disabled = true;
    try {
      const probe = await actions.test(machine.id);
      if (!signal.aborted) track({ requested_at: probe.requested_at, acknowledged_at: null });
    } catch (error) {
      if (signal.aborted) return;
      testButton.disabled = false;
      testResult.textContent = error instanceof Error ? error.message : "Could not start the connection test.";
    }
  };

  const folders = el("section", "settings-group");
  folders.append(el("h3", "", "Working folders"));
  if (!machine.projects.length) folders.append(el("p", "", "No folders registered on this Mac."));
  for (const project of machine.projects) {
    const row = el("label", "folder-row");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = project.enabled;
    toggle.setAttribute("role", "switch");
    const text = el("span", "", project.key);
    const error = el("p", "board-error");
    error.setAttribute("role", "alert");
    toggle.onchange = async () => {
      const enabled = toggle.checked;
      toggle.disabled = true;
      error.textContent = "";
      try {
        await actions.updateFolder(machine.id, project.key, enabled);
      } catch (reason) {
        toggle.checked = !enabled;
        error.textContent = reason instanceof Error ? reason.message : "Could not update this folder.";
      } finally {
        toggle.disabled = false;
      }
    };
    row.append(text, toggle);
    folders.append(row, error);
  }
  const engines = el("section", "settings-group");
  engines.append(el("h3", "", "Engines"), engineList);
  panel.append(folders, engines);
  return panel;
}

export function renderSettings(root: HTMLElement, settings: RunnerSettings, actions: Actions, signal: AbortSignal) {
  const layout = el("div", "runner-settings");
  if (!settings.machines.length) {
    layout.append(el("h2", "", "Connect your first Mac"), el("p", "", "Sign in to Taskfolio on your Mac and install its runner to enable requests from the Board."));
  }
  for (const m of settings.machines) layout.append(machinePanel(m, actions, signal));

  const guide = el("details", "settings-guide");
  guide.open = !settings.machines.some(m => m.projects.length);
  guide.append(el("summary", "", "Register a working folder"));
  guide.append(el("p", "", "On your Mac, run this command in Terminal and choose the folder to use."));
  guide.append(el("code", "", "~/.cargo/bin/taskfolio folder add"));
  guide.append(el("p", "", "After the next check-in, refresh Settings to see the folder. Its switch pauses or resumes queued work."));
  const docs = el("a", "", "Mac setup guide");
  docs.href = "https://github.com/97kuek/taskfolio#run-a-queued-request-on-your-mac";
  guide.append(docs);
  layout.append(guide);
  root.replaceChildren(layout);
}

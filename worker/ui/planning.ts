import { confirmAttempt, failureMessage, startAttempt, type StartRequest } from "./launch.js";
import { requestComposer, type RequestFields, type RequestState, type BoardRequest, type Stage } from "./request-composer.js";
import { countLabel, el, engineName, type Session } from "./shared.js";

export type { BoardRequest } from "./request-composer.js";
export type SaveRequest = (id: string, change: RequestFields | { stage: Stage } | (RequestState & { expected: RequestState })) => Promise<unknown>;

interface RequestLane {
  list: HTMLUListElement;
  countRequests: (count: number) => void;
}

function locked(item: BoardRequest) {
  return Boolean(item.launch && item.launch.state !== "failed");
}

function laneOf(item: BoardRequest) {
  const state = item.launch?.state;
  return state === "running" || state === "completed" ? state : item.stage;
}

export function planningLanes(requests: BoardRequest[], save: SaveRequest, sessions: Session[],
  start: StartRequest, activity: { running: RequestLane; completed: RequestLane }, runnerProjects: string[]) {
  let items = new Map(requests.map(item => [item.id, item]));
  const busy = new Set<string>();
  const errors = new Map<string, string>();
  let revision = 0;
  let dragged: string | undefined;
  function lane(stage: Stage, name: string) {
    const section = el("section", "board-lane board-" + stage);
    const heading = el("h2", "board-lane-heading", name);
    const count = el("span", "board-count");
    heading.append(count);
    const list = el("ul", "board-list");
    section.append(heading, list);
    section.ondragover = event => {
      if (dragged && items.get(dragged)?.stage !== stage) event.preventDefault();
    };
    section.ondrop = event => {
      event.preventDefault();
      if (dragged && items.get(dragged)?.stage !== stage) void move(dragged, stage);
      dragged = undefined;
    };
    function countRequests(n: number) {
      count.textContent = String(n);
      count.setAttribute("aria-label", countLabel(n, "request"));
    }
    return { section, list, countRequests };
  }
  const lanes = { backlog: lane("backlog", "Backlog"), queued: lane("queued", "Queued"), ...activity };
  function focusCard(id: string, control = "edit") {
    for (const { list } of Object.values(lanes)) {
      const card = list.querySelector<HTMLElement>('[data-request-id="' + CSS.escape(id) + '"]');
      if (card) {
        const button = card.querySelector<HTMLElement>('[data-control="' + control + '"]:not(:disabled)');
        if (!button) card.dataset.control = control;
        (button ?? card).focus({ preventScroll: true });
        break;
      }
    }
  }
  const composer = requestComposer(sessions, () => items.values(), async (id, fields, stage, original) => {
    busy.add(id);
    revision++;
    try {
      if (original) {
        const { id: _id, launch: _launch, ...expected } = original;
        await save(id, { ...fields, stage, expected });
      } else {
        await save(id, fields);
      }
      errors.delete(id);
      items.set(id, { ...original, ...fields, id, stage });
    } finally {
      busy.delete(id);
      revision++;
      draw();
    }
  }, focusCard, runnerProjects);
  lanes.backlog.list.before(composer.root);
  async function perform(item: BoardRequest, action: () => Promise<void>, fallback: string) {
    if (busy.has(item.id) || locked(item)) return;
    busy.add(item.id);
    revision++;
    errors.delete(item.id);
    draw();
    try {
      await action();
    } catch (e) {
      errors.set(item.id, e instanceof Error ? e.message : fallback);
    } finally {
      busy.delete(item.id);
      revision++;
      draw();
    }
  }
  async function move(id: string, stage: Stage) {
    const item = items.get(id);
    if (!item || item.stage === stage) return;
    await perform(item, async () => {
      await save(id, { stage });
      items.delete(id);
      items.set(id, { ...item, stage });
    }, "Could not move request.");
  }
  function startCard(item: BoardRequest) {
    return perform(item, async () => {
      const attempt = startAttempt(item.id, item.launch?.attempt_id);
      const { launch } = await start(item.id, attempt);
      items.set(item.id, { ...item, launch });
      confirmAttempt(item.id);
    }, "Could not start request.");
  }
  function requestCard(item: BoardRequest) {
    const card = el("li", "board-card request-card");
    card.dataset.requestId = item.id;
    card.tabIndex = -1;
    const readOnly = locked(item);
    const working = busy.has(item.id);
    const content = readOnly ? el("div", "request-card-content") : el("button", "request-card-button");
    if (content instanceof HTMLButtonElement) {
      content.type = "button";
      content.setAttribute("aria-label", "Edit request: " + item.title);
      content.setAttribute("aria-haspopup", "dialog");
      content.onclick = () => composer.edit(item);
      content.disabled = working;
      content.dataset.control = "edit";
      content.dataset.request = item.id;
    }
    content.append(el("span", "board-title", item.title));
    const settings = [item.engine && engineName(item.engine), item.model, item.effort].filter(Boolean);
    if (settings.length) content.append(el("span", "board-meta", settings.join(" · ")));
    if (item.project) content.append(el("span", "board-meta", item.project));
    card.append(content);
    card.draggable = !readOnly && !working;
    if (card.draggable) {
      card.ondragstart = event => {
        dragged = item.id;
        event.dataTransfer?.setData("text/plain", item.id);
      };
      card.ondragend = () => { dragged = undefined; };
    }
    if (working) card.setAttribute("aria-busy", "true");
    const state = item.launch?.state;
    const status = state === "pending" ? "Waiting for Mac" : state === "claimed" ? "Starting on Mac"
      : state === "failed" ? "Launch failed" : undefined;
    if (status) card.append(el("p", "request-status", status));
    if (state === "failed") card.append(el("p", "request-hint", failureMessage(item.launch?.error)));
    if (item.stage === "queued" && !readOnly) {
      const missing = [!item.project && "a project", !item.engine && "an engine"].filter(Boolean);
      const button = el("button", "small-button request-start", state === "failed" ? "Retry" : "Start");
      button.type = "button";
      button.dataset.control = "start";
      button.setAttribute("aria-label", button.textContent + " request: " + item.title);
      button.disabled = working || missing.length > 0;
      button.onclick = () => void startCard(item);
      card.append(button);
      if (missing.length) card.append(el("p", "request-hint", "Edit this request to select " + missing.join(" and ") + "."));
    }
    if (errors.has(item.id)) {
      const problem = el("p", "board-error", errors.get(item.id));
      problem.setAttribute("role", "alert");
      card.append(problem);
    }
    return card;
  }
  function draw() {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && Object.values(lanes).some(({ list }) => list.contains(active))
      ? active.closest<HTMLElement>("[data-request-id]") : null;
    for (const [stage, target] of Object.entries(lanes)) {
      const matches = Array.from(items.values()).filter(item => laneOf(item) === stage);
      target.countRequests(matches.length);
      target.list.replaceChildren(...matches.map(requestCard));
    }
    if (focused?.dataset.requestId && active instanceof HTMLElement) {
      focusCard(focused.dataset.requestId, active.dataset.control);
    }
  }
  async function refresh(read: () => Promise<BoardRequest[]>) {
    if (busy.size || dragged) return;
    const before = ++revision;
    const latest = await read();
    if (busy.size || dragged || before !== revision) return;
    if (JSON.stringify(latest) === JSON.stringify([...items.values()])) return;
    for (const item of latest) {
      if (items.get(item.id)?.launch?.attempt_id !== item.launch?.attempt_id) errors.delete(item.id);
    }
    items = new Map(latest.map(item => [item.id, item]));
    draw();
  }
  draw();
  return { sections: [lanes.backlog.section, lanes.queued.section], refresh };
}

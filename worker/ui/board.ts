import { planningLanes, type BoardRequest, type SaveRequest } from "./planning.js";
import { countLabel, el, engineName, stateOf, statusLabel, titleOf, type Session } from "./shared.js";

const lanes = ["running", "waiting", "completed"] as const;
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const pending = new WeakMap<HTMLElement, Map<string, Promise<void>>>();

function updateTime(session: Session): string {
  return session.completed_at ?? session.observed_status?.at ?? session.ended_at;
}

export function renderBoard(
  root: HTMLElement,
  sessions: Session[],
  open: (id: string) => void,
  complete: (id: string) => Promise<void>,
  plans: BoardRequest[],
  save: SaveRequest,
  runnerProjects: string[],
) {
  const requests = pending.get(root) ?? new Map<string, Promise<void>>();
  pending.set(root, requests);
  const sorted = [...sessions].sort(
    (a, b) => Date.parse(updateTime(b)) - Date.parse(updateTime(a)) || a.id.localeCompare(b.id),
  );
  const board = el("div", "worklog-board");
  const columns = el("div", "board-lanes");
  function requestLane() {
    return { list: el("ul", "board-list board-launched"), countRequests: (_count: number) => {} };
  }
  const activity = { running: requestLane(), completed: requestLane() };
  let dragged: (() => void) | undefined;
  function endDrag() {
    dragged = undefined;
    board.classList.remove("is-dragging");
  }

  for (const state of lanes) {
    const items = sorted.filter((session) => stateOf(session) === state);
    const lane = el("section", "board-lane board-" + state);
    const heading = el("h2", "board-lane-heading", statusLabel(state));
    const count = el("span", "board-count", String(items.length));
    count.setAttribute("aria-label", countLabel(items.length, "task"));
    heading.append(count);
    lane.append(heading);
    const list = el("ul", "board-list");
    for (const session of items) {
      const card = el("li", "board-card");
      const title = titleOf(session);
      const action = el("button", "board-title", title);
      action.type = "button";
      action.dataset.sessionId = session.id;
      action.onclick = () => open(session.id);
      const content = el("div", "board-content");
      const meta = el("div", "board-meta");
      const value = updateTime(session);
      meta.append(el("span", "", engineName(session.tool)));
      if (Number.isFinite(Date.parse(value))) {
        const time = el("time", "", dateFormat.format(new Date(value)));
        time.dateTime = value;
        time.title = state === "completed" ? "Completed at" : "Status last observed";
        meta.append(time);
      }
      content.append(action, meta);
      if (state === "waiting") {
        const error = el("p", "board-error");
        error.setAttribute("role", "alert");
        content.append(error);
        async function track(request: Promise<void>) {
          card.draggable = false;
          card.setAttribute("aria-busy", "true");
          error.textContent = "";
          try {
            await request;
          } catch (reason) {
            error.textContent = reason instanceof Error ? reason.message : "Could not mark this task complete.";
          } finally {
            if (requests.get(session.id) === request) requests.delete(session.id);
            card.draggable = true;
            card.removeAttribute("aria-busy");
          }
        }
        const submit = () => {
          if (requests.has(session.id)) return;
          const request = Promise.resolve().then(() => complete(session.id));
          requests.set(session.id, request);
          void track(request);
        };
        card.draggable = true;
        card.ondragstart = (event) => {
          if (!event.dataTransfer || requests.has(session.id)) return;
          dragged = submit;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", title);
          board.classList.add("is-dragging");
        };
        card.ondragend = endDrag;
        const existing = requests.get(session.id);
        if (existing) void track(existing);
      }
      card.append(content);
      list.append(card);
    }
    if (state !== "waiting") {
      activity[state].countRequests = n => {
        count.textContent = String(items.length + n);
        count.setAttribute("aria-label", countLabel(items.length + n, "task"));
      };
      lane.append(activity[state].list);
    }
    lane.append(list);
    if (state === "completed") {
      lane.ondragover = (event) => {
        if (!dragged || !event.dataTransfer) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      };
      lane.ondrop = (event) => {
        if (!dragged) return;
        event.preventDefault();
        dragged();
        endDrag();
      };
    }
    columns.append(lane);
  }
  const planning = planningLanes(plans, save, sessions, activity, runnerProjects);
  columns.prepend(...planning.sections);
  board.append(columns);
  root.replaceChildren(board);
  return planning.refresh;
}

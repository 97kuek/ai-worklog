import { completedBoardWindow } from "./board-retention.js";
import type { RequestOptions } from "./request-composer.js";
import { planningLanes, type BoardRequest, type SaveRequest } from "./planning.js";
import { countLabel, el, engineName, stateOf, statusLabel, titleOf, type Session } from "./shared.js";

type BoardSession = Pick<Session, "id" | "tool" | "title" | "started_at" | "ended_at" | "observed_status" | "completed_at">;
export interface BoardUpdates { sessions: BoardSession[]; requests: BoardRequest[] }

const states = ["running", "waiting", "completed"] as const;
type Lane = typeof states[number];
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const expandedMobileLanes = new Set(["Backlog", "Running"]);
const pending = new WeakMap<HTMLElement, Map<string, Promise<void>>>();

function updateTime(session: BoardSession): string {
  return session.completed_at ?? session.observed_status?.at ?? session.ended_at;
}

function sessionLane(state: Lane) {
  const section = el("section", "board-lane board-" + state);
  const heading = el("h2", "board-lane-heading", statusLabel(state));
  const count = el("span", "board-count");
  const sessions = el("ul", "board-list");
  const list = el("ul", "board-list board-launched");
  heading.append(count);
  if (state === "completed") heading.title = "Completed in the last 7 days";
  section.append(heading);
  if (state !== "waiting") section.append(list);
  section.append(sessions);
  function countRequests(n: number) {
    const total = sessions.childElementCount + n;
    if (count.textContent === String(total)) return;
    count.textContent = String(total);
    count.setAttribute("aria-label", countLabel(total, "task"));
  }
  return { section, list, sessions, countRequests };
}

export function renderBoard(
  root: HTMLElement, sessions: BoardSession[], open: (id: string) => void, complete: (id: string) => Promise<void>,
  plans: BoardRequest[], save: SaveRequest, readOptions: () => Promise<RequestOptions>,
) {
  const requests = pending.get(root) ?? new Map<string, Promise<void>>();
  pending.set(root, requests);
  const board = el("div", "worklog-board");
  const columns = el("div", "board-lanes");
  const lanes = { running: sessionLane("running"), waiting: sessionLane("waiting"), completed: sessionLane("completed") };
  let dragged: (() => void) | undefined;
  function endDrag() {
    dragged = undefined;
    board.classList.remove("is-dragging");
  }
  lanes.completed.section.ondragover = event => {
    if (!dragged || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  lanes.completed.section.ondrop = event => {
    if (!dragged) return;
    event.preventDefault();
    dragged();
    endDrag();
  };

  function sessionCard(id: string) {
    const card = el("li", "board-card");
    const action = el("button", "board-title");
    action.type = "button";
    action.dataset.sessionId = id;
    action.onclick = () => open(id);
    const content = el("div", "board-content");
    const meta = el("div", "board-meta");
    const engine = el("span");
    const time = el("time");
    const error = el("p", "board-error");
    error.setAttribute("role", "alert");
    meta.append(engine, time);
    content.append(action, meta, error);
    card.append(content);
    let waiting = false;
    async function track(request: Promise<void>) {
      card.draggable = false;
      card.setAttribute("aria-busy", "true");
      error.textContent = "";
      try {
        await request;
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : "Could not mark this task complete.";
      } finally {
        if (requests.get(id) === request) requests.delete(id);
        card.draggable = waiting;
        card.removeAttribute("aria-busy");
      }
    }
    card.ondragstart = event => {
      if (!waiting || !event.dataTransfer || requests.has(id)) return;
      dragged = () => {
        if (requests.has(id)) return;
        const promise = Promise.resolve().then(() => complete(id));
        requests.set(id, promise);
        void track(promise);
      };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", action.textContent ?? "");
      board.classList.add("is-dragging");
    };
    card.ondragend = endDrag;
    const existing = requests.get(id);
    if (existing) void track(existing);
    function update(session: BoardSession, state: Lane) {
      waiting = state === "waiting";
      card.draggable = waiting && !requests.has(id);
      const title = titleOf(session);
      if (action.textContent !== title) action.textContent = title;
      const name = engineName(session.tool);
      if (engine.textContent !== name) engine.textContent = name;
      const stamp = updateTime(session);
      if (time.dateTime !== stamp) {
        time.dateTime = stamp;
        time.hidden = !Number.isFinite(Date.parse(stamp));
        time.textContent = time.hidden ? "" : dateFormat.format(new Date(stamp));
      }
      time.title = state === "completed" ? "Completed at" : "Status last observed";
      if (!waiting) error.textContent = "";
    }
    return { card, update };
  }

  const cards = new Map<string, ReturnType<typeof sessionCard>>();
  let lastSessions: BoardSession[] = sessions;
  let nextExpiry = Infinity;
  function drawSessions(latest: BoardSession[]) {
    lastSessions = latest;
    nextExpiry = Infinity;
    const focused = document.activeElement;
    const cutoff = Date.now() - completedBoardWindow;
    const visible = new Set<string>();
    const ordered: Record<Lane, HTMLElement[]> = { running: [], waiting: [], completed: [] };
    for (const session of [...latest].sort((a, b) => Date.parse(updateTime(b)) - Date.parse(updateTime(a)) || a.id.localeCompare(b.id))) {
      const state = stateOf(session);
      if (state !== "running" && state !== "waiting" && state !== "completed") continue;
      if (state === "completed") {
        const stamp = Date.parse(updateTime(session));
        if (stamp <= cutoff) continue;
        nextExpiry = Math.min(nextExpiry, stamp + completedBoardWindow);
      }
      visible.add(session.id);
      const item = cards.get(session.id) ?? sessionCard(session.id);
      cards.set(session.id, item);
      item.update(session, state);
      ordered[state].push(item.card);
    }
    for (const [id, item] of cards) {
      if (visible.has(id)) continue;
      item.card.remove();
      cards.delete(id);
    }
    for (const state of states) {
      const list = lanes[state].sessions;
      ordered[state].forEach((card, i) => {
        const at = list.children.item(i);
        if (at !== card) list.insertBefore(card, at);
      });
    }
    // Count after moves between lists so neither lane counts a departing card.
    for (const lane of Object.values(lanes)) lane.countRequests(lane.list.childElementCount);
    if (focused instanceof HTMLElement && board.contains(focused) && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
  }
  drawSessions(sessions);
  const planning = planningLanes(plans, save, readOptions, { running: lanes.running, completed: lanes.completed });
  columns.append(...planning.sections, ...states.map(state => lanes[state].section));
  for (const section of columns.querySelectorAll<HTMLElement>(".board-lane")) {
    const heading = section.querySelector<HTMLElement>(".board-lane-heading")!;
    const name = heading.firstChild!.textContent!.trim();
    const toggle = el("button", "lane-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", name);
    const setExpanded = (open: boolean) => {
      toggle.setAttribute("aria-expanded", String(open));
      section.classList.toggle("lane-collapsed", !open);
    };
    setExpanded(expandedMobileLanes.has(name));
    toggle.onclick = () => {
      const open = !expandedMobileLanes.has(name);
      if (open) expandedMobileLanes.add(name);
      else expandedMobileLanes.delete(name);
      setExpanded(open);
    };
    heading.append(toggle);
  }
  board.append(columns);
  root.replaceChildren(board);
  return async (read: () => Promise<BoardUpdates>) => {
    if (!dragged && Date.now() >= nextExpiry) drawSessions(lastSessions);
    const snapshot = read();
    // Keep the planning mutation guard active across the network request.
    await Promise.all([
      planning.refresh(async () => (await snapshot).requests),
      snapshot.then(data => { if (!dragged) drawSessions(data.sessions); }),
    ]);
  };
}

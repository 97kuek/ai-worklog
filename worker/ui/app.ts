import { requestErrorMessages } from "./launch.js";
import type { RequestOptions } from "./request-composer.js";
import {
  addDays,
  el,
  localDate,
  sunday,
  type Block,
  type Session,
  type WeekData,
} from "./shared.js";
import { installDatePicker } from "./date-picker.js";
import { renderLog, type LogFilters } from "./log.js";
import { renderCalendar } from "./calendar.js";
import { renderBoard, type BoardUpdates } from "./board.js";
import { showTitle, editTaskTitle } from "./title-editor.js";
import { renderDetail } from "./detail.js";
import { renderUsage } from "./usage.js";
import type { AccountUsage } from "./accounts.js";
import { renderStats } from "./stats.js";
import { renderSettings, type RunnerSettings } from "./settings.js";
import { renderSkills, type Skill } from "./skills.js";

const pages = { log: "Work log", calendar: "Calendar", board: "Board", stats: "Activity", usage: "Usage", skills: "Skills", office: "Office", settings: "Settings" };
type View = keyof typeof pages;
function node<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
function route(): View {
  const hash = location.hash.slice(1);
  return Object.hasOwn(pages, hash) ? hash as View : "log";
}
let view = route();
let anchor = new Date();
anchor.setHours(0, 0, 0, 0);
let weekProjects: (string | null)[] | undefined;
let statsPeriod: "daily" | "weekly" = "daily";
function isDaily() {
  return view === "stats" && statsPeriod === "daily";
}
function rangeStart() {
  return isDaily() ? anchor : sunday(anchor);
}
const filters: LogFilters = { day: null, status: "", newest: true };
let request: AbortController | undefined;
let detailRequest: AbortController | undefined;
let officeModule: typeof import("./office.js") | undefined;
const LIVE_REFRESH_MS = 15_000;
const liveView = () => view === "office" || view === "usage";
let liveTimer: number | undefined;
function scheduleLiveRefresh() {
  window.clearTimeout(liveTimer);
  if (liveView() && !document.hidden) liveTimer = window.setTimeout(() => void load(), LIVE_REFRESH_MS);
}
let refreshBoard: ReturnType<typeof renderBoard> | undefined;
let refreshDetail: (() => Promise<void>) | undefined;
let pollingBoard: typeof refreshBoard;
let boardTimer: number | undefined;
function scheduleBoardRefresh() {
  window.clearTimeout(boardTimer);
  if (view === "board" && refreshBoard && !document.hidden)
    boardTimer = window.setTimeout(() => void pollBoard(), 5000);
}
async function pollBoard() {
  const refresh = refreshBoard;
  const signal = request?.signal;
  if (!refresh || pollingBoard === refresh || document.hidden) return;
  pollingBoard = refresh;
  try {
    void refreshDetail?.();
    await refresh(async () => {
      const data = await api<BoardUpdates>("/api/board/updates", { signal });
      if (refreshBoard === refresh && notice.dataset.boardOffline) {
        notice.textContent = "";
        delete notice.dataset.boardOffline;
      }
      return data;
    });
  } catch (e) {
    if (refreshBoard === refresh && !signal?.aborted) {
      notice.dataset.boardOffline = "true";
      notice.textContent = "Board updates paused. " + message(e);
    }
  } finally {
    if (pollingBoard === refresh) pollingBoard = undefined;
    if (refreshBoard === refresh && !signal?.aborted) scheduleBoardRefresh();
  }
}
let displayedScope: string | undefined;
const dialog = node<HTMLDialogElement>("detail");
const root = node("view"),
  notice = node("notice"),
  body = node("detail-body");
const focusMain = () => node("main").focus({ preventScroll: true });
let opener: HTMLElement | null = null;

async function apiResponse(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
    credentials: "same-origin",
  });
  if (res.status === 401 || res.status === 403 || res.redirected)
    throw new Error("Sign in and reload this page.");
  if (res.status === 400 || res.status === 409) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(requestErrorMessages[body?.error ?? ""] ?? (res.status === 409
      ? "This task has changed. Reopen it to see the latest version." : "The server could not accept this request."));
  }
  if (res.status === 404) throw new Error("Task not found.");
  if (res.status === 304) return res;
  if (!res.ok) throw new Error("Could not load records from the server.");
  if (!res.headers.get("content-type")?.includes("application/json"))
    throw new Error("Sign in and reload this page.");
  return res;
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await apiResponse(path, options)).json() as Promise<T>;
}
function message(e: unknown) {
  return e instanceof Error && e.name !== "TypeError"
    ? e.message
    : "Could not connect. Check your connection and try again.";
}
function errorBox(e: unknown, retry: () => void) {
  const box = el("div", "error-box");
  box.setAttribute("role", "alert");
  const btn = el("button", "small-button", "Retry");
  btn.onclick = retry;
  box.append(el("p", "", message(e)), btn);
  return box;
}
async function showDetail(id: string, block?: Block) {
  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  const heading = node("detail-heading");
  showTitle(heading, "Loading…");
  body.replaceChildren();
  if (!dialog.open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  }
  const content = el("div", "detail-content");
  const problem = el("p", "board-error");
  problem.setAttribute("role", "alert");
  const move = el("button", "small-button", "Move to Completed");
  move.hidden = true;
  body.append(content, move, problem);
  let completing = false;
  move.onclick = async () => {
    completing = true;
    move.disabled = true;
    try {
      await complete(id);
      if (!controller.signal.aborted) dialog.close();
    } catch (e) {
      problem.textContent = message(e);
    } finally {
      completing = false;
      move.disabled = false;
    }
  };
  const path = "/api/sessions/" + encodeURIComponent(id);
  let savedRevision = 0;
  async function saveTitle(value: string | null, expected: string | null) {
    const result = await api<{ session: Session }>(path + "/title", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: value, expected }),
    });
    savedRevision++;
    if (view === "board") void pollBoard();
    else void load();
    return result.session;
  }
  let busy = false;
  let tag: string | null = null;
  let current: Session | undefined;
  let titleVersion = "";
  async function update() {
    if (busy || controller.signal.aborted || !dialog.open) return;
    busy = true;
    const revision = savedRevision;
    try {
      const response = await apiResponse(path, {
        signal: controller.signal,
        headers: tag ? { "If-None-Match": tag } : {},
      });
      if (response.status !== 304) {
        const { session, blocks } = await response.json() as { session: Session; blocks: Block[] };
        if (controller.signal.aborted || !dialog.open) return;
        const expanded = content.querySelector("details")?.open;
        const focused = document.activeElement?.matches("summary") && content.contains(document.activeElement);
        renderDetail(content, session, blocks, block, view === "board");
        const details = content.querySelector("details");
        if (expanded && details) details.open = true;
        if (focused) details?.querySelector("summary")?.focus({ preventScroll: true });
        current = session;
        tag = response.headers.get("ETag");
        move.hidden = view !== "board" || session.observed_status?.state !== "waiting" || Boolean(session.completed_at);
      }
      if (controller.signal.aborted || !dialog.open || !current) return;
      const title = JSON.stringify([current.title, current.manual_title]);
      if (titleVersion !== title && savedRevision === revision && !heading.querySelector("form")) {
        editTaskTitle(heading, current, saveTitle);
        titleVersion = title;
      }
      if (!completing) move.disabled = false;
      if (problem.dataset.refreshError) {
        problem.textContent = "";
        delete problem.dataset.refreshError;
      }
    } catch (e) {
      if (controller.signal.aborted || !dialog.open) return;
      if (!current) {
        showTitle(heading, "Task details");
        content.replaceChildren(errorBox(e, () => void update()));
      } else {
        problem.dataset.refreshError = "true";
        problem.textContent = "Task updates paused. " + message(e);
        move.disabled = true;
      }
    } finally {
      busy = false;
    }
  }
  refreshDetail = view === "board" ? update : undefined;
  await update();
}
node("close").onclick = () => dialog.close();
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  refreshDetail = undefined;
  detailRequest?.abort();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  else focusMain();
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      dialog.close();
  }
});
async function complete(id: string) {
  try {
    await api("/api/sessions/" + encodeURIComponent(id) + "/complete", { method: "POST" });
  } catch (e) {
    throw new Error(message(e));
  }
  if (view === "board") await load("Task completed.");
}
function hasDateRange() {
  return view === "log" || view === "calendar" || view === "stats";
}
function syncHead() {
  document.title = pages[view] + " | Taskfolio";
  node("title").textContent = pages[view];
  for (const a of document.querySelectorAll<HTMLAnchorElement>("nav a, #open-settings")) {
    if (a.hash === "#" + view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  node("week-controls").hidden = !hasDateRange();
  node("stats-period").hidden = view !== "stats";
  for (const period of ["daily", "weekly"] as const) {
    node(period).setAttribute("aria-pressed", String(statsPeriod === period));
  }
  const daily = isDaily();
  node("prev").setAttribute("aria-label", daily ? "Previous day" : "Previous week");
  node("next").setAttribute("aria-label", daily ? "Next day" : "Next week");
  node("today").textContent = daily ? "Today" : "This week";
  node("date").setAttribute("aria-label", daily ? "Select day" : "Select week");
  const start = rangeStart();
  const end = addDays(start, 6);
  const label = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  const shortLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const fullRange = daily ? label.format(start) : label.formatRange(start, end);
  const compactLabel = start.getFullYear() === new Date().getFullYear() && end.getFullYear() === start.getFullYear()
    ? shortLabel
    : new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
  const compactRange = daily
    ? shortLabel.format(start) + "\n" + start.getFullYear()
    : compactLabel.format(start) + "\n– " + compactLabel.format(end);
  node("week-range").replaceChildren(el("span", "date-range-full", fullRange), el("span", "date-range-compact", compactRange));
  const dateInput = node<HTMLButtonElement>("date");
  dateInput.title = fullRange;
  dateInput.setAttribute("aria-description", fullRange);
}
async function load(done = "") {
  window.clearTimeout(liveTimer);
  window.clearTimeout(boardTimer);
  refreshBoard = undefined;
  delete notice.dataset.boardOffline;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  syncHead();
  const start = rangeStart();
  const end = addDays(start, isDaily() ? 1 : 7);
  const scope = !hasDateRange() ? view : view + localDate(start) + localDate(end);
  root.setAttribute("aria-busy", "true");
  if (displayedScope !== scope) {
    displayedScope = undefined;
    root.replaceChildren();
  }
  if (!(liveView() && displayedScope === scope)) notice.textContent = "Loading…";
  try {
    if (view === "office") {
      const [module, data] = await Promise.all([
        import("./office.js"),
        api<{ sessions: Session[] }>("/api/board?status=running", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      officeModule = module;
      const receipts = data.sessions.length ? undefined
        : await api<RunnerSettings>("/api/settings", { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted) return;
      module.renderOffice(root, data.sessions, showDetail, receipts);
    } else if (view === "usage") {
      const data = await api<{ accounts: AccountUsage[] }>("/api/usage", { signal: controller.signal });
      if (controller.signal.aborted) return;
      renderUsage(root, data.accounts);
    } else if (view === "settings") {
      const read = () => api<RunnerSettings>("/api/settings", { signal: controller.signal });
      const settings = await read();
      if (controller.signal.aborted) return;
      renderSettings(root, settings, {
        read,
        updateFolder: (id, project, enabled) => api("/api/settings/machines/" + encodeURIComponent(id) + "/project", {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, enabled }),
          signal: controller.signal,
        }),
        test: id => api("/api/settings/machines/" + encodeURIComponent(id) + "/test", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal,
        }),
      }, controller.signal);
    } else if (view === "skills") {
      const data = await api<{ skills: Skill[] }>("/api/skills", { signal: controller.signal });
      if (controller.signal.aborted) return;
      renderSkills(root, data.skills);
    } else if (view === "board") {
      const data = await api<BoardUpdates>("/api/board/updates", { signal: controller.signal });
      if (controller.signal.aborted) return;
      refreshBoard = renderBoard(root, data.sessions, showDetail, complete, data.requests ?? [], (id, change) =>
        api("/api/board/requests/" + encodeURIComponent(id), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change),
        }), () => api<RequestOptions>("/api/board/request-options", { signal: controller.signal }));
    } else {
      const q = new URLSearchParams({ from: start.toISOString(), to: end.toISOString() });
      const data = await api<WeekData>("/api/blocks?" + q, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (view === "calendar") renderCalendar(root, data.sessions, data.blocks, start, showDetail);
      else if (view === "stats") renderStats(root, data, start, end, {
        weekly: !isDaily(),
        weekProjects,
        openDay(date, projects) {
          statsPeriod = "daily";
          goDate(date, projects);
          node("daily").focus({ preventScroll: true });
        },
      });
      else renderLog(root, data, start, filters, showDetail);
    }
    displayedScope = scope;
    notice.textContent = done;
  } catch (e) {
    if (controller.signal.aborted) return;
    notice.textContent = "";
    const target = liveView() && displayedScope === scope ? notice : root;
    target.replaceChildren(errorBox(e, () => void load()));
  } finally {
    if (!controller.signal.aborted) {
      root.removeAttribute("aria-busy");
      scheduleLiveRefresh();
      scheduleBoardRefresh();
    }
  }
}
function goDate(d: Date, projects?: (string | null)[]) {
  weekProjects = projects;
  anchor = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  filters.day = null;
  void load();
}
node("prev").onclick = () => goDate(addDays(anchor, isDaily() ? -1 : -7));
node("next").onclick = () => goDate(addDays(anchor, isDaily() ? 1 : 7));
node("today").onclick = () => goDate(new Date());
for (const period of ["daily", "weekly"] as const) {
  node(period).onclick = () => {
    if (statsPeriod === period) return;
    weekProjects = undefined;
    statsPeriod = period;
    void load();
  };
}
const picker = installDatePicker(node<HTMLButtonElement>("date"), () => anchor, isDaily, goDate);
const menu = node<HTMLButtonElement>("nav-toggle");
const mast = menu.closest("header")!;
function toggleMenu(open: boolean) {
  menu.setAttribute("aria-expanded", String(open));
  mast.toggleAttribute("data-menu-open", open);
}
menu.onclick = () => toggleMenu(menu.getAttribute("aria-expanded") !== "true");
mast.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("nav a, #open-settings, .brand")) toggleMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) document.documentElement.dataset.input = "keyboard";
}, true);
document.addEventListener("pointerdown", (e) => {
  document.documentElement.dataset.input = "pointer";
  if (e.target instanceof Node && !mast.contains(e.target)) toggleMenu(false);
}, true);
mast.addEventListener("focusout", (e) => {
  if (!mast.contains(e.relatedTarget as Node | null)) toggleMenu(false);
});
mast.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    toggleMenu(false);
    menu.focus();
  }
});
window.matchMedia("(max-width: 1023px)").addEventListener("change", () => toggleMenu(false));
node("refresh").onclick = () => {
  if (menu.getAttribute("aria-expanded") === "true") {
    toggleMenu(false);
    menu.focus();
  }
  void load();
};
document.querySelector<HTMLAnchorElement>(".skip")?.addEventListener("click", (e) => {
  e.preventDefault();
  node("main").focus();
});
window.addEventListener("hashchange", () => {
  toggleMenu(false);
  if (view === "office" && route() !== "office") officeModule?.disposeOffice();
  view = route();
  if (dialog.open) dialog.close();
  if (picker.open) picker.close();
  void load();
  focusMain();
});
document.addEventListener("visibilitychange", () => {
  if (liveView()) {
    if (document.hidden) window.clearTimeout(liveTimer);
    else void load();
  } else if (view === "board") {
    window.clearTimeout(boardTimer);
    if (!document.hidden) void pollBoard();
  }
});
void load();

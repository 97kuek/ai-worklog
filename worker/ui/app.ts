import {
  addDays,
  el,
  localDate,
  sunday,
  type Block,
  type Session,
  type WeekData,
} from "./shared.js";
import { renderLog, type LogFilters } from "./log.js";
import { renderCalendar } from "./calendar.js";
import { renderBoard } from "./board.js";
import { showTitle, editTaskTitle } from "./title-editor.js";
import { renderDetail } from "./detail.js";
import { renderStats } from "./stats.js";
import { renderSkills, type Skill } from "./skills.js";

const pages = { log: "Work log", calendar: "Calendar", board: "Board", stats: "Activity", skills: "Skills", office: "Office" };
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
let officeTimer: number | undefined;
function scheduleOfficeRefresh() {
  window.clearTimeout(officeTimer);
  if (view === "office" && !document.hidden) officeTimer = window.setTimeout(() => void load(), 15000);
}
let displayedScope: string | undefined;
const dialog = node<HTMLDialogElement>("detail");
const root = node("view"),
  notice = node("notice"),
  body = node("detail-body");
const focusMain = () => node("main").focus({ preventScroll: true });
let opener: HTMLElement | null = null;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
    credentials: "same-origin",
  });
  if (res.status === 401 || res.status === 403 || res.redirected)
    throw new Error("Sign in and reload this page.");
  if (res.status === 409)
    throw new Error("This task has changed. Reopen it to see the latest version.");
  if (res.status === 404) throw new Error("Task not found.");
  if (!res.ok) throw new Error("Could not load records from the server.");
  if (!res.headers.get("content-type")?.includes("application/json"))
    throw new Error("Sign in and reload this page.");
  return res.json() as Promise<T>;
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
  try {
    const data = await api<{ session: Session; blocks: Block[] }>("/api/sessions/" + encodeURIComponent(id), {
      signal: controller.signal,
    });
    if (!controller.signal.aborted) {
      editTaskTitle(heading, data.session, async (value, expected) => {
        const result = await api<{ session: Session }>("/api/sessions/" + encodeURIComponent(id) + "/title", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: value, expected }),
        });
        void load();
        return result.session;
      });
      renderDetail(body, data.session, data.blocks, block);
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      showTitle(heading, "Task details");
      body.replaceChildren(errorBox(e, () => void showDetail(id, block)));
    }
  }
}
node("close").onclick = () => dialog.close();
dialog.addEventListener("close", () => {
  if (dialog.open) return;
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
function syncHead() {
  document.title = pages[view] + " | Taskfolio";
  node("title").textContent = pages[view];
  for (const a of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
    if (a.hash === "#" + view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  node("week-controls").hidden = view === "board" || view === "skills" || view === "office";
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
  const compactRange = daily ? label.format(start) : shortLabel.format(start) + "\n– " + shortLabel.format(end);
  const startDate = localDate(start);
  node("week-range").replaceChildren(el("span", "date-range-full", fullRange), el("span", "date-range-compact", compactRange));
  const dateInput = node<HTMLInputElement>("date");
  dateInput.value = startDate;
  dateInput.title = fullRange;
  dateInput.setAttribute("aria-description", fullRange);
}
async function load(done = "") {
  window.clearTimeout(officeTimer);
  request?.abort();
  const controller = new AbortController();
  request = controller;
  syncHead();
  const start = rangeStart();
  const end = addDays(start, isDaily() ? 1 : 7);
  const scope = view === "board" || view === "skills" || view === "office" ? view : view + localDate(start) + localDate(end);
  root.setAttribute("aria-busy", "true");
  if (displayedScope !== scope) {
    displayedScope = undefined;
    root.replaceChildren();
  }
  if (!(view === "office" && displayedScope === scope)) notice.textContent = "Loading…";
  try {
    if (view === "office") {
      const [module, data] = await Promise.all([
        import("./office.js"),
        api<{ sessions: Session[] }>("/api/board?status=running", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      officeModule = module;
      module.renderOffice(root, data.sessions, showDetail);
    } else if (view === "skills") {
      const data = await api<{ skills: Skill[] }>("/api/skills", { signal: controller.signal });
      if (controller.signal.aborted) return;
      renderSkills(root, data.skills);
    } else if (view === "board") {
      const data = await api<{ sessions: Session[] }>("/api/board", { signal: controller.signal });
      if (controller.signal.aborted) return;
      renderBoard(root, data.sessions, showDetail, complete);
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
    const target = view === "office" && displayedScope === scope ? notice : root;
    target.replaceChildren(errorBox(e, () => void load()));
  } finally {
    if (!controller.signal.aborted) {
      root.removeAttribute("aria-busy");
      scheduleOfficeRefresh();
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
const date = node<HTMLInputElement>("date");
date.onchange = () => {
  const [y, m, d] = date.value.split("-").map(Number);
  if (y && m && d) goDate(new Date(y, m - 1, d));
};
const menu = node<HTMLButtonElement>("nav-toggle");
const mast = menu.closest("header")!;
function toggleMenu(open: boolean) {
  menu.setAttribute("aria-expanded", String(open));
  mast.toggleAttribute("data-menu-open", open);
}
menu.onclick = () => toggleMenu(menu.getAttribute("aria-expanded") !== "true");
mast.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("nav a, .brand")) toggleMenu(false);
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
node("refresh").onclick = () => void load();
document.querySelector<HTMLAnchorElement>(".skip")?.addEventListener("click", (e) => {
  e.preventDefault();
  node("main").focus();
});
window.addEventListener("hashchange", () => {
  toggleMenu(false);
  if (view === "office" && route() !== "office") officeModule?.disposeOffice();
  view = route();
  if (dialog.open) dialog.close();
  void load();
  focusMain();
});
document.addEventListener("visibilitychange", () => {
  if (view !== "office") return;
  if (document.hidden) window.clearTimeout(officeTimer);
  else void load();
});
void load();

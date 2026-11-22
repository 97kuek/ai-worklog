import { el, engineName, modelSettings, titleOf, type Session } from "./shared.js";
import type { OfficeScene } from "./office-scene.js";

const desksPerRoom = 3;
type OpenTask = (id: string) => void;

function button(label: string, className: string, text: string) {
  const control = el("button", className, text);
  control.type = "button";
  control.setAttribute("aria-label", label);
  control.title = label;
  return control;
}

function isRunning(session: Session) {
  return session.observed_status?.state === "running" &&
    (!session.completed_at || Date.parse(session.observed_status.at) > Date.parse(session.completed_at));
}

// A running task stays with the same employee, even when another room goes on break.
export function assignDesks(previous: Map<string, number>, sessions: Session[], rooms = 1) {
  const running = new Set(sessions.filter(isRunning).map(session => session.id));
  const seats = new Map<string, number>();
  let capacity = Math.max(rooms * desksPerRoom, running.size);
  for (const [id, seat] of previous) {
    capacity = Math.max(capacity, seat + 1);
    if (running.has(id)) seats.set(id, seat);
  }
  if (seats.size === running.size) return seats;
  capacity = Math.ceil(capacity / desksPerRoom) * desksPerRoom;
  const busy = new Set(seats.values());
  const wasWorking = new Set(previous.values());
  const rested: number[] = [], released: number[] = [];
  for (let seat = 0; seat < capacity; seat++) {
    if (!busy.has(seat)) (wasWorking.has(seat) ? released : rested).push(seat);
  }
  for (const id of running) {
    if (seats.has(id)) continue;
    const available = rested.length ? rested : released;
    const index = Math.floor(Math.random() * available.length);
    seats.set(id, available[index]);
    available[index] = available[available.length - 1];
    available.pop();
  }
  return seats;
}

const storageKey = "taskfolio.office.seats.v1";
const storedSeatLimit = 600;
let rememberedSeats: Map<string, number> | undefined;

function resumeSeats(sessions: Session[]) {
  const active = new Set(sessions.filter(isRunning).map(session => session.id));
  if (rememberedSeats) return new Map([...rememberedSeats].filter(([id]) => active.has(id)));
  const seats = new Map<string, number>();
  const taken = new Set<number>();
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw || raw.length > storedSeatLimit * 160) return seats;
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > storedSeatLimit) return seats;
    for (const pair of entries) {
      if (!Array.isArray(pair)) continue;
      const [id, seat] = pair;
      if (!active.has(id) || seats.has(id) || !Number.isInteger(seat) || seat < 0 || seat >= storedSeatLimit || taken.has(seat)) continue;
      seats.set(id, seat);
      taken.add(seat);
    }
  } catch { /* Tab storage can be disabled. */ }
  return seats;
}

function rememberSeats(seats: Map<string, number>) {
  if (rememberedSeats?.size === seats.size && [...seats].every(([id, seat]) => rememberedSeats!.get(id) === seat)) return;
  rememberedSeats = seats;
  try {
    // Persist only the server's opaque session IDs and employee numbers for this tab.
    const entries = [...seats].filter(([id, seat]) => id.length <= 128 && seat < storedSeatLimit);
    if (entries.length) sessionStorage.setItem(storageKey, JSON.stringify(entries));
    else sessionStorage.removeItem(storageKey);
  } catch { /* Navigation still retains assignments in memory. */ }
}

class OfficeView {
  readonly layout = el("div", "office-layout");
  private readonly stage = el("div", "office-stage");
  private readonly viewport = el("div", "office-viewport");
  private readonly status = el("span", "office-scene-status", "Opening the office…");
  private readonly tip = el("span", "office-tooltip");
  private readonly tools = el("div", "office-camera-tools");
  private readonly list = el("ol", "office-desks");
  private readonly count = el("span", "office-count");
  private readonly summary = el("p", "office-summary");
  private readonly paging = el("div", "office-paging");
  private readonly roomLabel = el("span", "office-room-label");
  private readonly previous = button("Previous room", "office-control", "‹");
  private readonly next = button("Next room", "office-control", "›");
  private seats: Map<string, number>;
  private settleNextPoll = false;
  private tasks = new Map<string, Session>();
  private scene?: OfficeScene;
  private controller?: AbortController;
  private page = 0;
  private pages = 1;
  private open: OpenTask;
  private listSignature?: string;

  constructor(readonly root: HTMLElement, open: OpenTask, sessions: Session[]) {
    this.open = open;
    this.seats = resumeSeats(sessions);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    const scenePanel = el("div", "office-scene-panel");
    const sidebar = el("section", "office-roster");
    const rosterHead = el("div", "office-roster-head");
    const heading = el("h2", "", "At work");
    heading.id = "office-roster-heading";
    sidebar.setAttribute("aria-labelledby", heading.id);
    this.count.setAttribute("aria-live", "polite");
    this.count.setAttribute("aria-atomic", "true");
    this.status.setAttribute("role", "status");
    this.tip.hidden = true;
    this.tools.hidden = true;
    this.tools.setAttribute("role", "group");
    this.tools.setAttribute("aria-label", "Office camera");
    const out = button("Zoom out", "office-control", "−");
    const reset = button("Reset view", "office-reset", "Reset view");
    const zoom = button("Zoom in", "office-control", "+");
    out.onclick = () => this.scene?.zoomBy(1 / 1.2);
    zoom.onclick = () => this.scene?.zoomBy(1.2);
    reset.onclick = () => this.scene?.reset();
    this.tools.append(out, zoom, reset);
    this.previous.onclick = () => this.changeRoom(-1);
    this.next.onclick = () => this.changeRoom(1);
    this.paging.append(this.previous, this.roomLabel, this.next);
    this.stage.append(this.viewport, this.status, this.tip);
    const toolbar = el("div", "office-toolbar");
    const hint = el("span", "office-hint", "Drag to rotate");
    toolbar.append(hint, this.tools);
    scenePanel.append(this.stage, toolbar);
    rosterHead.append(heading, this.count);
    sidebar.append(rosterHead, this.summary, this.list, this.paging);
    this.layout.append(scenePanel, sidebar);
    this.root.replaceChildren(this.layout);
    void this.loadScene();
  }

  private async loadScene() {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const { OfficeScene } = await import("./office-scene.js");
      if (controller.signal.aborted) return;
      const scene = new OfficeScene(this.viewport,
        id => this.openFromScene(id),
        (id, x, y) => this.highlight(id, x, y),
        () => this.showSceneError(),
      );
      this.scene = scene;
      await scene.load(controller.signal);
      if (controller.signal.aborted) return;
      this.scene.setSeats(this.currentSeats(), this.page, true);
      this.status.hidden = true;
      this.tools.hidden = false;
      this.layout.dataset.scene = "ready";
    } catch {
      if (!controller.signal.aborted) this.showSceneError();
    }
  }

  private showSceneError() {
    this.controller?.abort();
    this.scene?.dispose();
    this.scene = undefined;
    this.tools.hidden = true;
    this.tip.hidden = true;
    this.layout.dataset.scene = "unavailable";
    this.status.textContent = "3D view unavailable.";
    this.status.hidden = false;
  }

  private openFromScene(id: string) {
    this.list.querySelector<HTMLButtonElement>('[data-session-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
    this.open(id);
  }

  private highlight(id?: string, x?: number, y?: number) {
    for (const row of this.list.querySelectorAll<HTMLElement>(".office-task")) {
      row.classList.toggle("is-highlighted", row.dataset.sessionId === id);
    }
    const task = id && this.tasks.get(id);
    this.tip.hidden = !task || x === undefined || y === undefined;
    if (task && !this.tip.hidden) {
      this.tip.textContent = titleOf(task);
      const maxLeft = this.stage.clientWidth - this.tip.offsetWidth - 8;
      this.tip.style.left = Math.max(8, Math.min(maxLeft, x! + 12)) + "px";
      this.tip.style.top = Math.max(8, Math.min(this.stage.clientHeight - this.tip.offsetHeight - 8, y! + 12)) + "px";
    }
  }

  private changeRoom(direction: number) {
    this.page = Math.max(0, Math.min(this.pages - 1, this.page + direction));
    this.draw();
    if (this.previous.disabled) this.next.focus();
    if (this.next.disabled) this.previous.focus();
  }

  update(sessions: Session[], open: OpenTask) {
    this.open = open;
    this.seats = assignDesks(this.seats, sessions, this.pages);
    rememberSeats(this.seats);
    this.tasks = new Map(sessions.filter(s => this.seats.has(s.id)).map(s => [s.id, s]));
    for (const seat of this.seats.values()) this.pages = Math.max(this.pages, Math.floor(seat / desksPerRoom) + 1);
    this.draw(this.settleNextPoll || document.hidden);
    this.settleNextPoll = document.hidden;
  }

  private currentSeats(): (string | undefined)[] {
    const ids = Array<string | undefined>(desksPerRoom).fill(undefined);
    const start = this.page * desksPerRoom;
    for (const [id, seat] of this.seats) {
      if (seat >= start && seat < start + desksPerRoom) ids[seat - start] = id;
    }
    return ids;
  }

  private visibilityChanged = () => {
    if (document.hidden) {
      this.settleNextPoll = true;
      this.scene?.setSeats(this.currentSeats(), this.page, true);
    }
  };

  private draw(settle = false) {
    const seats = this.currentSeats();
    const signature = JSON.stringify([this.page, seats.map(id => {
      const s = id && this.tasks.get(id);
      return s ? [id, titleOf(s), s.tool, s.models, s.model_efforts, s.active_minutes] : null;
    })]);
    const count = this.seats.size;
    if (this.count.textContent !== String(count)) {
      this.count.textContent = String(count);
      this.count.setAttribute("aria-label", count + (count === 1 ? " running task" : " running tasks"));
    }
    this.summary.textContent = count ? "No tasks running in this room." : "No tasks running.";
    this.summary.hidden = seats.some(Boolean);
    this.paging.hidden = this.pages < 2;
    this.roomLabel.textContent = "Room " + (this.page + 1) + " of " + this.pages;
    this.previous.disabled = this.page === 0;
    this.next.disabled = this.page === this.pages - 1;
    this.scene?.setSeats(seats, this.page, settle);
    if (signature === this.listSignature) return;
    this.listSignature = signature;
    const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.sessionId : undefined;
    this.highlight();
    this.list.replaceChildren();
    for (const [slot, id] of seats.entries()) {
      if (!id) continue;
      const task = this.tasks.get(id)!;
      const row = el("li");
      const action = el("button", "office-task");
      action.type = "button";
      action.dataset.sessionId = id;
      const deskNumber = this.page * desksPerRoom + slot + 1;
      const seat = el("span", "office-seat", String(deskNumber).padStart(2, "0"));
      seat.setAttribute("aria-label", "Desk " + deskNumber);
      const copy = el("span", "office-task-copy");
      copy.append(el("span", "office-task-title", titleOf(task)));
      const settings = modelSettings(task);
      for (const pair of settings.length ? settings : [{ model: "", effort: null }]) {
        const meta = el("span", "office-task-meta", [engineName(task.tool), pair.model || "—", "Effort " + (pair.effort ?? "—")].join(" · "));
        copy.append(meta);
      }
      const minutes = task.active_minutes;
      const elapsed = minutes > 0 && minutes < 1 ? "<1" : String(Math.floor(minutes));
      copy.append(el("span", "office-task-meta", elapsed + " min active"));
      action.append(seat, copy);
      action.onclick = () => this.open(id);
      action.onmouseenter = action.onfocus = () => this.scene?.select(id);
      action.onmouseleave = action.onblur = () => this.scene?.select();
      row.append(action);
      this.list.append(row);
    }
    if (focusedId) this.list.querySelector<HTMLButtonElement>('[data-session-id="' + CSS.escape(focusedId) + '"]')?.focus({ preventScroll: true });
  }

  dispose() {
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.controller?.abort();
    this.scene?.dispose();
    this.layout.remove();
  }
}

let mounted: OfficeView | undefined;

export function renderOffice(root: HTMLElement, sessions: Session[], open: OpenTask) {
  if (!mounted || mounted.root !== root || !root.contains(mounted.layout)) {
    disposeOffice();
    mounted = new OfficeView(root, open, sessions);
  }
  mounted.update(sessions, open);
}

export function disposeOffice() {
  mounted?.dispose();
  mounted = undefined;
}

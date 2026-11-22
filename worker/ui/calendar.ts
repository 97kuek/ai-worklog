import { clockRanges } from "./local-time.js";
import { dayLabel, weekday, el, engineName, modelLabels, stateOf, statusLabel, titleOf, type Block, type Session } from "./shared.js";

const dayMinutes = 24 * 60;
const minimumMinutes = 18;
const minuteMs = 60_000;

type Piece = { block: Block; session: Session; from: number; to: number; top: number; bottom: number; lane: number; lanes: number };
type OpenBlock = (id: string, block: Block) => void;
type CalendarPosition = { week: number; selected: number; scroll: number };
const positions = new WeakMap<HTMLElement, CalendarPosition>();

function clock(minute: number): string {
  const value = Math.floor(minute);
  return String(Math.floor(value / 60)).padStart(2, "0") + ":" + String(value % 60).padStart(2, "0");
}

// Use local calendar arithmetic: a day containing a clock change may be 23 or 25 hours.
function dayAt(start: Date, index: number): Date {
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
}

function layoutDay(date: Date, next: Date, entries: { block: Block; session: Session; start: number; end: number }[]): Piece[] {
  const midnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const pieces: Piece[] = [];
  for (const range of clockRanges(+date, +next)) {
    for (const entry of entries) {
      const start = Math.max(range.start, entry.start);
      const end = Math.min(range.end, entry.end);
      const point = entry.start === entry.end && entry.start >= range.start && entry.start < range.end;
      if (end <= start && !point) continue;
      const from = (start - midnight) / minuteMs - range.offset;
      const to = (end - midnight) / minuteMs - range.offset;
      // Keep the entire hit target inside the column, including points at 23:59.
      const top = Math.min(from, dayMinutes - minimumMinutes);
      const bottom = Math.max(to, top + minimumMinutes);
      pieces.push({ block: entry.block, session: entry.session, from, to, top, bottom, lane: 0, lanes: 1 });
    }
  }
  pieces.sort((a, b) => a.top - b.top || a.from - b.from || b.bottom - a.bottom || a.block.seq - b.block.seq);
  let group: Piece[] = [];
  let laneEnds: number[] = [];
  let groupEnd = 0;
  const finishGroup = () => {
    for (const piece of group) piece.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const piece of pieces) {
    if (piece.top >= groupEnd) finishGroup();
    let lane = laneEnds.findIndex(end => end <= piece.top);
    if (lane === -1) lane = laneEnds.length;
    piece.lane = lane;
    laneEnds[lane] = piece.bottom;
    group.push(piece);
    groupEnd = Math.max(groupEnd, piece.bottom);
  }
  finishGroup();
  return pieces;
}

function blockButton(piece: Piece, date: Date, open: OpenBlock): HTMLButtonElement {
  const { block, session } = piece;
  const title = titleOf(session);
  const state = stateOf(session);
  const time = piece.from === piece.to ? clock(piece.from) : clock(piece.from) + "–" + clock(piece.to);
  const engine = engineName(session.tool);
  const details = [engine, ...modelLabels(session)];
  const button = el("button", "cal-block");
  button.type = "button";
  button.dataset.state = state;
  button.style.top = (100 * piece.top / dayMinutes) + "%";
  button.style.height = (100 * (piece.bottom - piece.top) / dayMinutes) + "%";
  button.style.left = (100 * piece.lane / piece.lanes) + "%";
  button.style.width = (100 / piece.lanes) + "%";
  const label = [title, dayLabel.format(date), time, statusLabel(state), ...details]
    .filter(Boolean).join(" · ");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => open(session.id, block));
  const face = el("span", "cal-face");
  const heading = el("span", "cal-title");
  heading.append(el("span", "cal-task", title));
  if (piece.bottom - piece.top < 30) heading.append(el("span", "cal-mini-clock", clock(piece.from)));
  const line = el("span", "cal-line");
  const times = el("span", "cal-times", time);
  line.append(times);
  line.append(el("span", "cal-status", statusLabel(state)));
  face.append(heading, line, el("span", "cal-model", details.join(" · ")));
  button.append(face);
  return button;
}

export function renderCalendar(root: HTMLElement, sessions: Session[], blocks: Block[], start: Date, open: OpenBlock): void {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const entries = blocks.flatMap(block => {
    const session = byId.get(block.session_id);
    const start = Date.parse(block.started_at);
    const end = Date.parse(block.ended_at);
    return session && end >= start ? [{ block, session, start, end }] : [];
  });
  const dates = Array.from({ length: 8 }, (_, i) => dayAt(start, i));
  const days = dates.slice(0, 7).map((date, i) => layoutDay(date, dates[i + 1]!, entries));
  const today = +dayAt(new Date(), 0);
  const todayIndex = dates.slice(0, 7).findIndex(date => +date === today);
  const initial = todayIndex >= 0 ? todayIndex : Math.max(0, days.findIndex(day => day.length > 0));
  const previous = positions.get(root);
  const position: CalendarPosition = previous?.week === +start ? previous : { week: +start, selected: initial, scroll: -1 };
  positions.set(root, position);

  const calendar = el("section", "work-calendar");
  calendar.setAttribute("aria-label", "Work calendar");
  const key = el("ul", "cal-key");
  key.setAttribute("aria-label", "Task status legend");
  const present = new Set(entries.map(entry => stateOf(entry.session)));
  for (const state of ["waiting", "running", "completed", "unknown", "unobserved"]) {
    if (!present.has(state)) continue;
    const item = el("li", "", statusLabel(state));
    item.dataset.state = state;
    key.append(item);
  }
  if (key.childElementCount) calendar.append(key);
  const picker = el("div", "cal-picker week-strip");
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Choose a day");
  const scroller = el("div", "cal-scroll");
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", "Hourly work calendar");
  const header = el("div", "cal-header");
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" })
    .formatToParts(start).find(part => part.type === "timeZoneName")?.value;
  const sameOffset = start.getTimezoneOffset() === dates[7]!.getTimezoneOffset();
  const corner = el("span", "cal-zone", sameOffset && zone ? zone : "Local time");
  corner.title = Intl.DateTimeFormat().resolvedOptions().timeZone;
  header.append(corner);
  const body = el("div", "cal-body");
  const axis = el("div", "cal-axis");
  for (let hour = 0; hour < 24; hour++) {
    axis.append(el("span", "cal-hour", clock(hour * 60)));
  }
  body.append(axis);

  const buttons: HTMLButtonElement[] = [];
  const headers: HTMLElement[] = [];
  const columns: HTMLElement[] = [];
  const mobile = window.matchMedia("(max-width: 760px)");
  function focusTime(pieces: Piece[]) {
    const first = pieces.length ? pieces.reduce((min, piece) => Math.min(min, piece.from), dayMinutes) : 9 * 60;
    const hour = Math.max(0, Math.floor(first / 60) - 1);
    scroller.scrollTop = hour * axis.offsetHeight / 24;
    position.scroll = scroller.scrollTop;
  }
  function selectDay(i: number) {
    position.selected = i;
    for (let j = 0; j < days.length; j++) {
      const active = j === i;
      buttons[j]!.setAttribute("aria-pressed", String(active));
      headers[j]!.classList.toggle("cal-selected", active);
      columns[j]!.classList.toggle("cal-selected", active);
    }
  }

  days.forEach((pieces, i) => {
    const date = dates[i]!;
    const name = dayLabel.format(date);
    const button = el("button", "strip-day");
    button.type = "button";
    button.setAttribute("aria-label", name);
    const top = el("span", "strip-top");
    top.append(el("span", "weekday", weekday.format(date)), el("span", "strip-date", String(date.getDate())));
    button.append(top);
    button.classList.toggle("is-today", +date === today);
    if (+date === today) button.setAttribute("aria-current", "date");
    button.addEventListener("click", () => { selectDay(i); focusTime(pieces); });
    buttons.push(button);
    picker.append(button);

    const head = el("div", "cal-day-label");
    head.setAttribute("aria-label", name);
    head.append(el("span", "cal-weekday", weekday.format(date)), el("strong", "cal-day-number", String(date.getDate())));
    if (+date === today) head.setAttribute("aria-current", "date");
    headers.push(head);
    header.append(head);

    const column = el("section", "cal-day");
    column.setAttribute("aria-label", name);
    for (const piece of pieces) column.append(blockButton(piece, date, open));
    columns.push(column);
    body.append(column);
  });
  selectDay(position.selected);
  if (days.every(day => day.length === 0)) calendar.append(el("p", "cal-empty", "No work blocks recorded this week."));
  scroller.append(header, body);
  calendar.append(picker, scroller);
  root.replaceChildren(calendar);
  if (position.scroll >= 0) scroller.scrollTop = position.scroll;
  else focusTime(mobile.matches ? days[position.selected]! : days.flat());
  scroller.addEventListener("scroll", () => { position.scroll = scroller.scrollTop; }, { passive: true });
}

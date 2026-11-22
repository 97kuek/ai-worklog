import { addDays, el, localDate, sunday, weekday } from "./shared.js";

const monthName = new Intl.DateTimeFormat("en-US", { month: "long" });
const fullDay = new Intl.DateTimeFormat("en-US", { dateStyle: "full" });

function moveMonth(date: Date, offset: number) {
  const first = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  first.setDate(Math.min(date.getDate(), last.getDate()));
  return first;
}

export function installDatePicker(trigger: HTMLButtonElement, selected: () => Date, daily: () => boolean, choose: (date: Date) => void) {
  let cursor = selected();
  const dialog = el("dialog", "date-picker");
  dialog.id = "date-picker";
  trigger.setAttribute("aria-controls", dialog.id);
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");

  const month = el("span", "picker-month");
  month.setAttribute("aria-live", "polite");
  const year = el("input", "picker-year");
  year.type = "text";
  year.inputMode = "numeric";
  year.maxLength = 4;
  year.setAttribute("aria-label", "Year");
  year.title = "Enter a four-digit year";
  year.onfocus = () => year.select();
  year.oninput = () => {
    if (/^[1-9]\d{3}$/.test(year.value)) {
      cursor = moveMonth(cursor, (Number(year.value) - cursor.getFullYear()) * 12);
      draw();
    }
  };
  year.onblur = () => { year.value = String(cursor.getFullYear()); };
  year.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      focusDay();
    }
  };
  const head = el("div", "picker-head");
  const monthYear = el("div", "picker-month-year");
  monthYear.append(month, year);
  function monthButton(offset: number) {
    const button = el("button", "icon-button");
    button.setAttribute("aria-label", offset < 0 ? "Previous month" : "Next month");
    const image = el("img");
    image.alt = "";
    image.src = "/icons/lucide/chevron-" + (offset < 0 ? "left" : "right") + ".svg";
    image.width = image.height = 18;
    button.append(image);
    button.onclick = () => {
      cursor = moveMonth(cursor, offset);
      draw();
    };
    return button;
  }
  head.append(monthButton(-1), monthYear, monthButton(1));

  const grid = el("table", "picker-grid");
  grid.setAttribute("role", "grid");
  const weekdays = grid.createTHead().insertRow();
  const firstSunday = sunday(cursor);
  for (let i = 0; i < 7; i++) {
    const heading = el("th", "picker-weekday", weekday.format(addDays(firstSunday, i)));
    heading.scope = "col";
    weekdays.append(heading);
  }
  const dates = grid.createTBody();
  const footer = el("div", "picker-footer");
  const cancel = el("button", "small-button", "Cancel");
  cancel.onclick = () => dialog.close();
  const today = el("button", "this-week");
  const pick = (date: Date) => {
    dialog.close();
    choose(date);
  };
  today.onclick = () => pick(new Date());
  footer.append(cancel, today);
  dialog.append(head, grid, footer);
  document.body.append(dialog);

  function focusDay() {
    dates.querySelector<HTMLButtonElement>("button[tabindex='0']")?.focus();
  }

  function draw() {
    const monthLabel = monthName.format(cursor);
    if (month.textContent !== monthLabel) month.textContent = monthLabel;
    year.value = String(cursor.getFullYear());
    grid.setAttribute("aria-label", monthLabel + " " + year.value);
    const start = sunday(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    const current = selected();
    const week = sunday(current);
    const weekEnd = addDays(week, 7);
    const now = localDate(new Date());
    dates.replaceChildren();
    for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
      const row = dates.insertRow();
      for (let column = 0; column < 7; column++) {
        const date = addDays(start, rowIndex * 7 + column);
        const day = el("button", "picker-day", String(date.getDate()));
        day.setAttribute("aria-label", fullDay.format(date));
        if (date.getMonth() !== cursor.getMonth()) day.classList.add("outside");
        if (localDate(date) === now) day.setAttribute("aria-current", "date");
        day.tabIndex = +date === +cursor ? 0 : -1;
        day.onclick = () => pick(date);
        const cell = row.insertCell();
        const active = daily() ? +date === +current : date >= week && date < weekEnd;
        cell.setAttribute("aria-selected", String(active));
        cell.append(day);
      }
    }
  }
  grid.onkeydown = (event) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -cursor.getDay(), End: 6 - cursor.getDay() };
    if (Object.hasOwn(steps, event.key)) cursor = addDays(cursor, steps[event.key]);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      cursor = moveMonth(cursor, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
    } else return;
    event.preventDefault();
    draw();
    focusDay();
  };
  trigger.onclick = () => {
    cursor = selected();
    dialog.setAttribute("aria-label", daily() ? "Select day" : "Select week");
    grid.setAttribute("aria-multiselectable", String(!daily()));
    today.textContent = daily() ? "Today" : "This week";
    draw();
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    focusDay();
  };
  dialog.onclose = () => trigger.setAttribute("aria-expanded", String(dialog.open));
  dialog.onclick = (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  };
  return dialog;
}

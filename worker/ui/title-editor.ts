import { el, titleOf, type Session } from "./shared.js";

export function showTitle(root: HTMLElement, text: string) {
  const heading = el("h2", "", text);
  heading.id = "detail-title";
  root.replaceChildren(heading);
}

export function editTaskTitle(
  root: HTMLElement,
  session: Session,
  save: (title: string | null, expected: string | null) => Promise<Session>,
) {
  showTitle(root, titleOf(session));
  const edit = el("button", "icon-button edit-title");
  edit.type = "button";
  edit.setAttribute("aria-label", "Edit task title");
  edit.title = "Edit task title";
  const icon = el("img");
  icon.alt = "";
  icon.src = "/icons/lucide/pencil.svg";
  icon.width = icon.height = 18;
  edit.append(icon);
  root.append(edit);

  edit.onclick = () => {
    const form = el("form", "title-editor");
    const label = el("label", "", "Task title");
    label.htmlFor = "edited-task-title";
    label.id = "detail-title";
    label.hidden = true;
    const field = el("input");
    field.id = label.htmlFor;
    field.setAttribute("aria-labelledby", label.id);
    field.required = true;
    field.maxLength = 200;
    field.value = session.title ?? "";
    field.enterKeyHint = "done";
    const line = el("div", "title-input-line");
    const apply = el("button", "title-apply");
    apply.type = "submit";
    apply.setAttribute("aria-label", "Save task title");
    apply.title = "Save task title";
    const check = el("img");
    check.src = "/icons/lucide/check.svg";
    check.alt = "";
    check.width = check.height = 18;
    apply.append(check);
    line.append(field, apply);
    form.append(label, line);
    const error = el("p", "title-error");
    error.setAttribute("role", "alert");
    function finish(current: Session) {
      editTaskTitle(root, current, save);
      root.querySelector("button")?.focus();
    }
    async function commit(value: string | null) {
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = true;
      error.textContent = "";
      try {
        const updated = await save(value, session.manual_title ?? null);
        if (root.contains(form)) finish(updated);
      } catch (e) {
        if (!root.contains(form)) return;
        error.textContent = e instanceof Error ? e.message : "Could not save the task title.";
        for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = false;
        field.focus();
      }
    }
    if (session.manual_title) {
      const reset = el("button", "restore-title", "Use generated title");
      reset.type = "button";
      reset.onclick = () => void commit(null);
      form.append(reset);
    }
    field.oninput = () => field.setCustomValidity("");
    form.onsubmit = (event) => {
      event.preventDefault();
      const value = field.value.trim();
      if (!value) {
        field.setCustomValidity("Enter a task title.");
        field.reportValidity();
      } else if (value === session.title) {
        finish(session);
      } else {
        void commit(value);
      }
    };
    form.onkeydown = (event) => {
      if (event.key === "Escape" && !event.isComposing && !field.disabled) {
        event.preventDefault();
        finish(session);
      }
    };
    form.append(error);
    root.replaceChildren(form);
    field.focus();
    field.select();
  };
}

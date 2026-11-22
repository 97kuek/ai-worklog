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
    const field = el("input");
    field.id = label.htmlFor;
    field.required = true;
    field.maxLength = 200;
    field.value = session.title ?? "";
    const actions = el("div", "title-actions");
    const apply = el("button", "small-button", "Save");
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    actions.append(apply, cancel);
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
      const reset = el("button", "", "Use generated title");
      reset.type = "button";
      reset.onclick = () => void commit(null);
      actions.append(reset);
    }
    cancel.onclick = () => finish(session);
    field.oninput = () => field.setCustomValidity("");
    form.onsubmit = (event) => {
      event.preventDefault();
      const value = field.value.trim();
      if (!value) {
        field.setCustomValidity("Enter a task title.");
        field.reportValidity();
      } else {
        void commit(value);
      }
    };
    form.onkeydown = (event) => {
      if (event.key === "Escape" && !field.disabled) {
        event.preventDefault();
        finish(session);
      }
    };
    form.append(label, field, actions, error);
    root.replaceChildren(form);
    field.focus();
    field.select();
  };
}

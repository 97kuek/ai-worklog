import { el } from "./shared.js";

export function filterMenu(id: string, label: string, choices: readonly (readonly [string, string])[],
  initial: string, onChange: (value: string) => void) {
  const root = el("div", "filter-menu");
  const trigger = el("button", "filter-trigger");
  trigger.type = "button";
  trigger.id = id;
  trigger.setAttribute("aria-haspopup", "dialog");
  const dialog = el("dialog", "filter-dialog");
  dialog.id = id + "-dialog";
  trigger.setAttribute("aria-controls", dialog.id);
  const head = el("div", "filter-heading");
  const title = el("h2", "", label);
  title.id = id + "-label";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = el("button", "icon-button");
  close.type = "button";
  close.setAttribute("aria-label", "Close filter");
  const icon = el("img");
  icon.src = "/icons/lucide/x.svg";
  icon.width = icon.height = 18;
  icon.alt = "";
  close.append(icon);
  close.onclick = () => dialog.close();
  head.append(title, close);
  const list = el("div", "filter-options");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-labelledby", title.id);
  const options = choices.map(([value, name]) => {
    const item = el("button", "filter-option", name);
    item.type = "button";
    item.value = value;
    item.setAttribute("role", "option");
    item.onclick = () => {
      dialog.close();
      setValue(value);
      onChange(value);
    };
    list.append(item);
    return item;
  });
  function setValue(value: string) {
    const selected = options.find(item => item.value === value) ?? options[0]!;
    trigger.value = selected.value;
    trigger.textContent = selected.textContent;
    trigger.setAttribute("aria-label", label + ", " + selected.textContent);
    for (const item of options) {
      item.tabIndex = item === selected ? 0 : -1;
      item.setAttribute("aria-selected", String(item === selected));
    }
  }
  trigger.onclick = () => {
    dialog.showModal();
    options.find(item => item.value === trigger.value)?.focus();
  };
  list.onkeydown = event => {
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const targets: Record<string, number> = {
      ArrowDown: Math.min(options.length - 1, index + 1), ArrowUp: Math.max(0, index - 1),
      Home: 0, End: options.length - 1,
    };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    options[targets[event.key]!]!.focus();
  };
  dialog.onclick = event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  };
  dialog.append(head, list);
  root.append(trigger, dialog);
  setValue(initial);
  return { root, trigger, setValue };
}

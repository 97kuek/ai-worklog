import { filterMenu } from "./filter-menu.js";
import { el, engineName } from "./shared.js";

export interface Skill {
  tools: ("claude_code" | "codex")[];
  name: string;
  description: string;
}

export function renderSkills(root: HTMLElement, skills: Skill[]) {
  if (!skills.length) {
    root.replaceChildren(el("p", "empty-line", "No skills registered yet."));
    return;
  }

  const table = el("table", "skills-table");
  table.setAttribute("aria-label", "Available skills");
  const header = table.createTHead().insertRow();
  for (const label of ["Tools", "Skill", "Description"]) {
    const column = el("th", "", label);
    column.scope = "col";
    header.append(column);
  }

  const body = table.createTBody();
  const filter = filterMenu("skills-tool", "Filter by tool",
    [["", "All tools"], ["claude_code", engineName("claude_code")], ["codex", engineName("codex")]],
    root.querySelector<HTMLButtonElement>("#skills-tool")?.value ?? "", () => draw());
  function draw() {
    body.replaceChildren();
    for (const skill of skills) {
      if (filter.trigger.value && !skill.tools.some(tool => tool === filter.trigger.value)) continue;
      const row = body.insertRow();
      row.insertCell().textContent = skill.tools.map(engineName).join(" / ");
      row.insertCell().textContent = skill.name;
      row.insertCell().textContent = skill.description || "—";
    }
    if (!body.rows.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 3;
      cell.textContent = "No skills for this tool.";
    }
  }
  draw();
  const controls = el("div", "skills-filter");
  controls.append(filter.root);
  const scroll = el("div", "skills-scroll");
  scroll.append(table);
  const panel = el("section", "skills-panel");
  panel.append(scroll);
  root.replaceChildren(controls, panel);
}

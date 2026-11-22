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
  for (const skill of skills) {
    const row = body.insertRow();
    row.insertCell().textContent = skill.tools.map(engineName).join(" / ");
    row.insertCell().textContent = skill.name;
    row.insertCell().textContent = skill.description || "—";
  }

  const scroll = el("div", "skills-scroll");
  scroll.append(table);
  const panel = el("section", "skills-panel");
  panel.append(scroll);
  root.replaceChildren(panel);
}

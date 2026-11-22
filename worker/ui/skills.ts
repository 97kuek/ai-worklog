import { filterMenu } from "./filter-menu.js";
import { dataTable, el, engineName } from "./shared.js";

export interface Skill {
  tools: ("claude_code" | "codex")[];
  profiles: { tool: string; account: string | null }[];
  name: string;
  description: string;
}

export function renderSkills(root: HTMLElement, skills: Skill[]) {
  if (!skills.length) {
    root.replaceChildren(el("p", "empty-line", "No skills registered yet."));
    return;
  }

  const table = dataTable("skills-table", "Available skills", ["Tools", "Account", "Skill", "Description"]);

  const body = table.createTBody();
  const filter = filterMenu("skills-tool", "Filter by tool",
    [["", "All tools"], ["claude_code", engineName("claude_code")], ["codex", engineName("codex")]],
    root.querySelector<HTMLButtonElement>("#skills-tool")?.value ?? "", () => draw());
  const accounts = [...new Set(skills.flatMap(skill => skill.profiles.map(p => p.account)).filter((id): id is string => !!id))].sort();
  const accountFilter = filterMenu("skills-account", "Filter by account",
    [["", "All accounts"], ...accounts.map(account => [account, account] as const), ["@unspecified", "Unspecified"]],
    root.querySelector<HTMLButtonElement>("#skills-account")?.value ?? "", () => draw());
  function draw() {
    body.replaceChildren();
    for (const skill of skills) {
      const profiles = skill.profiles.filter(profile =>
        (!filter.trigger.value || profile.tool === filter.trigger.value)
        && (!accountFilter.trigger.value || (profile.account ?? "@unspecified") === accountFilter.trigger.value));
      if (!profiles.length) continue;
      const row = body.insertRow();
      row.insertCell().textContent = [...new Set(profiles.map(p => engineName(p.tool)))].join(" / ");
      row.insertCell().textContent = [...new Set(profiles.map(p => p.account ?? "—"))].join(" / ");
      row.insertCell().textContent = skill.name;
      row.insertCell().textContent = skill.description || "—";
    }
    if (!body.rows.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 4;
      cell.textContent = "No skills match these filters.";
    }
  }
  draw();
  const controls = el("div", "skills-filter");
  controls.append(filter.root, accountFilter.root);
  const scroll = el("div", "skills-scroll");
  scroll.append(table);
  const panel = el("section", "skills-panel");
  panel.append(scroll);
  root.replaceChildren(controls, panel);
}

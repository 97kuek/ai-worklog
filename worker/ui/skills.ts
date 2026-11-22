import { CLAUDE_ACCOUNTS, type ClaudeAccount } from "./claude-accounts.js";
import { filterMenu } from "./filter-menu.js";
import { dataTable, el, engineName } from "./shared.js";

export interface Skill {
  tools: ("claude_code" | "codex")[];
  accounts?: (ClaudeAccount | null)[];
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
  const accountFilter = filterMenu("skills-account", "Filter by Claude account",
    [["", "All accounts"], ...CLAUDE_ACCOUNTS.map(account => [account, account] as const), ["unknown", "Unspecified"]],
    root.querySelector<HTMLButtonElement>("#skills-account")?.value ?? "", () => draw());
  function draw() {
    body.replaceChildren();
    for (const skill of skills) {
      if (filter.trigger.value && !skill.tools.some(tool => tool === filter.trigger.value)) continue;
      const accounts = skill.accounts ?? (skill.tools.includes("claude_code") ? [null] : []);
      if (accountFilter.trigger.value && !accounts.some(account => (account ?? "unknown") === accountFilter.trigger.value)) continue;
      const row = body.insertRow();
      row.insertCell().textContent = skill.tools.map(engineName).join(" / ");
      row.insertCell().textContent = accounts.map(account => account ?? "Unspecified").join(" / ") || "—";
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

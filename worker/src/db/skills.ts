import { CLAUDE_ACCOUNTS, type ClaudeAccount } from "../../ui/claude-accounts";
import { SKILL_TOOLS, type SkillInventory, type SkillTool } from "../domain/skills";

export async function replaceSkills(db: D1Database, machineId: string, { tools, skills, account }: SkillInventory) {
  // A confirmed personal snapshot supersedes the old unscoped rows on this machine.
  // Work and legacy clients each replace only their own scope.
  const statements = [
    db.prepare(`DELETE FROM machine_skills WHERE machine_id = ? AND tool IN (${tools.map(() => "?").join(",")})
      AND (account = ? OR (account = '' AND ? = 'p-claude'))`)
      .bind(machineId, ...tools, account ?? "", account ?? ""),
  ];
  // D1 accepts at most 100 bound parameters per statement. One batch replaces the snapshot atomically.
  const chunkSize = 20;
  for (let start = 0; start < skills.length; start += chunkSize) {
    const rows = skills.slice(start, start + chunkSize);
    const values = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
    statements.push(db.prepare(`INSERT INTO machine_skills (machine_id, tool, account, name, description)
      VALUES ${values} ON CONFLICT DO NOTHING`)
      .bind(...rows.flatMap(({ tool, name, description }) => [machineId, tool, account ?? "", name, description])));
  }
  await db.batch(statements);
}

export async function listSkills(db: D1Database, userId: string) {
  const { results } = await db.prepare(`SELECT s.name, s.description,
      MAX(s.tool = 'claude_code') AS claude_code, MAX(s.tool = 'codex') AS codex,
      json_group_array(DISTINCT s.account) FILTER (WHERE s.tool = 'claude_code') AS claude_accounts
    FROM machine_skills s JOIN machines m ON s.machine_id = m.id
    WHERE m.user_id = ? GROUP BY s.name, s.description
    ORDER BY s.name COLLATE NOCASE, s.name, s.description`)
    .bind(userId).all<{ name: string; description: string; claude_accounts: string } & Record<SkillTool, number>>();
  return results.map((row) => {
    const reported: string[] = JSON.parse(row.claude_accounts);
    const accounts: (ClaudeAccount | null)[] = CLAUDE_ACCOUNTS.filter(account => reported.includes(account));
    if (reported.includes("")) accounts.push(null);
    return {
      name: row.name, description: row.description, tools: SKILL_TOOLS.filter(tool => row[tool] === 1), accounts,
    };
  });
}

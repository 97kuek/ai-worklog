import type { SkillInventory, SkillTool } from "../domain/skills";

export async function replaceSkills(db: D1Database, machineId: string, { tools, skills, account, primary }: SkillInventory) {
  // A confirmed primary snapshot supersedes the old unscoped rows on this machine.
  // Work and legacy clients each replace only their own scope.
  const statements = [
    db.prepare(`DELETE FROM machine_skills WHERE machine_id = ? AND tool IN (${tools.map(() => "?").join(",")})
      AND (account = ? OR (account = '' AND ? = 1))`)
      .bind(machineId, ...tools, account ?? "", primary ? 1 : 0),
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
  const { results } = await db.prepare(`SELECT DISTINCT s.name, s.description, s.tool, s.account
    FROM machine_skills s JOIN machines m ON s.machine_id = m.id
    WHERE m.user_id = ? ORDER BY s.name COLLATE NOCASE, s.name, s.description, s.tool, s.account = '', s.account`)
    .bind(userId).all<{ name: string; description: string; tool: SkillTool; account: string }>();
  type Entry = { name: string; description: string; tools: SkillTool[]; profiles: { tool: SkillTool; account: string | null }[] };
  const skills: Entry[] = [];
  for (const { name, description, tool, account } of results) {
    let skill = skills.at(-1);
    if (!skill || skill.name !== name || skill.description !== description) {
      skill = { name, description, tools: [], profiles: [] };
      skills.push(skill);
    }
    if (!skill.tools.includes(tool)) skill.tools.push(tool);
    skill.profiles.push({ tool, account: account || null });
  }
  return skills;
}

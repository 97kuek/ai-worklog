import { SKILL_TOOLS, type SkillInventory, type SkillTool } from "../domain/skills";

export async function replaceSkills(db: D1Database, machineId: string, { tools, skills }: SkillInventory) {
  const statements = [
    db.prepare(`DELETE FROM machine_skills WHERE machine_id = ? AND tool IN (${tools.map(() => "?").join(",")})`)
      .bind(machineId, ...tools),
  ];
  // D1 accepts at most 100 bound parameters per statement. One batch replaces the snapshot atomically.
  const chunkSize = 25;
  for (let start = 0; start < skills.length; start += chunkSize) {
    const rows = skills.slice(start, start + chunkSize);
    const values = rows.map(() => "(?, ?, ?, ?)").join(", ");
    statements.push(db.prepare(`INSERT INTO machine_skills (machine_id, tool, name, description)
      VALUES ${values} ON CONFLICT DO NOTHING`)
      .bind(...rows.flatMap(({ tool, name, description }) => [machineId, tool, name, description])));
  }
  await db.batch(statements);
}

export async function listSkills(db: D1Database, userId: string) {
  const { results } = await db.prepare(`SELECT s.name, s.description,
      MAX(s.tool = 'claude_code') AS claude_code, MAX(s.tool = 'codex') AS codex
    FROM machine_skills s JOIN machines m ON s.machine_id = m.id
    WHERE m.user_id = ? GROUP BY s.name, s.description
    ORDER BY s.name COLLATE NOCASE, s.name, s.description`)
    .bind(userId).all<{ name: string; description: string } & Record<SkillTool, number>>();
  return results.map((row) => ({
    name: row.name, description: row.description, tools: SKILL_TOOLS.filter((tool) => row[tool] === 1),
  }));
}

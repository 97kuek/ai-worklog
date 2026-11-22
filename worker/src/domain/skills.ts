export const SKILL_TOOLS = ["claude_code", "codex"] as const;
export type SkillTool = typeof SKILL_TOOLS[number];
export type Skill = { tool: SkillTool; name: string; description: string };
export type SkillInventory = { tools: SkillTool[]; skills: Skill[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTool = (v: unknown): v is SkillTool => v === "claude_code" || v === "codex";
// UTF-16 uses at most two code units per code point. Reject oversized fields before expanding them.
const fitsLength = (text: string, max: number) =>
  text.length <= max || (text.length <= max * 2 && [...text].length <= max);
const invalid = (path: string, message: string) => ({ ok: false as const, path, message });

export function parseSkillInventory(input: unknown) {
  if (!isRecord(input)) return invalid("", "must be an object");
  const tools: unknown = input.tools === undefined ? [...SKILL_TOOLS] : input.tools;
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 2 || !tools.every(isTool)
    || new Set(tools).size !== tools.length) {
    return invalid("tools", "must contain one or both of claude_code and codex without duplicates");
  }
  if (!Array.isArray(input.skills) || input.skills.length > 1024) {
    return invalid("skills", "must be an array of at most 1024 items");
  }
  const skills: Skill[] = [];
  for (const [i, row] of input.skills.entries()) {
    const path = `skills[${i}]`;
    if (!isRecord(row)) return invalid(path, "must be an object");
    const { tool, name, description } = row;
    if (!isTool(tool) || !tools.includes(tool)) return invalid(`${path}.tool`, "must be a declared tool");
    if (typeof name !== "string" || !fitsLength(name, 256) || !name.trim()) {
      return invalid(`${path}.name`, "must be a nonblank name of at most 256 characters");
    }
    if (typeof description !== "string" || !fitsLength(description, 4096)) {
      return invalid(`${path}.description`, "must be a string of at most 4096 characters");
    }
    skills.push({ tool, name, description });
  }
  return { ok: true as const, value: { tools, skills } satisfies SkillInventory };
}

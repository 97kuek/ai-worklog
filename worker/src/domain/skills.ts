import { isAccountId } from "../../ui/accounts";

export const SKILL_TOOLS = ["claude_code", "codex"] as const;
export type SkillTool = typeof SKILL_TOOLS[number];
export type Skill = { tool: SkillTool; name: string; description: string };
export type SkillInventory = { tools: SkillTool[]; skills: Skill[]; account?: string; primary?: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTool = (v: unknown): v is SkillTool => SKILL_TOOLS.some(tool => tool === v);
// UTF-16 uses at most two code units per code point. Reject oversized fields before expanding them.
const fitsLength = (text: string, max: number) =>
  text.length <= max || (text.length <= max * 2 && [...text].length <= max);
const invalid = (path: string, message: string) => ({ ok: false as const, path, message });

export function parseSkillInventory(input: unknown) {
  if (!isRecord(input)) return invalid("", "must be an object");
  const { account, primary } = input;
  if (account !== undefined && !isAccountId(account)) return invalid("account", "invalid account identifier");
  if (primary !== undefined && (!account || typeof primary !== "boolean")) return invalid("primary", "requires a scoped account and a boolean");
  const tools: unknown = input.tools === undefined ? (account ? ["claude_code"] : [...SKILL_TOOLS]) : input.tools;
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > SKILL_TOOLS.length || !tools.every(isTool)
    || new Set(tools).size !== tools.length) {
    return invalid("tools", "must contain one or both of claude_code and codex without duplicates");
  }
  if (account && tools.length !== 1) {
    return invalid("tools", "a scoped snapshot must declare a single tool");
  }
  if (!Array.isArray(input.skills) || input.skills.length > 1024) {
    return invalid("skills", "must be an array of at most 1024 items");
  }
  const skills: Skill[] = [];
  for (const [i, row] of input.skills.entries()) {
    const path = `skills[${i}]`;
    if (!isRecord(row)) return invalid(path, "must be an object");
    if ("account" in row) return invalid(`${path}.account`, "declare one account on the inventory");
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
  return { ok: true as const, value: { tools, skills, account, primary } satisfies SkillInventory };
}

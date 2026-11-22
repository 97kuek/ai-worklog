import { duration } from "./activity.js";
import { blockTimeRange, countLabel, el, engineName, fullDate, modelSettings, type Block, type Session } from "./shared.js";

const tokenFields = [
  ["input", "Input"], ["output", "Output"], ["cache_read", "Cache read"], ["cache_write", "Cache write"],
] as const;
const englishNumber = new Intl.NumberFormat("en-US");

function tokenUsage(session: Session) {
  const section = el("section", "detail-part");
  section.lang = "en";
  const head = el("div", "detail-part-heading");
  head.append(el("h3", "", "Token usage"));

  // Both collectors upload exclusive counts. Codex removes cached input before upload.
  const fields = tokenFields.map(([key, label]) => {
    const count = session.tokens?.[key];
    return { key, label, count: Number.isSafeInteger(count) && count >= 0 ? count : null };
  });
  const complete = fields.every(({ count }) => count !== null);
  const total = fields.reduce((sum, { count }) => sum + BigInt(count ?? 0), 0n);
  head.append(el("span", "", complete ? "Total " + englishNumber.format(total) : "Total unavailable"));

  const bar = el("div", "detail-token-bar");
  bar.setAttribute("aria-hidden", "true");
  const legend = el("dl", "detail-token-legend");
  for (const { key, label, count } of fields) {
    if (complete && count) {
      const segment = el("span", "detail-token-" + key);
      segment.style.width = (count / Number(total)) * 100 + "%";
      bar.append(segment);
    }
    const item = el("div", "detail-token-" + key);
    item.append(el("dt", "", label), el("dd", "", count === null ? "Not recorded" : englishNumber.format(count)));
    legend.append(item);
  }
  section.append(head);
  if (complete) section.append(bar);
  section.append(legend);
  return section;
}

function blockHistory(session: Session, blocks: Block[], selected?: Block) {
  const section = el("section", "detail-part");
  const head = el("div", "detail-part-heading");
  head.append(
    el("h3", "", "Work blocks"),
    el("span", "", countLabel(blocks.length, "block") + " · " + duration(session.active_minutes * 60_000) + " total"),
  );
  section.append(head);
  if (!blocks.length) return section;

  const list = el("ol", "detail-block-list");
  list.setAttribute("aria-label", "Work block history");
  for (const block of blocks) {
    const item = el("li");
    if (block.seq === selected?.seq) item.setAttribute("aria-current", "true");
    const elapsed = duration(Date.parse(block.ended_at) - Date.parse(block.started_at));
    item.append(blockTimeRange(block), el("span", "block-meta", elapsed + " · " + countLabel(block.message_count, "message")));
    list.append(item);
  }
  section.append(list);
  return section;
}

function fact(list: HTMLElement, label: string, value: string) {
  const item = el("div");
  item.append(el("dt", "", label), el("dd", "", value));
  list.append(item);
}

export function renderDetail(root: HTMLElement, session: Session, blocks: Block[], selected?: Block) {
  const facts = el("dl", "facts detail-facts");
  const { project, git_branch } = session;
  if (project || git_branch) {
    fact(facts, project ? "Project" : "Branch", [project, git_branch].filter(Boolean).join(" / "));
  }
  const settings = el("table", "detail-settings");
  settings.setAttribute("aria-label", "Execution settings");
  const heading = settings.createTHead().insertRow();
  for (const label of ["Engine", "Model", "Effort"]) {
    const th = el("th", "", label);
    th.scope = "col";
    heading.append(th);
  }
  const pairs = modelSettings(session);
  const rows = settings.createTBody();
  for (const pair of pairs.length ? pairs : [{ model: "", effort: null }]) {
    const row = rows.insertRow();
    row.insertCell().textContent = engineName(session.tool);
    row.insertCell().textContent = pair.model || "—";
    row.insertCell().textContent = pair.effort ?? "—";
  }
  root.replaceChildren(facts, settings);
  root.append(tokenUsage(session), blockHistory(session, blocks, selected));

  const recorded = el("dl", "facts detail-facts");
  if (session.machine_name) fact(recorded, "Machine", session.machine_name);
  if (session.invoked_by) fact(recorded, "Invoked by", engineName(session.invoked_by));
  if (!blocks.length) {
    fact(recorded, "Started", fullDate.format(new Date(session.started_at)));
    fact(recorded, "Last active", fullDate.format(new Date(session.ended_at)));
  }
  if (session.observed_status) fact(recorded, "Status observed", fullDate.format(new Date(session.observed_status.at)));
  if (session.completed_at) fact(recorded, "Completed", fullDate.format(new Date(session.completed_at)));
  if (recorded.childElementCount) {
    const details = el("details", "detail-record");
    details.append(el("summary", "", "Session details"), recorded);
    root.append(details);
  }
}

import { requestComposer, type RequestFields, type RequestState, type BoardRequest, type Stage } from "./request-composer.js";
import { countLabel, el, engineName, type Session } from "./shared.js";

export type { BoardRequest } from "./request-composer.js";
export type SaveRequest = (id: string, change: RequestFields | { stage: Stage } | (RequestState & { expected: RequestState })) => Promise<unknown>;

export function planningLanes(requests: BoardRequest[], save: SaveRequest, sessions: Session[]) {
  const items = new Map(requests.map(item => [item.id, item]));
  const moving = new Set<string>();
  let dragged: string | undefined;
  function lane(stage: Stage, name: string) {
    const section = el("section", "board-lane board-" + stage);
    const heading = el("h2", "board-lane-heading", name);
    const count = el("span", "board-count");
    heading.append(count);
    const list = el("ul", "board-list");
    section.append(heading, list);
    section.ondragover = event => {
      if (dragged && items.get(dragged)?.stage !== stage) event.preventDefault();
    };
    section.ondrop = event => {
      event.preventDefault();
      if (dragged && items.get(dragged)?.stage !== stage) void move(dragged, stage);
      dragged = undefined;
    };
    return { section, count, list };
  }
  const lanes = { backlog: lane("backlog", "Backlog"), queued: lane("queued", "Queued") };
  const errors = new Map<string, string>();
  function focusCard(id: string) {
    for (const target of Object.values(lanes))
      target.list.querySelector<HTMLButtonElement>('[data-request="' + CSS.escape(id) + '"]')?.focus({preventScroll:true});
  }
  const composer = requestComposer(sessions, () => items.values(), async (id, fields, stage, original) => {
    if (original) {
      const { id: _id, ...expected } = original;
      await save(id, { ...fields, stage, expected });
    } else {
      await save(id, fields);
    }
    errors.delete(id);
    items.set(id, { ...fields, id, stage });
    draw();
  }, focusCard);
  lanes.backlog.list.before(composer.root);
  async function move(id: string, stage: Stage) {
    const item = items.get(id);
    if (!item || item.stage === stage || moving.has(id)) return;
    moving.add(id);
    errors.delete(id);
    draw();
    try {
      await save(id, { stage });
      items.delete(id);
      items.set(id, { ...item, stage });
    } catch (e) {
      errors.set(id, e instanceof Error ? e.message : "Could not move request.");
    } finally {
      moving.delete(id);
      draw();
      focusCard(id);
    }
  }
  function draw() {
    for (const [stage, target] of Object.entries(lanes)) {
      const matches = Array.from(items.values()).filter(item => item.stage === stage);
      target.count.textContent = String(matches.length);
      target.count.setAttribute("aria-label", countLabel(matches.length, "request"));
      target.list.replaceChildren();
      for (const item of matches) {
        const card = el("li", "board-card request-card");
        const action = el("button", "request-card-button");
        action.type = "button";
        action.setAttribute("aria-label", "Edit request: " + item.title);
        action.setAttribute("aria-haspopup", "dialog");
        action.onclick = () => composer.edit(item);
        action.append(el("span", "board-title", item.title));
        action.disabled = moving.has(item.id);
        action.dataset.request = item.id;
        card.draggable = !action.disabled;
        card.ondragstart = event => {
          dragged = item.id;
          event.dataTransfer?.setData("text/plain", item.id);
        };
        card.ondragend = () => { dragged = undefined; };
        card.append(action);
        const settings = [item.engine && engineName(item.engine), item.model, item.effort].filter(Boolean);
        if (settings.length) action.append(el("span", "board-meta", settings.join(" · ")));
        if (item.project) action.append(el("span", "board-meta", item.project));
        if (errors.has(item.id)) {
          const problem = el("p", "board-error", errors.get(item.id));
          problem.setAttribute("role", "alert");
          card.append(problem);
        }
        target.list.append(card);
      }
    }
  }
  draw();
  return [lanes.backlog.section, lanes.queued.section];
}

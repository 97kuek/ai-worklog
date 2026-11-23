import { el, engineName, fullDate, titleOf, type Session } from "./shared.js";

type Match = Pick<Session, "id" | "title" | "project" | "tool" | "started_at">;
export interface SearchPage { sessions: Match[]; next: { start: number; id: string } | null }

export function renderSearch(root: HTMLElement, query: string, first: SearchPage,
  read: (cursor: NonNullable<SearchPage["next"]>) => Promise<SearchPage>, open: (id: string) => void, signal: AbortSignal) {
  const heading = el("h2", "history-search-title", "Results for “" + query + "”");
  if (!first.sessions.length) {
    root.replaceChildren(heading, el("p", "", "No matching tasks across all weeks."));
    return;
  }
  const list = el("ul", "history-matches");
  const more = el("button", "small-button", "Load more");
  const status = el("p");
  status.setAttribute("role", "status");
  let next = first.next;
  function append(page: SearchPage) {
    for (const match of page.sessions) {
      const item = el("li");
      const button = el("button");
      const stamp = el("time", "", fullDate.format(new Date(match.started_at)));
      stamp.dateTime = match.started_at;
      button.append(el("strong", "", titleOf(match)));
      if (match.title?.trim()) button.append(el("span", "result-meta", [match.project, engineName(match.tool)].filter(Boolean).join(" · ")));
      button.append(stamp);
      button.onclick = () => open(match.id);
      item.append(button);
      list.append(item);
    }
    next = page.next;
    more.hidden = !next;
  }
  more.onclick = async () => {
    if (!next || more.disabled) return;
    more.disabled = true;
    status.textContent = "";
    try {
      const result = await read(next);
      if (signal.aborted) return;
      const previous = list.children.length;
      append(result);
      list.children[previous]?.querySelector("button")?.focus();
    } catch {
      if (!signal.aborted) status.textContent = "Could not load more tasks. Try again.";
    } finally {
      more.disabled = false;
    }
  };
  append(first);
  root.replaceChildren(heading, list, status, more);
}

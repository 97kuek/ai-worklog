import type { Launch, queueWaitLabels } from "./launch.js";
import { filterMenu } from "./filter-menu.js";
import { el, modelSettings, type Session } from "./shared.js";

export interface RequestFields {
  title: string;
  engine: string | null;
  model: string | null;
  effort: string | null;
  project: string | null;
}

export type Stage = "backlog" | "queued";
export interface RequestState extends RequestFields { stage: Stage }
export interface BoardRequest extends RequestState { id: string; launch?: Launch; wait_reason?: keyof typeof queueWaitLabels }

export function requestComposer(
  sessions: Session[],
  requests: () => Iterable<BoardRequest>,
  save: (id: string, fields: RequestFields, stage: Stage, original?: BoardRequest) => Promise<void>,
  focusCard: (id: string) => void,
  runnerProjects: string[],
) {
  const root = el("div", "request-composer");
  const launch = el("button", "request-add", "＋ Add");
  launch.type = "button";
  launch.setAttribute("aria-label", "Add request");
  launch.setAttribute("aria-haspopup", "dialog");
  root.append(launch);

  function open(original?: BoardRequest) {
    const dialog = el("dialog", "request-dialog");
    const heading = el("h2", "", original ? "Edit request" : "New request");
    heading.id = "request-heading";
    dialog.setAttribute("aria-labelledby", heading.id);
    const form = el("form", "request-form");
    const label = el("label", "", "Request (required)");
    const field = el("textarea");
    field.id = "request-text";
    field.maxLength = 200;
    field.required = true;
    field.rows = 3;
    field.value = original?.title ?? "";
    label.htmlFor = field.id;
    const choices = el("div", "request-choices");
    const actions = el("div", "request-actions");
    const cancel = el("button", "small-button", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => dialog.close();
    const submit = el("button", "small-button", original ? "Save changes" : "Add to backlog");
    submit.type = "submit";
    actions.append(cancel, submit);
    const error = el("p", "board-error");
    error.setAttribute("role", "alert");
    form.append(label, field, choices, error, actions);
    dialog.append(heading, form);
    root.append(dialog);
    const fields: RequestFields = {
      title: field.value, engine: original?.engine ?? null, model: original?.model ?? null,
      effort: original?.effort ?? null, project: original?.project ?? null,
    };
    const stage: Stage = original?.stage ?? "backlog";
    let id = crypto.randomUUID();
    let saving = false;
    function choice(key: keyof Omit<RequestFields, "title">, title: string,
      options: [string, string][], empty: string, changed?: () => void) {
      const container = el("div", "request-choice");
      const caption = el("label", "", title);
      const menu = filterMenu("request-" + key, title, [["", empty], ...options], fields[key] ?? "", value => {
        if (fields[key] === (value || null)) return;
        fields[key] = value || null;
        id = crypto.randomUUID();
        changed?.();
      });
      caption.htmlFor = menu.trigger.id;
      menu.trigger.disabled = !options.length;
      container.append(caption, menu.root);
      return container;
    }
    const pairs = (values: string[]): [string, string][] =>
      [...new Set(values)].sort((a, b) => a.localeCompare(b)).map(value => [value, value]);
    const recent = [...sessions].sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at) || a.id.localeCompare(b.id));
    function recentSettings(engine: string | null) {
      const session = recent.find(s => s.project === fields.project && s.tool === engine);
      return session ? modelSettings(session) : [];
    }
    function onlyValue(values: (string | null)[]) {
      return values.length && values.every(value => value === values[0]) ? values[0] ?? null : null;
    }
    function inheritModel() {
      const settings = recentSettings(fields.engine);
      // A session can contain several configurations without recording their order.
      fields.model = onlyValue(settings.map(s => s.model));
      fields.effort = fields.model ? onlyValue(settings.map(s => s.effort)) : null;
    }
    function renderModels() {
      const settings = sessions.filter(s => s.tool === fields.engine).flatMap(modelSettings);
      const models = choice("model", "Model", pairs([...settings.map(x => x.model), ...(fields.model ? [fields.model] : [])]), "Default", () => {
        const matches = recentSettings(fields.engine).filter(s => s.model === fields.model);
        fields.effort = onlyValue(matches.map(s => s.effort));
        renderModels();
        choices.querySelector<HTMLButtonElement>("#request-model")?.focus();
      });
      const observed = settings.filter(s => !fields.model || s.model === fields.model).flatMap(s => s.effort ? [s.effort] : []);
      const efforts = fields.engine ? [...new Set(["low", "medium", "high", ...observed, ...(fields.effort ? [fields.effort] : [])])] : [];
      const effort = choice("effort", "Effort", efforts.map(v => [v, v]), "Default");
      modelSlot.replaceChildren(models);
      effortSlot.replaceChildren(effort);
    }
    const modelSlot = el("div");
    const effortSlot = el("div");
    const engineSlot = el("div");
    function selectProject(project: string | null) {
      if (fields.project === project) return;
      fields.project = project;
      fields.engine = project ? recent.find(s => s.project === project && (s.tool === "claude_code" || s.tool === "codex"))?.tool ?? null : null;
      inheritModel();
      renderEngine();
    }
    function renderEngine() {
      engineSlot.replaceChildren(choice("engine", "Engine", [["claude_code", "Claude Code"], ["codex", "Codex"]], "Unassigned", () => {
        inheritModel();
        renderModels();
      }));
      renderModels();
    }
    const knownProjects = [...sessions, ...requests()].flatMap(s => s.project ? [s.project] : []);
    const registered = new Set(runnerProjects);
    const projects = [...new Set([...runnerProjects, ...(stage === "backlog" ? knownProjects : []),
      ...(original?.project ? [original.project] : [])])].sort();
    const projectField = el("div", "request-choice");
    const projectLabel = el("label", "", "Project (required)");
    const projectInput = el("input");
    projectInput.id = "request-project-name";
    projectInput.maxLength = 256;
    projectInput.placeholder = "Project name";
    projectInput.setAttribute("aria-label", "Project name");
    projectInput.oninput = () => {
      selectProject(projectInput.value.trim() || null);
      error.textContent = "";
      id = crypto.randomUUID();
    };
    projectField.append(projectLabel);
    const projectControl = el("div", "project-control");
    projectControl.append(projectInput);
    projectField.append(projectControl);
    let projectFocus: HTMLElement = projectInput;
    if (projects.length || stage === "queued") {
      const options: [string, string][] = projects.map(p => ["project:" + p, registered.has(p) ? p : p + " (unregistered)"]);
      if (stage === "backlog") options.push(["new", "New project…"]);
      const menu = filterMenu("request-project", "Project", [
        ["", "Select project"], ...options,
      ], fields.project ? "project:" + fields.project : "", value => {
        const isNew = value === "new";
        projectInput.hidden = !isNew;
        projectInput.required = isNew;
        projectControl.classList.toggle("entering-name", isNew);
        projectFocus = isNew ? projectInput : menu.trigger;
        projectLabel.htmlFor = projectFocus.id;
        if (isNew) {
          menu.trigger.textContent = "";
          menu.trigger.setAttribute("aria-label", "Choose project");
        }
        selectProject(isNew ? projectInput.value.trim() || null : value.slice("project:".length) || null);
        error.textContent = "";
        id = crypto.randomUUID();
        if (isNew) projectInput.focus();
      });
      projectFocus = menu.trigger;
      projectControl.append(menu.root);
      projectInput.hidden = true;
    } else {
      projectInput.required = original?.project !== null;
    }
    projectLabel.htmlFor = projectFocus.id;
    choices.append(projectField, engineSlot, modelSlot, effortSlot);
    renderEngine();
    field.oninput = () => { id = crypto.randomUUID(); field.setCustomValidity(""); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving) return;
      fields.title = field.value.trim();
      if (!fields.title) {
        field.setCustomValidity("Enter a request.");
        field.reportValidity();
        return;
      }
      const movingLegacy = original?.project === null && fields.title === original.title
        && fields.engine === original.engine && fields.model === original.model && fields.effort === original.effort;
      if (!fields.project && !movingLegacy) {
        error.textContent = "Select or enter a project.";
        projectFocus.focus();
        return;
      }
      saving = true;
      form.inert = true;
      error.textContent = "";
      try {
        await save(original?.id ?? id, { ...fields }, stage, original);
        dialog.close();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : "Could not save request.";
      } finally {
        saving = false;
        form.inert = false;
        if (dialog.open) submit.focus();
      }
    };
    dialog.oncancel = e => { if (saving) e.preventDefault(); };
    dialog.onclose = () => { dialog.remove(); if (original) focusCard(original.id); else launch.focus(); };
    dialog.showModal();
    if (original) {
      heading.tabIndex = -1;
      heading.focus();
    } else field.focus();
  }
  launch.onclick = () => open();
  return { root, edit: open };
}

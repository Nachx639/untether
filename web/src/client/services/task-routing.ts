/**
 * The home Ask box in Tarea mode (P6, 2026-10-18): the text goes to the open task of the
 * repository it belongs to, or becomes a new task. POST /api/tasks/route decides:
 *
 *   match → a toast «→ añadido a <tarea> · Cambiar» for 2.5 s, then it is sent there (Cambiar
 *           stops the timer and offers the open tasks and «Es una tarea nueva»);
 *   ask   → one tap: «¿Va con X o es nueva?» (the closest tasks, then «Es una tarea nueva»);
 *   new   → started at once.
 *
 * Then POST /api/tasks/submit with the choice. Closing a choice without picking, or a failed
 * request, gives the text back to the box.
 */
import { t } from '../i18n/index.js';
import { toast } from '../utils/action-toast.js';
import { authClient } from './auth-client.js';
import { taskStore } from './task-store.js';

/** How long the «→ añadido a …» toast waits for «Cambiar» before sending. */
export const ROUTE_UNDO_MS = 2500;

export interface RoutedTask {
  id: string;
  name: string;
  branch?: string;
  state: string;
}

export interface RouteAnswer {
  repoPath: string;
  decision: {
    kind: 'match' | 'new' | 'ask';
    taskId?: string;
    candidates?: string[];
    by?: 'rules' | 'llm';
  };
  open: RoutedTask[];
}

export interface RouteChoiceItem {
  label: string;
  /** Under the label (the task's branch). */
  hint?: string;
  testId: string;
  run: () => void;
}

export interface TaskRoutingUi {
  /** A one-tap choice (a phone action sheet); `onCancel` when closed without a pick. */
  choose(title: string, items: RouteChoiceItem[], onCancel: () => void): void;
  /** Put the text back in the box. */
  restore(text: string): void;
  /** A task was started or got the text (the list refreshes, the app may open it). */
  onSubmitted?: (result: { action: 'sent' | 'created'; taskId?: string }) => void;
}

export interface TaskRoutingDeps {
  fetch?: typeof fetch;
  headers?: () => Record<string, string>;
  toast?: typeof toast;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  refresh?: () => void;
}

export interface TaskRequest {
  repoPath: string;
  text: string;
  agent: 'claude' | 'codex';
}

/** Send `text` as a task: routed, confirmed or chosen, then submitted. */
export async function sendAsTask(
  request: TaskRequest,
  ui: TaskRoutingUi,
  deps: TaskRoutingDeps = {}
): Promise<void> {
  const doFetch = deps.fetch ?? fetch.bind(window);
  const headers = () => ({
    'Content-Type': 'application/json',
    ...(deps.headers ?? (() => authClient.getAuthHeader()))(),
  });
  const show = deps.toast ?? toast;
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  const refresh = deps.refresh ?? (() => void taskStore.refresh());
  const { repoPath, text, agent } = request;

  const failed = (error: string) => {
    show({ kind: 'error', text: t('route.failed', { error }) });
    ui.restore(text);
  };

  const post = async (url: string, body: Record<string, unknown>) => {
    const response = await doFetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, data };
  };

  const errorOf = (data: Record<string, unknown>, status: number) =>
    String(data.message ?? data.error ?? status);

  let answer: RouteAnswer;
  try {
    const { response, data } = await post('/api/tasks/route', { repoPath, text });
    if (!response.ok) return failed(errorOf(data, response.status));
    answer = data as unknown as RouteAnswer;
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  const byId = new Map(answer.open.map((task) => [task.id, task]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;

  const submit = async (choice: string) => {
    try {
      const { response, data } = await post('/api/tasks/submit', {
        repoPath: answer.repoPath,
        text,
        agent,
        choice,
      });
      if (response.status === 202) {
        show({ kind: 'attention', text: t('route.pending') });
        return;
      }
      if (!response.ok) return failed(errorOf(data, response.status));
      const task = data.task as { id?: string; name?: string } | undefined;
      const name = task?.name ?? (choice === 'new' ? text : nameOf(choice));
      if (data.action === 'sent') {
        show({ kind: 'success', text: t('route.sent', { name }) });
        ui.onSubmitted?.({ action: 'sent', ...(task?.id ? { taskId: task.id } : {}) });
      } else {
        show({ kind: 'success', text: t('compose.launched', { name }) });
        ui.onSubmitted?.({ action: 'created', ...(task?.id ? { taskId: task.id } : {}) });
      }
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    } finally {
      refresh();
    }
  };

  const item = (task: RoutedTask): RouteChoiceItem => ({
    label: task.name,
    ...(task.branch ? { hint: task.branch } : {}),
    testId: `route-choice-${task.id}`,
    run: () => void submit(task.id),
  });
  const newItem: RouteChoiceItem = {
    label: t('route.new'),
    testId: 'route-choice-new',
    run: () => void submit('new'),
  };

  const { decision } = answer;
  if (decision.kind === 'match' && decision.taskId) {
    const taskId = decision.taskId;
    let changed = false;
    const timer = setTimer(() => {
      if (!changed) void submit(taskId);
    }, ROUTE_UNDO_MS);
    show({
      kind: 'info',
      text: t('route.addedTo', { name: nameOf(taskId) }),
      key: 'task-route',
      timeoutMs: ROUTE_UNDO_MS,
      action: {
        label: t('route.change'),
        run: () => {
          changed = true;
          clearTimer(timer);
          ui.choose(t('route.changeTitle'), [...answer.open.map(item), newItem], () =>
            ui.restore(text)
          );
        },
      },
    });
    return;
  }
  if (decision.kind === 'ask') {
    const offered = (decision.candidates ?? [])
      .map((id) => byId.get(id))
      .filter((task): task is RoutedTask => Boolean(task));
    if (offered.length) {
      ui.choose(
        t('route.askTitle', { name: offered[0].name }),
        [...offered.map(item), newItem],
        () => ui.restore(text)
      );
      return;
    }
  }
  await submit('new');
}

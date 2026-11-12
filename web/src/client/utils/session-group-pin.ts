/**
 * Anchoring a session to a group of the home (2026-11-04): "Anclar a este grupo", "Mover a…"
 * (a project or "Otras") and "Quitar ancla", in the phone row's sheet and the desktop card's
 * menu. Stored on the session (session.json `groupPin`, POST /api/sessions/:id/group-pin) and
 * winning over the automatic grouping (project-groups.ts anchoredGroupKey). UI only: the
 * running program is never touched.
 */
import { html } from 'lit';
import type { Session, SessionGroupPin } from '../../shared/types.js';
import { HttpMethod } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { toast } from './action-toast.js';
import { type ActionSheetItem, actionItems, PhoneActionSheet } from './phone-action-sheet.js';
import { anchoredGroupKey, type GroupChoice, type GroupMenu } from './project-groups.js';

/** Anchor a session to a group (repoPath null: "Otras"), or back to automatic with null. */
export async function setSessionGroupPin(
  sessionId: string,
  groupPin: { repoPath: string | null } | null,
  authClient: Pick<AuthClient, 'getAuthHeader'> | undefined
): Promise<SessionGroupPin | null | undefined> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/group-pin`, {
      method: HttpMethod.POST,
      headers: { 'Content-Type': 'application/json', ...authClient?.getAuthHeader() },
      body: JSON.stringify({ groupPin }),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { groupPin?: SessionGroupPin | null };
    return body.groupPin ?? null;
  } catch {
    return undefined;
  }
}

/** The name a group choice shows ("Otras" for null). */
function choiceName(choice: Pick<GroupChoice, 'key' | 'name'>): string {
  return choice.key === null ? t('board.others') : choice.name;
}

/**
 * Save the anchor, show it at once (the session object and a bubbling
 * `session-group-pinned` { sessionId, groupPin } from `target`, which the list regroups on),
 * or say it failed.
 */
export async function applyGroupPin(
  target: HTMLElement,
  session: Session,
  groupPin: { repoPath: string | null } | null,
  authClient: Pick<AuthClient, 'getAuthHeader'> | undefined
): Promise<boolean> {
  const saved = await setSessionGroupPin(session.id, groupPin, authClient);
  if (saved === undefined) {
    toast({ kind: 'error', text: t('groupPin.failed') });
    return false;
  }
  if (saved) session.groupPin = saved;
  else delete session.groupPin;
  target.dispatchEvent(
    new CustomEvent('session-group-pinned', {
      detail: { sessionId: session.id, groupPin: saved },
      bubbles: true,
      composed: true,
    })
  );
  return true;
}

export interface GroupPinMenuOptions {
  session: Session;
  /** The groups of the home and the one each session is in now. */
  menu: GroupMenu | null;
  /** Saves a choice (applyGroupPin). */
  apply: (groupPin: { repoPath: string | null } | null) => void;
}

/** The group the session shows in now: its anchor, else where the home put it. */
function currentGroup(options: GroupPinMenuOptions): string | null | undefined {
  const anchored = anchoredGroupKey(options.session);
  return anchored !== undefined ? anchored : options.menu?.groupOf.get(options.session.id);
}

/** "Mover a…": every other group of the home, "Otras" last. */
export function groupMoveStep(options: GroupPinMenuOptions) {
  return (sheet: PhoneActionSheet) => {
    const current = currentGroup(options);
    const choices = (options.menu?.choices ?? [{ key: null, name: '', folder: false }]).filter(
      (choice) => choice.key !== current
    );
    return html`<div class="psr-sheet-group ut-surface--floating ut-surface--material" data-testid="group-pin-choices">
      <div class="psr-sheet-title"><bdi>${t('groupPin.moveTo')}</bdi></div>
      ${actionItems(
        sheet,
        choices.map((choice) => ({
          label: choiceName(choice),
          icon: choice.key === null ? 'list' : 'folder',
          testId: `group-pin-to-${choice.key ?? 'others'}`,
          run: () => options.apply({ repoPath: choice.key }),
        }))
      )}
    </div>`;
  };
}

/** The sheet items: "Anclar a este grupo" or "Quitar ancla", and "Mover a…". */
export function groupPinItems(
  sheet: PhoneActionSheet,
  options: GroupPinMenuOptions
): ActionSheetItem[] {
  const items: ActionSheetItem[] = [];
  const current = options.menu?.groupOf.get(options.session.id);
  if (options.session.groupPin) {
    items.push({
      label: t('groupPin.clear'),
      icon: 'pinOff',
      testId: 'group-pin-clear',
      run: () => options.apply(null),
    });
  } else if (current !== undefined) {
    items.push({
      label: t('groupPin.anchorHere'),
      icon: 'pin',
      testId: 'group-pin-here',
      run: () => options.apply({ repoPath: current }),
    });
  }
  items.push({
    label: t('groupPin.moveTo'),
    icon: 'folder',
    testId: 'group-pin-move',
    keepOpen: true,
    run: () => sheet.step(groupMoveStep(options)),
  });
  return items;
}

/** The desktop card's group menu: the same items in their own sheet. */
export function openGroupPinSheet(
  options: GroupPinMenuOptions & { label: string; opener?: Element | null }
): PhoneActionSheet {
  const sheet = new PhoneActionSheet({
    label: options.label,
    opener: options.opener,
    testId: 'group-pin-sheet',
  });
  sheet.open(
    (s) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
      <div class="psr-sheet-title"><bdi>${options.label}</bdi></div>
      ${actionItems(s, groupPinItems(s, options))}
    </div>`
  );
  return sheet;
}

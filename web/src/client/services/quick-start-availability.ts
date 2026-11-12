/**
 * Which quick starts can run on the Mac (GET /api/quick-start/availability, 2026-10-03): a
 * program that isn't installed there is shown dimmed, "Not installed", and tapping it says
 * so instead of starting a session that only fails with "command not found".
 */
import { quickStartProgram } from '../../shared/quick-start.js';

/** { "<program>": false } for each quick-start program the Mac doesn't have. */
export type QuickStartAvailability = Record<string, boolean>;

/** Only a program the server said is missing counts as unavailable: unknown, or not known yet, is there. */
export function isQuickStartAvailable(
  availability: QuickStartAvailability,
  command: string
): boolean {
  return availability[quickStartProgram(command)] !== false;
}

/** The server's answer; {} (everything available) when it can't be had. */
export async function fetchQuickStartAvailability(
  headers: Record<string, string>
): Promise<QuickStartAvailability> {
  try {
    const response = await fetch('/api/quick-start/availability', { headers });
    if (!response.ok) return {};
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    return Object.fromEntries(
      Object.entries(body).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
      )
    );
  } catch {
    return {};
  }
}

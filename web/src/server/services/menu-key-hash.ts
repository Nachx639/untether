/**
 * A short fingerprint of a menu's key (ScreenChoices.key) for a push: the key itself does not
 * fit in Web Push's ~4 KB, and an answer sheet opened from a push before it could read the
 * prompt answers with this instead, checked exactly against the key read when the answer
 * arrives (fifth review of 2026-10-03).
 */
import { createHash } from 'node:crypto';

export function menuKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

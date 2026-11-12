/**
 * A moment the board names (a pause's end, a review retried, a scheduled start), in the app's
 * language rather than the device's (2026-10-20 audit: «01:41 AM» in a Spanish board): the
 * clock time today, «mañana a las 14:05» tomorrow, «el martes a las 14:05» within the week,
 * else the date. 24-hour where the language uses it (es, fr …).
 */
import { getLocale, t } from '../i18n/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** «14:05» in the app's language; '' for a date that does not parse. */
export function clockTime(at: string | number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  } catch {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
}

function startOfDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export interface WhenText {
  /** The clock time alone («14:05»). */
  time: string;
  /** Today: only the time is said. */
  today: boolean;
  /** Not today: «mañana a las 14:05», «el martes a las 14:05», «el 3 nov a las 14:05». */
  when: string;
}

/** How to say `at` (relative to `now`); null for a date that does not parse. */
export function whenText(at: string | number | Date, now = Date.now()): WhenText | null {
  const date = at instanceof Date ? at : new Date(at);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  const time = clockTime(date);
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
  if (days === 0) return { time, today: true, when: time };
  const locale = getLocale();
  let when: string;
  if (days === 1) {
    when = t('when.tomorrow', { time });
  } else if (days > 1 && days < 7) {
    when = t('when.weekday', { day: date.toLocaleDateString(locale, { weekday: 'long' }), time });
  } else {
    when = t('when.date', {
      date: date.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
      time,
    });
  }
  return { time, today: false, when };
}

// ============================================================
// Business-hours evaluation — pure, dependency-free, and the single
// source of truth for "are we open right now?".
//
// All open/close times are wall-clock times in the account's IANA
// zone. We never store offsets: `Intl.DateTimeFormat` is asked what
// the local clock reads at a given instant, so DST transitions are
// handled by the runtime's tz database rather than by us.
//
// Callers: the webhook (away message + automation gating) and the
// settings UI (live "open now" preview).
// ============================================================

export const DAY_KEYS = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export interface OpenWindow {
  /** "HH:MM", 24-hour, in the account timezone. */
  open: string;
  /**
   * "HH:MM". A close <= open spans midnight (22:00 -> 02:00) and is
   * evaluated against the following day. open === close means open
   * for the full 24 hours.
   */
  close: string;
}

export interface DaySchedule {
  closed: boolean;
  windows: OpenWindow[];
}

export type WeeklySchedule = Record<DayKey, DaySchedule>;

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  schedule: WeeklySchedule;
  /** ISO dates ("YYYY-MM-DD") that are closed all day. */
  holidays: string[];
}

// ------------------------------------------------------------
// Time helpers
// ------------------------------------------------------------

/** "HH:MM" -> minutes since midnight, or null when malformed. */
export function parseTimeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '');
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function minutesToTime(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** "YYYY-MM-DD" in the target zone. */
  isoDate: string;
  dayKey: DayKey;
  /** Minutes since local midnight. */
  minutes: number;
}

/**
 * What does the wall clock read in `timeZone` at instant `date`?
 *
 * Throws a plain Error on an invalid zone so callers can fall back to
 * "always open" rather than crashing the webhook.
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const lookup: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }

  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  const hour = Number(lookup.hour);
  const minute = Number(lookup.minute);
  const second = Number(lookup.second);

  const isoDate = `${lookup.year}-${lookup.month}-${lookup.day}`;
  // Derive the weekday from the calendar date rather than asking Intl
  // for a localized `weekday` string — that avoids depending on the
  // locale's abbreviation spelling.
  const dayKey = DAY_KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    isoDate,
    dayKey,
    minutes: hour * 60 + minute,
  };
}

/** Milliseconds `timeZone` is ahead of UTC at instant `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Wall-clock-as-UTC minus the true instant == the zone's offset.
  // Second-truncate the instant so the subtraction isn't skewed by ms.
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Wall-clock (`isoDate` + minutes-since-midnight) in `timeZone` -> UTC
 * instant. Iterates twice so a DST jump between the guess and the real
 * instant still converges.
 */
export function zonedTimeToUtc(
  isoDate: string,
  minutes: number,
  timeZone: string
): Date {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    instant = wallAsUtc - zoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dayKeyForIsoDate(isoDate: string): DayKey {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

function dayFor(config: BusinessHoursConfig, isoDate: string): DaySchedule | null {
  if (config.holidays?.includes(isoDate)) return null;
  const entry = config.schedule?.[dayKeyForIsoDate(isoDate)];
  if (!entry || entry.closed) return null;
  return entry;
}

/** Normalised, validated windows for a day — malformed ones dropped. */
function windowsFor(day: DaySchedule): { open: number; close: number }[] {
  const out: { open: number; close: number }[] = [];
  for (const w of day.windows ?? []) {
    const open = parseTimeToMinutes(w.open);
    const close = parseTimeToMinutes(w.close);
    if (open === null || close === null) continue;
    out.push({ open, close });
  }
  return out;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Is the account staffed at `at`?
 *
 * A disabled config, an unparseable timezone, or a missing schedule
 * all resolve to `true` ("always open") — business hours are an opt-in
 * restriction and must never silence an account by accident.
 */
export function isOpenAt(config: BusinessHoursConfig, at: Date): boolean {
  if (!config?.enabled) return true;

  let now: ZonedParts;
  try {
    now = zonedParts(at, config.timezone);
  } catch {
    return true;
  }

  // Today's windows.
  const today = dayFor(config, now.isoDate);
  if (today) {
    for (const { open, close } of windowsFor(today)) {
      if (close > open) {
        if (now.minutes >= open && now.minutes < close) return true;
      } else {
        // Spans midnight (or open === close, i.e. 24h): the open side
        // runs from `open` to the end of the day.
        if (now.minutes >= open) return true;
      }
    }
  }

  // Yesterday's midnight-spanning windows bleeding into today.
  const prevIso = shiftIsoDate(now.isoDate, -1);
  const yesterday = dayFor(config, prevIso);
  if (yesterday) {
    for (const { open, close } of windowsFor(yesterday)) {
      if (close <= open && now.minutes < close) return true;
    }
  }

  return false;
}

/**
 * The next instant the account opens after `from`, or null when the
 * schedule never opens within `horizonDays` (e.g. every day closed).
 */
export function nextOpenAt(
  config: BusinessHoursConfig,
  from: Date,
  horizonDays = 14
): Date | null {
  if (!config?.enabled) return null;

  let start: ZonedParts;
  try {
    start = zonedParts(from, config.timezone);
  } catch {
    return null;
  }

  for (let offset = 0; offset <= horizonDays; offset++) {
    const isoDate = shiftIsoDate(start.isoDate, offset);
    const day = dayFor(config, isoDate);
    if (!day) continue;

    const opens = windowsFor(day)
      .map((w) => w.open)
      .sort((a, b) => a - b);

    for (const open of opens) {
      // Same-day windows already past are not "next".
      if (offset === 0 && open <= start.minutes) continue;
      return zonedTimeToUtc(isoDate, open, config.timezone);
    }
  }

  return null;
}

/**
 * Human label for the next opening, rendered in the account timezone —
 * "tomorrow at 9:00 AM", "Monday at 9:00 AM". Returns null when the
 * schedule has no next opening, so callers can drop the sentence
 * instead of printing "null".
 */
export function describeNextOpen(
  config: BusinessHoursConfig,
  from: Date,
  locale = 'en-US'
): string | null {
  const next = nextOpenAt(config, from);
  if (!next) return null;

  let fromParts: ZonedParts;
  let nextParts: ZonedParts;
  try {
    fromParts = zonedParts(from, config.timezone);
    nextParts = zonedParts(next, config.timezone);
  } catch {
    return null;
  }

  const time = new Intl.DateTimeFormat(locale, {
    timeZone: config.timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(next);

  if (nextParts.isoDate === fromParts.isoDate) return `today at ${time}`;
  if (nextParts.isoDate === shiftIsoDate(fromParts.isoDate, 1)) {
    return `tomorrow at ${time}`;
  }

  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone: config.timezone,
    weekday: 'long',
  }).format(next);
  return `${weekday} at ${time}`;
}

/**
 * Fill the away-message placeholders. Unknown placeholders are left
 * alone (an operator typo shouldn't blank out their message), and a
 * missing next-open collapses the surrounding whitespace so the
 * sentence still reads cleanly.
 */
export function renderAwayMessage(
  template: string,
  vars: { contactName?: string | null; nextOpen?: string | null }
): string {
  return template
    .replace(/\{\{\s*contact_name\s*\}\}/g, vars.contactName?.trim() || 'there')
    .replace(/\{\{\s*next_open\s*\}\}/g, vars.nextOpen?.trim() || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

export const DEFAULT_SCHEDULE: WeeklySchedule = {
  sun: { closed: true, windows: [] },
  mon: { closed: false, windows: [{ open: '09:00', close: '18:00' }] },
  tue: { closed: false, windows: [{ open: '09:00', close: '18:00' }] },
  wed: { closed: false, windows: [{ open: '09:00', close: '18:00' }] },
  thu: { closed: false, windows: [{ open: '09:00', close: '18:00' }] },
  fri: { closed: false, windows: [{ open: '09:00', close: '18:00' }] },
  sat: { closed: true, windows: [] },
};

// ============================================================
// Business-hours row -> validated runtime config.
//
// Everything here is defensive: the `schedule` and `holidays` columns
// are JSONB, so a hand-edited row (or an older client) can put
// anything in them. A malformed field degrades to its default rather
// than throwing — this code runs on the inbound webhook path, where a
// crash means a dropped customer message.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DAY_KEYS,
  DEFAULT_SCHEDULE,
  type BusinessHoursConfig,
  type DaySchedule,
  type OpenWindow,
  type WeeklySchedule,
  parseTimeToMinutes,
} from './schedule';

export interface BusinessHoursSettings extends BusinessHoursConfig {
  awayMessageEnabled: boolean;
  awayMessage: string;
  awayThrottleMinutes: number;
  pauseAutomations: boolean;
  pauseAiAutoreply: boolean;
}

export const DEFAULT_AWAY_MESSAGE =
  "Thanks for reaching out! We're currently closed. Our team will reply when we reopen {{next_open}}.";

/** "Always open" — what an account with no row (or a broken one) gets. */
export const ALWAYS_OPEN: BusinessHoursSettings = {
  enabled: false,
  timezone: 'UTC',
  schedule: DEFAULT_SCHEDULE,
  holidays: [],
  awayMessageEnabled: false,
  awayMessage: DEFAULT_AWAY_MESSAGE,
  awayThrottleMinutes: 240,
  pauseAutomations: false,
  pauseAiAutoreply: false,
};

function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function normalizeWindows(raw: unknown): OpenWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenWindow[] = [];
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue;
    const { open, close } = w as Record<string, unknown>;
    if (typeof open !== 'string' || typeof close !== 'string') continue;
    // Drop windows the evaluator could not read anyway, so the settings
    // UI and the webhook agree on what is actually in effect.
    if (parseTimeToMinutes(open) === null) continue;
    if (parseTimeToMinutes(close) === null) continue;
    out.push({ open, close });
  }
  return out;
}

export function normalizeSchedule(raw: unknown): WeeklySchedule {
  if (!raw || typeof raw !== 'object') return DEFAULT_SCHEDULE;
  const source = raw as Record<string, unknown>;
  const out = {} as WeeklySchedule;

  for (const key of DAY_KEYS) {
    const entry = source[key];
    if (!entry || typeof entry !== 'object') {
      // A missing day is closed, not "inherit the default" — otherwise
      // deleting a day from the JSON would silently reopen it.
      out[key] = { closed: true, windows: [] };
      continue;
    }
    const { closed, windows } = entry as Record<string, unknown>;
    const normalized: DaySchedule = {
      closed: closed === true,
      windows: normalizeWindows(windows),
    };
    // No usable window means closed regardless of the flag.
    if (normalized.windows.length === 0) normalized.closed = true;
    out[key] = normalized;
  }

  return out;
}

export function normalizeHolidays(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
  );
}

/** Row (any shape) -> settings, with every field defaulted. */
export function normalizeBusinessHoursRow(row: unknown): BusinessHoursSettings {
  if (!row || typeof row !== 'object') return ALWAYS_OPEN;
  const r = row as Record<string, unknown>;

  const throttle = Number(r.away_throttle_minutes);
  const awayMessage =
    typeof r.away_message === 'string' && r.away_message.trim()
      ? r.away_message
      : DEFAULT_AWAY_MESSAGE;

  return {
    enabled: r.enabled === true,
    timezone: isValidTimeZone(r.timezone) ? r.timezone : 'UTC',
    schedule: normalizeSchedule(r.schedule),
    holidays: normalizeHolidays(r.holidays),
    awayMessageEnabled: r.away_message_enabled !== false,
    awayMessage,
    awayThrottleMinutes:
      Number.isFinite(throttle) && throttle >= 0 ? Math.floor(throttle) : 240,
    pauseAutomations: r.pause_automations === true,
    pauseAiAutoreply: r.pause_ai_autoreply === true,
  };
}

/**
 * Load an account's business hours. Returns ALWAYS_OPEN when the
 * account has no row yet or the read fails — never throws, never
 * blocks the inbound path.
 */
export async function loadBusinessHours(
  db: SupabaseClient,
  accountId: string
): Promise<BusinessHoursSettings> {
  try {
    const { data, error } = await db
      .from('business_hours')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !data) return ALWAYS_OPEN;
    return normalizeBusinessHoursRow(data);
  } catch {
    return ALWAYS_OPEN;
  }
}

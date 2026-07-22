import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ALWAYS_OPEN,
  DEFAULT_AWAY_MESSAGE,
  loadBusinessHours,
  normalizeBusinessHoursRow,
  normalizeHolidays,
  normalizeSchedule,
} from "./config";
import { DAY_KEYS } from "./schedule";

/** Minimal stub of the one query chain loadBusinessHours uses. */
function stubDb(result: { data?: unknown; error?: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("normalizeSchedule", () => {
  it("keeps a well-formed day", () => {
    const out = normalizeSchedule({
      mon: { closed: false, windows: [{ open: "09:00", close: "17:00" }] },
    });
    expect(out.mon).toEqual({
      closed: false,
      windows: [{ open: "09:00", close: "17:00" }],
    });
  });

  it("closes every day that is absent from the JSON", () => {
    const out = normalizeSchedule({});
    for (const key of DAY_KEYS) {
      expect(out[key]).toEqual({ closed: true, windows: [] });
    }
  });

  it("drops windows with unparseable times", () => {
    const out = normalizeSchedule({
      mon: {
        closed: false,
        windows: [
          { open: "09:00", close: "17:00" },
          { open: "25:00", close: "17:00" },
          { open: "bad", close: "17:00" },
        ],
      },
    });
    expect(out.mon.windows).toEqual([{ open: "09:00", close: "17:00" }]);
  });

  it("marks a day closed once all its windows are dropped", () => {
    const out = normalizeSchedule({
      mon: { closed: false, windows: [{ open: "99:99", close: "17:00" }] },
    });
    expect(out.mon.closed).toBe(true);
  });

  it("marks a day with an empty window list closed", () => {
    const out = normalizeSchedule({ mon: { closed: false, windows: [] } });
    expect(out.mon.closed).toBe(true);
  });

  it("ignores non-object window entries", () => {
    const out = normalizeSchedule({
      mon: { closed: false, windows: ["nope", null, 42] },
    });
    expect(out.mon.windows).toEqual([]);
  });

  it("falls back to the default schedule for non-object input", () => {
    expect(normalizeSchedule(null).mon.closed).toBe(false);
    expect(normalizeSchedule("garbage").mon.closed).toBe(false);
  });
});

describe("normalizeHolidays", () => {
  it("keeps ISO dates and drops everything else", () => {
    expect(
      normalizeHolidays(["2026-01-26", "26-01-2026", "", null, 5, "2026-1-6"])
    ).toEqual(["2026-01-26"]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeHolidays(null)).toEqual([]);
    expect(normalizeHolidays({ a: 1 })).toEqual([]);
  });
});

describe("normalizeBusinessHoursRow", () => {
  it("reads a full row", () => {
    const out = normalizeBusinessHoursRow({
      enabled: true,
      timezone: "Asia/Kolkata",
      schedule: {
        mon: { closed: false, windows: [{ open: "10:00", close: "19:00" }] },
      },
      holidays: ["2026-01-26"],
      away_message_enabled: true,
      away_message: "Closed!",
      away_throttle_minutes: 60,
      pause_automations: true,
      pause_ai_autoreply: true,
    });

    expect(out.enabled).toBe(true);
    expect(out.timezone).toBe("Asia/Kolkata");
    expect(out.holidays).toEqual(["2026-01-26"]);
    expect(out.awayMessage).toBe("Closed!");
    expect(out.awayThrottleMinutes).toBe(60);
    expect(out.pauseAutomations).toBe(true);
    expect(out.pauseAiAutoreply).toBe(true);
  });

  it("falls back to UTC for an invalid timezone", () => {
    expect(normalizeBusinessHoursRow({ timezone: "Mars/Olympus" }).timezone).toBe(
      "UTC"
    );
    expect(normalizeBusinessHoursRow({ timezone: 42 }).timezone).toBe("UTC");
  });

  it("treats enabled as false unless it is exactly true", () => {
    expect(normalizeBusinessHoursRow({ enabled: "yes" }).enabled).toBe(false);
    expect(normalizeBusinessHoursRow({}).enabled).toBe(false);
  });

  it("defaults the away message when blank", () => {
    expect(normalizeBusinessHoursRow({ away_message: "   " }).awayMessage).toBe(
      DEFAULT_AWAY_MESSAGE
    );
  });

  it("defaults a negative or non-numeric throttle", () => {
    expect(
      normalizeBusinessHoursRow({ away_throttle_minutes: -5 }).awayThrottleMinutes
    ).toBe(240);
    expect(
      normalizeBusinessHoursRow({ away_throttle_minutes: "soon" })
        .awayThrottleMinutes
    ).toBe(240);
  });

  it("keeps a zero throttle (meaning: no silence window)", () => {
    expect(
      normalizeBusinessHoursRow({ away_throttle_minutes: 0 }).awayThrottleMinutes
    ).toBe(0);
  });

  it("returns ALWAYS_OPEN for a non-object row", () => {
    expect(normalizeBusinessHoursRow(null)).toEqual(ALWAYS_OPEN);
  });
});

describe("loadBusinessHours", () => {
  it("returns the normalized row", async () => {
    const db = stubDb({ data: { enabled: true, timezone: "Asia/Kolkata" } });
    const out = await loadBusinessHours(db, "acct-1");
    expect(out.enabled).toBe(true);
    expect(out.timezone).toBe("Asia/Kolkata");
  });

  it("returns ALWAYS_OPEN when the account has no row", async () => {
    expect(await loadBusinessHours(stubDb({ data: null }), "acct-1")).toEqual(
      ALWAYS_OPEN
    );
  });

  it("returns ALWAYS_OPEN when the query errors", async () => {
    const db = stubDb({ data: null, error: { message: "boom" } });
    expect(await loadBusinessHours(db, "acct-1")).toEqual(ALWAYS_OPEN);
  });

  it("returns ALWAYS_OPEN when the client throws", async () => {
    const db = {
      from() {
        throw new Error("network down");
      },
    } as unknown as SupabaseClient;
    expect(await loadBusinessHours(db, "acct-1")).toEqual(ALWAYS_OPEN);
  });
});

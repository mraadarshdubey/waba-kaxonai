import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  type BusinessHoursConfig,
  type WeeklySchedule,
  describeNextOpen,
  isOpenAt,
  minutesToTime,
  nextOpenAt,
  parseTimeToMinutes,
  renderAwayMessage,
  zonedParts,
  zonedTimeToUtc,
} from "./schedule";

const IST = "Asia/Kolkata";

function config(over: Partial<BusinessHoursConfig> = {}): BusinessHoursConfig {
  return {
    enabled: true,
    timezone: IST,
    schedule: DEFAULT_SCHEDULE,
    holidays: [],
    ...over,
  };
}

/** Build a schedule where every day shares the same windows. */
function everyDay(windows: { open: string; close: string }[]): WeeklySchedule {
  const day = { closed: false, windows };
  return {
    sun: day,
    mon: day,
    tue: day,
    wed: day,
    thu: day,
    fri: day,
    sat: day,
  };
}

describe("parseTimeToMinutes", () => {
  it("parses HH:MM", () => {
    expect(parseTimeToMinutes("09:30")).toBe(570);
    expect(parseTimeToMinutes("00:00")).toBe(0);
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });

  it("accepts a single-digit hour", () => {
    expect(parseTimeToMinutes("9:05")).toBe(545);
  });

  it("rejects out-of-range and malformed values", () => {
    expect(parseTimeToMinutes("24:00")).toBeNull();
    expect(parseTimeToMinutes("12:60")).toBeNull();
    expect(parseTimeToMinutes("nope")).toBeNull();
    expect(parseTimeToMinutes("")).toBeNull();
  });

  it("round-trips with minutesToTime", () => {
    expect(minutesToTime(parseTimeToMinutes("07:45")!)).toBe("07:45");
  });
});

describe("zonedParts", () => {
  it("reads the wall clock in the target zone", () => {
    // 2026-03-01T00:30:00Z is 06:00 on the 1st in IST (UTC+5:30).
    const p = zonedParts(new Date("2026-03-01T00:30:00Z"), IST);
    expect(p.isoDate).toBe("2026-03-01");
    expect(p.hour).toBe(6);
    expect(p.minutes).toBe(360);
    expect(p.dayKey).toBe("sun");
  });

  it("rolls the local date back when the zone is behind UTC", () => {
    // 03:00Z is still the previous evening in New York.
    const p = zonedParts(new Date("2026-03-02T03:00:00Z"), "America/New_York");
    expect(p.isoDate).toBe("2026-03-01");
    expect(p.dayKey).toBe("sun");
  });
});

describe("zonedTimeToUtc", () => {
  it("converts a wall-clock time back to the right instant", () => {
    const utc = zonedTimeToUtc("2026-03-02", 9 * 60, IST);
    expect(utc.toISOString()).toBe("2026-03-02T03:30:00.000Z");
  });

  it("survives a spring-forward DST boundary", () => {
    // US DST starts 2026-03-08. 09:00 local on the 9th is 13:00Z (EDT).
    const utc = zonedTimeToUtc("2026-03-09", 9 * 60, "America/New_York");
    expect(utc.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("survives a fall-back DST boundary", () => {
    // DST ends 2026-11-01. 09:00 local on the 2nd is 14:00Z (EST).
    const utc = zonedTimeToUtc("2026-11-02", 9 * 60, "America/New_York");
    expect(utc.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("isOpenAt", () => {
  it("is open inside a weekday window", () => {
    // Monday 2026-03-02, 11:00 IST -> 05:30Z.
    expect(isOpenAt(config(), new Date("2026-03-02T05:30:00Z"))).toBe(true);
  });

  it("is closed before opening", () => {
    // Monday 08:00 IST -> 02:30Z.
    expect(isOpenAt(config(), new Date("2026-03-02T02:30:00Z"))).toBe(false);
  });

  it("treats the close time as exclusive", () => {
    // Monday 18:00 IST exactly -> 12:30Z.
    expect(isOpenAt(config(), new Date("2026-03-02T12:30:00Z"))).toBe(false);
    // One minute before is still open.
    expect(isOpenAt(config(), new Date("2026-03-02T12:29:00Z"))).toBe(true);
  });

  it("treats the open time as inclusive", () => {
    // Monday 09:00 IST -> 03:30Z.
    expect(isOpenAt(config(), new Date("2026-03-02T03:30:00Z"))).toBe(true);
  });

  it("is closed on a day marked closed", () => {
    // Sunday 2026-03-01, 11:00 IST.
    expect(isOpenAt(config(), new Date("2026-03-01T05:30:00Z"))).toBe(false);
  });

  it("is closed all day on a holiday", () => {
    const cfg = config({ holidays: ["2026-03-02"] });
    expect(isOpenAt(cfg, new Date("2026-03-02T05:30:00Z"))).toBe(false);
  });

  it("respects a lunch break between two windows", () => {
    const cfg = config({
      schedule: everyDay([
        { open: "09:00", close: "13:00" },
        { open: "14:00", close: "18:00" },
      ]),
    });
    // 13:30 IST -> 08:00Z, inside the break.
    expect(isOpenAt(cfg, new Date("2026-03-02T08:00:00Z"))).toBe(false);
    // 14:30 IST -> 09:00Z, after the break.
    expect(isOpenAt(cfg, new Date("2026-03-02T09:00:00Z"))).toBe(true);
  });

  describe("windows spanning midnight", () => {
    const cfg = config({ schedule: everyDay([{ open: "22:00", close: "02:00" }]) });

    it("is open on the evening side", () => {
      // 23:00 IST Monday -> 17:30Z Monday.
      expect(isOpenAt(cfg, new Date("2026-03-02T17:30:00Z"))).toBe(true);
    });

    it("is open on the small-hours side of the next day", () => {
      // 01:00 IST Tuesday -> 19:30Z Monday.
      expect(isOpenAt(cfg, new Date("2026-03-02T19:30:00Z"))).toBe(true);
    });

    it("is closed in the daytime gap", () => {
      // 12:00 IST Tuesday -> 06:30Z Tuesday.
      expect(isOpenAt(cfg, new Date("2026-03-03T06:30:00Z"))).toBe(false);
    });

    it("does not bleed out of a day that is marked closed", () => {
      const sundayClosed = config({
        schedule: {
          ...everyDay([{ open: "22:00", close: "02:00" }]),
          sun: { closed: true, windows: [] },
        },
      });
      // 01:00 IST Monday is Sunday's spillover — Sunday is closed.
      expect(isOpenAt(sundayClosed, new Date("2026-03-01T19:30:00Z"))).toBe(false);
    });

    it("does not bleed out of a holiday", () => {
      const holiday = config({
        schedule: everyDay([{ open: "22:00", close: "02:00" }]),
        holidays: ["2026-03-02"],
      });
      // 01:00 IST Tuesday would be Monday's spillover, but Monday is a holiday.
      expect(isOpenAt(holiday, new Date("2026-03-02T19:30:00Z"))).toBe(false);
    });
  });

  it("treats open === close as open around the clock", () => {
    const cfg = config({ schedule: everyDay([{ open: "00:00", close: "00:00" }]) });
    expect(isOpenAt(cfg, new Date("2026-03-02T03:00:00Z"))).toBe(true);
    expect(isOpenAt(cfg, new Date("2026-03-02T20:00:00Z"))).toBe(true);
  });

  describe("fail-open behaviour", () => {
    it("is open when the feature is disabled", () => {
      const cfg = config({ enabled: false });
      // Sunday — would otherwise be closed.
      expect(isOpenAt(cfg, new Date("2026-03-01T05:30:00Z"))).toBe(true);
    });

    it("is open when the timezone is invalid", () => {
      const cfg = config({ timezone: "Not/AZone" });
      expect(isOpenAt(cfg, new Date("2026-03-01T05:30:00Z"))).toBe(true);
    });

    it("is closed, not crashing, when a window is malformed", () => {
      const cfg = config({ schedule: everyDay([{ open: "oops", close: "18:00" }]) });
      expect(isOpenAt(cfg, new Date("2026-03-02T05:30:00Z"))).toBe(false);
    });
  });
});

describe("nextOpenAt", () => {
  it("finds the same-day opening when asked before it", () => {
    // Monday 07:00 IST -> 01:30Z; opens 09:00 IST -> 03:30Z.
    const next = nextOpenAt(config(), new Date("2026-03-02T01:30:00Z"));
    expect(next?.toISOString()).toBe("2026-03-02T03:30:00.000Z");
  });

  it("skips to the next day once today's opening has passed", () => {
    // Monday 11:00 IST -> next is Tuesday 09:00 IST -> 03:30Z.
    const next = nextOpenAt(config(), new Date("2026-03-02T05:30:00Z"));
    expect(next?.toISOString()).toBe("2026-03-03T03:30:00.000Z");
  });

  it("skips closed weekend days", () => {
    // Saturday 2026-03-07 11:00 IST -> next is Monday the 9th.
    const next = nextOpenAt(config(), new Date("2026-03-07T05:30:00Z"));
    expect(next?.toISOString()).toBe("2026-03-09T03:30:00.000Z");
  });

  it("skips holidays", () => {
    const cfg = config({ holidays: ["2026-03-03"] });
    // Monday 11:00 IST -> Tuesday is a holiday, so Wednesday.
    const next = nextOpenAt(cfg, new Date("2026-03-02T05:30:00Z"));
    expect(next?.toISOString()).toBe("2026-03-04T03:30:00.000Z");
  });

  it("returns the earliest window of a multi-window day", () => {
    const cfg = config({
      schedule: everyDay([
        { open: "14:00", close: "18:00" },
        { open: "09:00", close: "13:00" },
      ]),
    });
    const next = nextOpenAt(cfg, new Date("2026-03-02T01:30:00Z"));
    // 09:00 IST, not 14:00, even though it is listed second.
    expect(next?.toISOString()).toBe("2026-03-02T03:30:00.000Z");
  });

  it("returns null when every day is closed", () => {
    const cfg = config({
      schedule: {
        sun: { closed: true, windows: [] },
        mon: { closed: true, windows: [] },
        tue: { closed: true, windows: [] },
        wed: { closed: true, windows: [] },
        thu: { closed: true, windows: [] },
        fri: { closed: true, windows: [] },
        sat: { closed: true, windows: [] },
      },
    });
    expect(nextOpenAt(cfg, new Date("2026-03-02T05:30:00Z"))).toBeNull();
  });

  it("returns null when disabled", () => {
    expect(nextOpenAt(config({ enabled: false }), new Date())).toBeNull();
  });
});

describe("describeNextOpen", () => {
  it("says 'today' for a later opening the same day", () => {
    // Monday 07:00 IST, opens 09:00 IST.
    const label = describeNextOpen(config(), new Date("2026-03-02T01:30:00Z"));
    expect(label).toMatch(/^today at /);
  });

  it("says 'tomorrow' for the next calendar day", () => {
    // Monday 11:00 IST -> Tuesday 09:00.
    const label = describeNextOpen(config(), new Date("2026-03-02T05:30:00Z"));
    expect(label).toMatch(/^tomorrow at /);
  });

  it("names the weekday when further out", () => {
    // Saturday -> Monday.
    const label = describeNextOpen(config(), new Date("2026-03-07T05:30:00Z"));
    expect(label).toMatch(/^Monday at /);
  });

  it("returns null when there is no next opening", () => {
    expect(describeNextOpen(config({ enabled: false }), new Date())).toBeNull();
  });
});

describe("renderAwayMessage", () => {
  it("substitutes both placeholders", () => {
    const out = renderAwayMessage(
      "Hi {{contact_name}}, we reopen {{next_open}}.",
      { contactName: "Asha", nextOpen: "Monday at 9:00 AM" }
    );
    expect(out).toBe("Hi Asha, we reopen Monday at 9:00 AM.");
  });

  it("falls back to 'there' when the contact has no name", () => {
    expect(renderAwayMessage("Hi {{contact_name}}!", { contactName: null })).toBe(
      "Hi there!"
    );
    expect(renderAwayMessage("Hi {{contact_name}}!", { contactName: "  " })).toBe(
      "Hi there!"
    );
  });

  it("drops a missing next-open without leaving a gap before punctuation", () => {
    const out = renderAwayMessage("We reopen {{next_open}}. Thanks!", {
      nextOpen: null,
    });
    expect(out).toBe("We reopen. Thanks!");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderAwayMessage("Hi {{ contact_name }}", { contactName: "Ravi" })).toBe(
      "Hi Ravi"
    );
  });

  it("leaves unknown placeholders untouched", () => {
    const out = renderAwayMessage("Hi {{nickname}}", { contactName: "Ravi" });
    expect(out).toBe("Hi {{nickname}}");
  });
});

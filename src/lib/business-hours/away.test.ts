import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const sendText = vi.hoisted(() =>
  vi.fn(
    async (_args: {
      accountId: string;
      userId: string;
      conversationId: string;
      contactId: string;
      text: string;
    }) => ({ whatsapp_message_id: "wamid.1" })
  )
);
vi.mock("@/lib/automations/meta-send", () => ({ engineSendText: sendText }));

import { dispatchAwayMessage } from "./away";
import { ALWAYS_OPEN, type BusinessHoursSettings } from "./config";
import { DEFAULT_SCHEDULE } from "./schedule";

const IST = "Asia/Kolkata";
/** Sunday 2026-03-01, 11:00 IST — closed under DEFAULT_SCHEDULE. */
const CLOSED_NOW = new Date("2026-03-01T05:30:00Z");
/** Monday 2026-03-02, 11:00 IST — open under DEFAULT_SCHEDULE. */
const OPEN_NOW = new Date("2026-03-02T05:30:00Z");

function settings(over: Partial<BusinessHoursSettings> = {}): BusinessHoursSettings {
  return {
    ...ALWAYS_OPEN,
    enabled: true,
    timezone: IST,
    schedule: DEFAULT_SCHEDULE,
    awayMessageEnabled: true,
    awayMessage: "We're closed. Back {{next_open}}.",
    awayThrottleMinutes: 240,
    ...over,
  };
}

interface ClaimSpy {
  db: SupabaseClient;
  updates: Record<string, unknown>[];
  orFilters: string[];
}

/**
 * Stubs the conditional-update claim. `claimed` decides whether the
 * UPDATE matched a row (i.e. whether this caller won the throttle).
 */
function claimDb(claimed: boolean, error?: unknown): ClaimSpy {
  const updates: Record<string, unknown>[] = [];
  const orFilters: string[] = [];

  const chain = {
    eq: () => chain,
    or: (expr: string) => {
      orFilters.push(expr);
      return chain;
    },
    select: () => chain,
    maybeSingle: async () => ({
      data: claimed ? { id: "cv-1" } : null,
      error: error ?? null,
    }),
  };

  const db = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return chain;
      },
    }),
  } as unknown as SupabaseClient;

  return { db, updates, orFilters };
}

function args(over: Partial<Parameters<typeof dispatchAwayMessage>[0]> = {}) {
  return {
    db: claimDb(true).db,
    settings: settings(),
    accountId: "acct-1",
    userId: "user-1",
    conversationId: "cv-1",
    contactId: "ct-1",
    contactName: "Asha",
    now: CLOSED_NOW,
    ...over,
  };
}

beforeEach(() => {
  sendText.mockClear();
});

describe("dispatchAwayMessage — gates", () => {
  it("sends when closed and everything is enabled", async () => {
    expect(await dispatchAwayMessage(args())).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("does nothing when business hours are disabled", async () => {
    const sent = await dispatchAwayMessage(
      args({ settings: settings({ enabled: false }) })
    );
    expect(sent).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does nothing when the away message is turned off", async () => {
    const sent = await dispatchAwayMessage(
      args({ settings: settings({ awayMessageEnabled: false }) })
    );
    expect(sent).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does nothing while the account is open", async () => {
    const sent = await dispatchAwayMessage(args({ now: OPEN_NOW }));
    expect(sent).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does nothing on a holiday that is also inside open hours... but sends when closed by holiday", async () => {
    // Monday 11:00 IST would be open, except the day is a holiday.
    const sent = await dispatchAwayMessage(
      args({ now: OPEN_NOW, settings: settings({ holidays: ["2026-03-02"] }) })
    );
    expect(sent).toBe(true);
  });
});

describe("dispatchAwayMessage — throttle claim", () => {
  it("stamps last_away_message_at before sending", async () => {
    const spy = claimDb(true);
    await dispatchAwayMessage(args({ db: spy.db }));
    expect(spy.updates).toHaveLength(1);
    expect(spy.updates[0].last_away_message_at).toBe(CLOSED_NOW.toISOString());
  });

  it("filters on the throttle window", async () => {
    const spy = claimDb(true);
    await dispatchAwayMessage(args({ db: spy.db }));
    // 240 minutes before CLOSED_NOW.
    expect(spy.orFilters[0]).toContain("last_away_message_at.is.null");
    expect(spy.orFilters[0]).toContain("2026-03-01T01:30:00.000Z");
  });

  it("does not send when another inbound already claimed the window", async () => {
    const spy = claimDb(false);
    expect(await dispatchAwayMessage(args({ db: spy.db }))).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not send when the claim update errors", async () => {
    const spy = claimDb(false, { message: "conflict" });
    expect(await dispatchAwayMessage(args({ db: spy.db }))).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("claims unconditionally when the throttle is zero", async () => {
    const spy = claimDb(true);
    await dispatchAwayMessage(
      args({ db: spy.db, settings: settings({ awayThrottleMinutes: 0 }) })
    );
    expect(spy.orFilters).toHaveLength(0);
    expect(sendText).toHaveBeenCalledOnce();
  });
});

describe("dispatchAwayMessage — message body", () => {
  it("renders the contact name and next opening", async () => {
    await dispatchAwayMessage(args());
    const text = sendText.mock.calls[0][0].text as string;
    // Sunday -> next opening is Monday 09:00 IST.
    expect(text).toBe("We're closed. Back tomorrow at 9:00 AM.");
  });

  it("falls back to 'there' when the contact is unnamed", async () => {
    await dispatchAwayMessage(
      args({
        contactName: null,
        settings: settings({ awayMessage: "Hi {{contact_name}}!" }),
      })
    );
    expect(sendText.mock.calls[0][0].text).toBe("Hi there!");
  });

  it("passes the account and conversation identifiers through", async () => {
    await dispatchAwayMessage(args());
    expect(sendText.mock.calls[0][0]).toMatchObject({
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "cv-1",
      contactId: "ct-1",
    });
  });
});

describe("dispatchAwayMessage — failure handling", () => {
  it("swallows a send failure and reports not-sent", async () => {
    sendText.mockRejectedValueOnce(new Error("Meta 500"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchAwayMessage(args())).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("swallows a database failure", async () => {
    const db = {
      from() {
        throw new Error("db gone");
      },
    } as unknown as SupabaseClient;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchAwayMessage(args({ db }))).toBe(false);
    errSpy.mockRestore();
  });
});

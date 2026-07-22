import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const deliver = vi.hoisted(() => vi.fn(async (_db: unknown, _plan: unknown) => {}));
vi.mock('./broadcast-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./broadcast-core')>();
  return { ...actual, deliverBroadcast: deliver };
});
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'BAD') throw new Error('key rotated');
    return `plain:${v}`;
  },
}));

import { cancelScheduledBroadcast, drainDueBroadcasts, rebuildPlan } from './broadcast-schedule';
import { resolveScheduledAt, MAX_SCHEDULE_AHEAD_DAYS } from './broadcast-core';
import { BroadcastError } from './broadcast-core';

// ------------------------------------------------------------
// resolveScheduledAt — pure, no DB
// ------------------------------------------------------------
describe('resolveScheduledAt', () => {
  const now = new Date('2026-03-02T10:00:00Z');

  it('returns null for an absent schedule (send now)', () => {
    expect(resolveScheduledAt(null, now)).toBeNull();
    expect(resolveScheduledAt(undefined, now)).toBeNull();
    expect(resolveScheduledAt('', now)).toBeNull();
  });

  it('returns an ISO string for a future time', () => {
    expect(resolveScheduledAt('2026-03-02T12:00:00Z', now)).toBe(
      '2026-03-02T12:00:00.000Z'
    );
  });

  it('treats a past time as send-now rather than parking it', () => {
    // A client clock a few seconds slow must not silently delay the
    // send until the next cron tick.
    expect(resolveScheduledAt('2026-03-02T09:59:00Z', now)).toBeNull();
  });

  it('treats exactly-now as send-now', () => {
    expect(resolveScheduledAt('2026-03-02T10:00:00Z', now)).toBeNull();
  });

  it('throws on an unparseable timestamp instead of sending immediately', () => {
    expect(() => resolveScheduledAt('next tuesday', now)).toThrow(BroadcastError);
  });

  it('rejects a schedule beyond the horizon', () => {
    const tooFar = new Date(
      now.getTime() + (MAX_SCHEDULE_AHEAD_DAYS + 1) * 86_400_000
    ).toISOString();
    expect(() => resolveScheduledAt(tooFar, now)).toThrow(/days ahead/);
  });

  it('accepts a schedule just inside the horizon', () => {
    const justInside = new Date(
      now.getTime() + (MAX_SCHEDULE_AHEAD_DAYS - 1) * 86_400_000
    ).toISOString();
    expect(resolveScheduledAt(justInside, now)).toBe(justInside);
  });
});

// ------------------------------------------------------------
// Fake Supabase
// ------------------------------------------------------------
interface TableData {
  broadcasts: Record<string, unknown>[];
  whatsapp_config: Record<string, unknown>[];
  message_templates: Record<string, unknown>[];
  broadcast_recipients: Record<string, unknown>[];
}

interface Spy {
  db: SupabaseClient;
  updates: { table: string; patch: Record<string, unknown> }[];
  data: TableData;
}

/**
 * Small in-memory stand-in supporting the exact chains this module
 * uses: select/eq/lte/order/limit and update/eq/eq/select/maybeSingle.
 */
function fakeDb(seed: Partial<TableData> = {}): Spy {
  const data: TableData = {
    broadcasts: [],
    whatsapp_config: [],
    message_templates: [],
    broadcast_recipients: [],
    ...seed,
  };
  const updates: { table: string; patch: Record<string, unknown> }[] = [];

  function from(table: keyof TableData) {
    let rows = [...data[table]];
    let mode: 'select' | 'update' = 'select';
    let patch: Record<string, unknown> = {};

    /** Apply a pending UPDATE to whatever the filters selected. */
    function commit() {
      if (mode !== 'update') return;
      mode = 'select'; // idempotent: awaiting twice must not double-apply
      updates.push({ table, patch });
      for (const r of rows) Object.assign(r, patch);
    }

    // The chain is itself thenable so `await db.from(..).select().eq(..)`
    // resolves to a list, while `.maybeSingle()` resolves to one row.
    // Keeping these separate matters: an earlier version returned a
    // thenable from maybeSingle(), so `await` unwrapped it back into the
    // list and "no row matched" looked like a successful match.
    const chain = {
      select: () => chain,
      order: () => chain,
      update(p: Record<string, unknown>) {
        mode = 'update';
        patch = p;
        return chain;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return chain;
      },
      lte(col: string, val: string) {
        rows = rows.filter((r) => String(r[col]) <= val);
        return chain;
      },
      limit(n: number) {
        rows = rows.slice(0, n);
        return chain;
      },
      async maybeSingle() {
        commit();
        return { data: rows[0] ?? null, error: null };
      },
      then(
        resolve: (v: { data: unknown[]; error: null }) => void
      ): void {
        commit();
        resolve({ data: rows, error: null });
      },
    };

    return chain;
  }

  return { db: { from } as unknown as SupabaseClient, updates, data };
}

const CONFIG = {
  account_id: 'acct-1',
  phone_number_id: 'pn-1',
  access_token: 'TOKEN',
  status: 'connected',
};

function broadcastRow(over: Record<string, unknown> = {}) {
  return {
    id: 'bc-1',
    account_id: 'acct-1',
    template_name: 'promo',
    template_language: 'en_US',
    status: 'scheduled',
    scheduled_at: '2026-03-02T09:00:00Z',
    ...over,
  };
}

function recipientRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    broadcast_id: 'bc-1',
    status: 'pending',
    template_params: ['Asha'],
    contact: { phone: '+919000000001' },
    ...over,
  };
}

beforeEach(() => {
  deliver.mockClear();
});

// ------------------------------------------------------------
describe('rebuildPlan', () => {
  it('rebuilds a plan with a freshly decrypted token', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [recipientRow()],
    });

    const out = await rebuildPlan(db, 'bc-1');
    expect('plan' in out).toBe(true);
    if (!('plan' in out)) return;
    // Decrypted at send time, never persisted.
    expect(out.plan.accessToken).toBe('plain:TOKEN');
    expect(out.plan.phoneNumberId).toBe('pn-1');
    expect(out.plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '+919000000001', params: ['Asha'] },
    ]);
  });

  it('fails when WhatsApp was disconnected after scheduling', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [],
      broadcast_recipients: [recipientRow()],
    });
    expect(await rebuildPlan(db, 'bc-1')).toEqual({
      error: 'whatsapp_not_configured',
    });
  });

  it('fails cleanly when ENCRYPTION_KEY was rotated', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [{ ...CONFIG, access_token: 'BAD' }],
      broadcast_recipients: [recipientRow()],
    });
    expect(await rebuildPlan(db, 'bc-1')).toEqual({
      error: 'whatsapp_not_configured',
    });
  });

  it('fails when no recipients are left to send', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [],
    });
    expect(await rebuildPlan(db, 'bc-1')).toEqual({ error: 'no_recipients' });
  });

  it('skips a recipient whose contact has no phone', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [
        recipientRow({ id: 'r-1', contact: { phone: null } }),
        recipientRow({ id: 'r-2' }),
      ],
    });
    const out = await rebuildPlan(db, 'bc-1');
    if (!('plan' in out)) throw new Error('expected a plan');
    expect(out.plan.planned.map((p) => p.recipientRowId)).toEqual(['r-2']);
  });

  it('defaults malformed template_params to an empty list', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [
        recipientRow({ template_params: { not: 'an array' } }),
      ],
    });
    const out = await rebuildPlan(db, 'bc-1');
    if (!('plan' in out)) throw new Error('expected a plan');
    expect(out.plan.planned[0].params).toEqual([]);
  });

  it('drops non-string entries inside template_params', async () => {
    const { db } = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [recipientRow({ template_params: ['a', 7, null] })],
    });
    const out = await rebuildPlan(db, 'bc-1');
    if (!('plan' in out)) throw new Error('expected a plan');
    expect(out.plan.planned[0].params).toEqual(['a']);
  });
});

// ------------------------------------------------------------
describe('drainDueBroadcasts', () => {
  it('delivers a due broadcast and claims it first', async () => {
    const spy = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [recipientRow()],
    });

    const out = await drainDueBroadcasts(spy.db, {
      now: new Date('2026-03-02T09:30:00Z'),
    });

    expect(out.processed).toBe(1);
    expect(deliver).toHaveBeenCalledOnce();
    // Claimed to 'sending' before any Meta call.
    expect(spy.updates[0].patch.status).toBe('sending');
  });

  it('ignores a broadcast whose time has not arrived', async () => {
    const spy = fakeDb({
      broadcasts: [broadcastRow({ scheduled_at: '2026-03-02T18:00:00Z' })],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [recipientRow()],
    });
    const out = await drainDueBroadcasts(spy.db, {
      now: new Date('2026-03-02T09:30:00Z'),
    });
    expect(out.processed).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('ignores broadcasts that are not scheduled', async () => {
    const spy = fakeDb({
      broadcasts: [broadcastRow({ status: 'cancelled' })],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [recipientRow()],
    });
    const out = await drainDueBroadcasts(spy.db, {
      now: new Date('2026-03-02T09:30:00Z'),
    });
    expect(out.processed).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('marks the broadcast failed and does not send when the plan cannot be rebuilt', async () => {
    const spy = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [],
      broadcast_recipients: [recipientRow()],
    });

    const out = await drainDueBroadcasts(spy.db, {
      now: new Date('2026-03-02T09:30:00Z'),
    });

    expect(out.processed).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.failures['bc-1']).toBe('whatsapp_not_configured');
    expect(deliver).not.toHaveBeenCalled();
    expect(spy.data.broadcasts[0].status).toBe('failed');
  });

  it('marks the broadcast failed when delivery throws', async () => {
    deliver.mockRejectedValueOnce(new Error('meta down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = fakeDb({
      broadcasts: [broadcastRow()],
      whatsapp_config: [CONFIG],
      broadcast_recipients: [recipientRow()],
    });

    const out = await drainDueBroadcasts(spy.db, {
      now: new Date('2026-03-02T09:30:00Z'),
    });

    expect(out.failed).toBe(1);
    expect(out.failures['bc-1']).toBe('internal');
    expect(spy.data.broadcasts[0].status).toBe('failed');
    errSpy.mockRestore();
  });

  it('returns an empty result when nothing is due', async () => {
    const spy = fakeDb({ broadcasts: [] });
    expect(
      await drainDueBroadcasts(spy.db, { now: new Date('2026-03-02T09:30:00Z') })
    ).toEqual({ processed: 0, failed: 0, failures: {} });
  });
});

// ------------------------------------------------------------
describe('cancelScheduledBroadcast', () => {
  it('cancels a queued broadcast', async () => {
    const spy = fakeDb({ broadcasts: [broadcastRow()] });
    expect(await cancelScheduledBroadcast(spy.db, 'bc-1')).toBe(true);
    expect(spy.data.broadcasts[0].status).toBe('cancelled');
  });

  it('refuses once the broadcast is already sending', async () => {
    // Messages are already going out; a half-sent broadcast must keep
    // its real outcome rather than reporting as cancelled.
    const spy = fakeDb({ broadcasts: [broadcastRow({ status: 'sending' })] });
    expect(await cancelScheduledBroadcast(spy.db, 'bc-1')).toBe(false);
    expect(spy.data.broadcasts[0].status).toBe('sending');
  });

  it('refuses for an already-sent broadcast', async () => {
    const spy = fakeDb({ broadcasts: [broadcastRow({ status: 'sent' })] });
    expect(await cancelScheduledBroadcast(spy.db, 'bc-1')).toBe(false);
  });
});

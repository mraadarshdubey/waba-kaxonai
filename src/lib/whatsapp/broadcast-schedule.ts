// ============================================================
// Scheduled broadcast drain.
//
// `createBroadcast` parks a future send as status='scheduled' and
// returns without delivering. This module is the other half: it finds
// due broadcasts, claims them, rebuilds the delivery plan from the
// database, and hands it to `deliverBroadcast`.
//
// The plan is rebuilt rather than persisted because it carries a
// decrypted access token, which must never be written to disk. Re-
// reading `whatsapp_config` at send time also means a token rotated
// between scheduling and sending is picked up automatically, and a
// disconnected number fails loudly instead of sending with a stale
// credential.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';
import { isMessageTemplate } from './template-row-guard';
import type { MessageTemplate } from '@/types';

/** Why a due broadcast could not be sent. Surfaced on the row. */
export type ScheduleFailure =
  | 'whatsapp_not_configured'
  | 'no_recipients'
  | 'internal';

export interface DrainResult {
  processed: number;
  failed: number;
  /** broadcastId -> reason, for the cron response / logs. */
  failures: Record<string, ScheduleFailure>;
}

/**
 * Rebuild a delivery plan for an already-persisted broadcast.
 * Returns null when the broadcast cannot be sent; the caller marks it
 * failed with the given reason.
 */
export async function rebuildPlan(
  db: SupabaseClient,
  broadcastId: string
): Promise<{ plan: BroadcastPlan } | { error: ScheduleFailure }> {
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .select('id, account_id, template_name, template_language')
    .eq('id', broadcastId)
    .maybeSingle();
  if (bErr || !broadcast) return { error: 'internal' };

  const { data: config } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token, status')
    .eq('account_id', broadcast.account_id)
    .maybeSingle();
  // A number disconnected after the broadcast was queued: fail the
  // row rather than throwing a token error per recipient.
  if (!config?.phone_number_id || !config?.access_token) {
    return { error: 'whatsapp_not_configured' };
  }

  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token as string);
  } catch {
    // ENCRYPTION_KEY rotated since the token was saved — the operator
    // has to reconnect WhatsApp. Same user-visible outcome.
    return { error: 'whatsapp_not_configured' };
  }

  const { data: rawTemplate } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .eq('name', broadcast.template_name)
    .maybeSingle();
  const templateRow: MessageTemplate | null = isMessageTemplate(rawTemplate)
    ? rawTemplate
    : null;

  // Only rows still pending are re-sent. A partially-delivered
  // broadcast (cron died mid-fan-out and the row was re-claimed) must
  // not double-message anyone who already received it.
  const { data: rows, error: rErr } = await db
    .from('broadcast_recipients')
    .select('id, template_params, contact:contacts(phone)')
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
  if (rErr) return { error: 'internal' };

  const planned = (rows ?? [])
    .map((row) => {
      // PostgREST types an embedded to-one as an array in some
      // versions; normalise both shapes.
      const embedded = row.contact as unknown;
      const contact = Array.isArray(embedded) ? embedded[0] : embedded;
      const phone = (contact as { phone?: string } | null)?.phone;
      if (!phone) return null;
      const params = Array.isArray(row.template_params)
        ? (row.template_params as unknown[]).filter(
            (p): p is string => typeof p === 'string'
          )
        : [];
      return { recipientRowId: row.id as string, phone, params };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (planned.length === 0) return { error: 'no_recipients' };

  return {
    plan: {
      broadcastId,
      templateName: broadcast.template_name as string,
      templateLanguage: (broadcast.template_language as string) || 'en_US',
      phoneNumberId: config.phone_number_id as string,
      accessToken,
      templateRow,
      planned,
      rejected: 0,
      scheduled: false,
      scheduledAt: null,
    },
  };
}

/**
 * Send every broadcast whose scheduled time has arrived.
 *
 * Claiming is a conditional UPDATE from 'scheduled' to 'sending', so
 * two overlapping cron invocations cannot both fan out the same
 * broadcast — the loser's update matches no row and it moves on.
 */
export async function drainDueBroadcasts(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number } = {}
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 25;

  const { data: due, error } = await db
    .from('broadcasts')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  if (error || !due || due.length === 0) {
    return { processed: 0, failed: 0, failures: {} };
  }

  const result: DrainResult = { processed: 0, failed: 0, failures: {} };

  for (const row of due) {
    const id = row.id as string;

    const { data: claim } = await db
      .from('broadcasts')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    // Someone else claimed it, or it was cancelled between the select
    // and here.
    if (!claim) continue;

    const built = await rebuildPlan(db, id);
    if ('error' in built) {
      await db
        .from('broadcasts')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', id);
      result.failed++;
      result.failures[id] = built.error;
      continue;
    }

    try {
      // Owns its own per-recipient error handling and sets the
      // terminal status when it finishes.
      await deliverBroadcast(db, built.plan);
      result.processed++;
    } catch (err) {
      console.error(`[broadcast-schedule] delivery failed for ${id}:`, err);
      await db
        .from('broadcasts')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', id);
      result.failed++;
      result.failures[id] = 'internal';
    }
  }

  return result;
}

/**
 * Cancel a queued broadcast. Only a broadcast still in 'scheduled'
 * can be cancelled — once the drain has claimed it messages are
 * already going out, and a half-sent broadcast must keep its real
 * outcome. Returns whether the cancel actually applied.
 */
export async function cancelScheduledBroadcast(
  db: SupabaseClient,
  broadcastId: string
): Promise<boolean> {
  const { data } = await db
    .from('broadcasts')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .eq('status', 'scheduled')
    .select('id')
    .maybeSingle();
  return !!data;
}

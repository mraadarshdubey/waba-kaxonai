// ============================================================
// Out-of-hours auto-reply.
//
// Called from the inbound webhook after the contact / conversation /
// message rows exist. Owns all of its own eligibility gates and never
// throws — a failure here must not cost us the 200 OK to Meta.
//
// The throttle is an *atomic claim*: two messages arriving in the same
// second race on a conditional UPDATE, and only the winner sends. A
// plain read-then-write would let a customer's three-message burst
// trigger three identical away replies.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendText } from '@/lib/automations/meta-send';
import { describeNextOpen, isOpenAt, renderAwayMessage } from './schedule';
import type { BusinessHoursSettings } from './config';

export interface AwayDispatchArgs {
  db: SupabaseClient;
  settings: BusinessHoursSettings;
  accountId: string;
  /** Account owner — used for the message's audit columns. */
  userId: string;
  conversationId: string;
  contactId: string;
  contactName?: string | null;
  /** Injectable for tests. */
  now?: Date;
}

/**
 * Send the away message if the account is closed and this conversation
 * has not already been told so recently. Resolves to whether a message
 * was actually sent (tests assert on this; callers may ignore it).
 */
export async function dispatchAwayMessage(
  args: AwayDispatchArgs
): Promise<boolean> {
  const {
    db,
    settings,
    accountId,
    userId,
    conversationId,
    contactId,
    contactName,
    now = new Date(),
  } = args;

  try {
    if (!settings.enabled || !settings.awayMessageEnabled) return false;
    if (isOpenAt(settings, now)) return false;

    // ---- Atomic throttle claim -------------------------------
    // Stamp the conversation first; only the request that wins the
    // conditional update goes on to send. A zero throttle means "no
    // silence window", so the claim is unconditional.
    let claim = db
      .from('conversations')
      .update({ last_away_message_at: now.toISOString() })
      .eq('id', conversationId);

    if (settings.awayThrottleMinutes > 0) {
      const cutoff = new Date(
        now.getTime() - settings.awayThrottleMinutes * 60_000
      ).toISOString();
      claim = claim.or(
        `last_away_message_at.is.null,last_away_message_at.lt.${cutoff}`
      );
    }

    const { data: claimed, error: claimErr } = await claim
      .select('id')
      .maybeSingle();

    // No row came back => another inbound already claimed this window.
    if (claimErr || !claimed) return false;

    // ---- Compose ---------------------------------------------
    const text = renderAwayMessage(settings.awayMessage, {
      contactName,
      nextOpen: describeNextOpen(settings, now),
    });
    if (!text) return false;

    await engineSendText({
      accountId,
      userId,
      conversationId,
      contactId,
      text,
    });

    return true;
  } catch (err) {
    // Deliberately swallowed. The stamp above stays in place so a
    // persistently failing send cannot turn into a retry loop that
    // hammers Meta on every inbound message.
    console.error('[business-hours] away message failed:', err);
    return false;
  }
}

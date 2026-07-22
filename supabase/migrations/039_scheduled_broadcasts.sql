-- ============================================================
-- SCHEDULED BROADCASTS
--
-- `broadcasts.scheduled_at` and the 'scheduled' status have existed
-- since 001, but nothing ever wrote them: `createBroadcast` always
-- inserted status='sending' and delivered immediately. The broadcast
-- wizard even has a step called "Schedule & send" with no schedule
-- control. This migration adds what a real scheduler needs.
--
-- ─── Why recipients need template_params ────────────────────
-- Per-recipient template variables used to live only in memory, in the
-- BroadcastPlan handed straight to deliverBroadcast. A scheduled send
-- happens minutes-to-weeks later in a different process, so the plan
-- has to be rebuildable from the database — which means the params
-- must be persisted. Doing so also gives an audit trail of exactly
-- what was substituted for each recipient.
--
-- The access token is deliberately NOT persisted anywhere: the drain
-- re-reads whatsapp_config and decrypts a fresh token at send time, so
-- a rotated token is picked up automatically.
-- ============================================================

-- Per-recipient positional template params ({{1}}, {{2}}…).
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS template_params JSONB NOT NULL DEFAULT '[]'::JSONB;

-- ============================================================
-- Allow cancelling a scheduled broadcast.
--
-- 001 pinned status to (draft, scheduled, sending, sent, failed).
-- Without 'cancelled' the only way to stop a queued send is deleting
-- the row, which also destroys its recipient list and audit trail.
-- ============================================================
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

-- ============================================================
-- Drain index.
--
-- Partial on status='scheduled' so it stays tiny regardless of how
-- much broadcast history accumulates — the cron only ever asks
-- "which scheduled broadcasts are due?".
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_broadcasts_due
  ON broadcasts(scheduled_at)
  WHERE status = 'scheduled';

-- A scheduled broadcast without a time would never be drained and
-- would sit queued forever. Enforce the pairing rather than relying
-- on application code to get it right.
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_scheduled_needs_time;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_scheduled_needs_time
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL);

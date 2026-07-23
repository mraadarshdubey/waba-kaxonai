-- ============================================================
-- ASSIGN A CONVERSATION TO THE AI (24/7 auto-reply)
--
-- Until now a thread had three AI states: default (auto-reply up to
-- the account's per-conversation cap, then wait for a human),
-- `ai_autoreply_disabled` (paused), or assigned to a human (AI stands
-- down). There was no way to say "let the AI own this thread and reply
-- to EVERY message, indefinitely".
--
-- `ai_assigned` is that fourth state. When true, the auto-reply engine
-- ignores the per-conversation cap and answers every inbound. The
-- account-wide master switch (ai_configs.auto_reply_enabled) and the
-- shared-key rate limit still apply — this bypasses the CAP, not the
-- safety valves.
--
-- Mutually exclusive with a human assignment: the app clears
-- assigned_agent_id when it sets ai_assigned, and clears ai_assigned
-- when a human is assigned. The partial index reflects how the engine
-- reads it (only the `true` rows matter).
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_assigned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_conversations_ai_assigned
  ON conversations(ai_assigned)
  WHERE ai_assigned = TRUE;

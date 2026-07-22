-- ============================================================
-- BUSINESS HOURS + AWAY MESSAGE
--
-- Lets an account declare when it is staffed. Outside those hours the
-- webhook can auto-reply once per conversation ("we'll get back to you
-- Monday 9am") and optionally hold back automations / the AI
-- auto-reply so a bot doesn't answer at 3am in the account's voice.
--
-- One row per account (UNIQUE account_id), created lazily by the
-- settings API — absence of a row means "always open", which is the
-- pre-migration behaviour. Nothing here changes existing installs
-- until an admin turns it on.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_hours (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,

  -- Master switch. When false every gate below is inert and the
  -- account behaves exactly as it did before this migration.
  enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- IANA zone (e.g. 'Asia/Kolkata'). All open/close times below are
  -- wall-clock times in THIS zone, so DST shifts are handled by the
  -- runtime's Intl data rather than stored offsets.
  timezone TEXT NOT NULL DEFAULT 'UTC',

  -- Weekly schedule, keyed by lowercase 3-letter day:
  --   { "mon": { "closed": false,
  --              "windows": [ { "open": "09:00", "close": "18:00" } ] },
  --     "sun": { "closed": true, "windows": [] }, ... }
  --
  -- Multiple windows per day support a lunch break. A window whose
  -- close is <= its open spans midnight (e.g. 22:00 -> 02:00) and is
  -- evaluated against the following day; see lib/business-hours.
  schedule JSONB NOT NULL DEFAULT '{
    "mon": {"closed": false, "windows": [{"open": "09:00", "close": "18:00"}]},
    "tue": {"closed": false, "windows": [{"open": "09:00", "close": "18:00"}]},
    "wed": {"closed": false, "windows": [{"open": "09:00", "close": "18:00"}]},
    "thu": {"closed": false, "windows": [{"open": "09:00", "close": "18:00"}]},
    "fri": {"closed": false, "windows": [{"open": "09:00", "close": "18:00"}]},
    "sat": {"closed": true, "windows": []},
    "sun": {"closed": true, "windows": []}
  }'::JSONB,

  -- Full-day closures as ISO dates in `timezone`: ["2026-01-26", ...].
  -- A holiday also suppresses that day's midnight-spanning spillover.
  holidays JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- Auto-reply sent on the first inbound of a closed period.
  -- Supports {{contact_name}} and {{next_open}} placeholders.
  away_message_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  away_message TEXT NOT NULL DEFAULT
    'Thanks for reaching out! We''re currently closed. Our team will reply when we reopen {{next_open}}.',

  -- Silence window per conversation. A customer sending five messages
  -- at midnight gets one away reply, not five. Re-arms after this many
  -- minutes so a genuinely new overnight conversation still gets one.
  away_throttle_minutes INTEGER NOT NULL DEFAULT 240
    CHECK (away_throttle_minutes >= 0),

  -- Optional gates. Off by default: turning on business hours should
  -- not silently disable automation an operator already relies on.
  pause_automations BOOLEAN NOT NULL DEFAULT FALSE,
  pause_ai_autoreply BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_hours_account
  ON business_hours(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON business_hours;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON business_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;

-- Any member may read (the inbox shows an "outside hours" badge to
-- everyone); only admins may change the schedule.
DROP POLICY IF EXISTS business_hours_select ON business_hours;
DROP POLICY IF EXISTS business_hours_insert ON business_hours;
DROP POLICY IF EXISTS business_hours_update ON business_hours;
DROP POLICY IF EXISTS business_hours_delete ON business_hours;

CREATE POLICY business_hours_select ON business_hours FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY business_hours_insert ON business_hours FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY business_hours_update ON business_hours FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY business_hours_delete ON business_hours FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));

-- ============================================================
-- Away-message throttle state
--
-- Lives on the conversation rather than a side table: it is read and
-- written on the same row the webhook already has in hand, so the
-- throttle costs no extra round-trip on the inbound hot path.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_away_message_at TIMESTAMPTZ;

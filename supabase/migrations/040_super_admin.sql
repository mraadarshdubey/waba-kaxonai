-- ============================================================
-- SUPER ADMIN (platform level) + ACCOUNT APPROVAL
--
-- Two independent but related capabilities:
--
--   1. `platform_admins` — users who operate the whole install:
--      list every account, approve/suspend accounts, change member
--      roles. Deliberately a separate table rather than a flag on
--      profiles: profiles is writable through app paths, and a bug
--      there must never be able to mint a super admin. This table
--      has NO client RLS grants at all — every read/write goes
--      through service-role API routes behind requireSuperAdmin().
--
--   2. `accounts.status` — approval-based signup. New accounts are
--      born 'pending' and cannot use the app until a super admin
--      approves them; 'suspended' shuts an account off later.
--      Enforcement lives in ONE place: is_account_member() now
--      requires the account to be active, which every RLS policy in
--      the schema already funnels through. No per-table changes.
--
-- Super admins are "manage + oversight" by design: the admin API
-- exposes account metadata, member rosters, and aggregate counts —
-- never conversation or message content.
-- ============================================================

-- ------------------------------------------------------------
-- platform_admins
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Who granted this (NULL for the bootstrap row).
  added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: with RLS enabled and zero policies,
-- `authenticated` can do nothing here even though 038's blanket
-- GRANT applies. Only the service role (which bypasses RLS) can
-- touch this table.

-- ------------------------------------------------------------
-- accounts.status
-- ------------------------------------------------------------
-- Existing accounts are grandfathered in as 'active' (the ADD COLUMN
-- default backfills them); only rows created after the default flips
-- below are born 'pending'.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('pending', 'active', 'suspended'));

ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_accounts_status
  ON accounts(status)
  WHERE status <> 'active';

-- ------------------------------------------------------------
-- is_account_member: require an active account
--
-- Single chokepoint — every tenancy policy in the schema calls this,
-- so a pending or suspended account loses all data access in one
-- move, without touching 36 tables' policies. Signature unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a
      ON a.id = p.account_id
     AND a.status = 'active'
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;

-- A pending/suspended owner can no longer pass is_account_member, but
-- the "waiting for approval" screen still needs to show them their own
-- account's name and status. Owner-reads-own-row, regardless of status.
DROP POLICY IF EXISTS accounts_select_own ON accounts;
CREATE POLICY accounts_select_own ON accounts FOR SELECT
  USING (owner_user_id = auth.uid());

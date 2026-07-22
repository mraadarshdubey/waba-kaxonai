-- ============================================================
-- RESTORE TABLE GRANTS FOR `authenticated` / `service_role`
--
-- ─── Why this exists ────────────────────────────────────────
-- Every table in this schema is protected by RLS, and the app was
-- written against Supabase's historic default privileges, where new
-- tables in `public` were automatically granted to `anon`,
-- `authenticated`, and `service_role` (RLS then did the real work of
-- deciding which *rows* each caller sees).
--
-- Recent Supabase releases dropped that blanket default. On such a
-- stack `pg_default_acl` for role `postgres` in `public` reads:
--
--     authenticated=Dxtm/postgres
--
-- i.e. TRUNCATE / REFERENCES / TRIGGER / MAINTAIN but **no SELECT,
-- INSERT, UPDATE or DELETE**. The result is a database whose RLS
-- policies are all correct and yet every single query fails with:
--
--     42501: permission denied for table profiles
--
-- which surfaces in the app as a 403 "Could not load account context"
-- on literally every authenticated request — the dashboard cannot
-- even resolve who you are. This migration restores the privileges
-- the policies were designed to sit behind.
--
-- ─── Security note ──────────────────────────────────────────
-- Granting table privileges does NOT weaken RLS: row visibility is
-- still decided entirely by the policies in 001/017/etc. `anon` is
-- deliberately left with no access to `public` — nothing in this app
-- reads application tables while signed out (the invite landing page
-- goes through service-role API routes), so the stricter modern
-- default is kept for that role.
--
-- Idempotent: re-running only re-grants what is already granted.
-- ============================================================

-- Schema-level access first — without USAGE the table grants below
-- are unreachable.
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- ------------------------------------------------------------
-- Existing objects
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO authenticated, service_role;

-- uuid_generate_v4() defaults mean no sequence is strictly required
-- today, but a future SERIAL column would fail confusingly without
-- this.
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;

-- RLS policies call helpers such as `is_account_member()`. Policy
-- expressions are evaluated as the querying role, so that role needs
-- EXECUTE on them.
GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA public
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Future objects
--
-- So a later migration that adds a table does not silently ship an
-- unreadable one. Scoped to `postgres`, the role migrations run as.
-- ------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- ============================================================
-- Re-apply the column-level restrictions the blanket grant above
-- would otherwise have widened.
--
-- Migration 027 deliberately narrows `notifications` so a client can
-- only ever flip `read_at` — never rewrite a notification's title or
-- body. `GRANT ... ON ALL TABLES` re-granted full UPDATE, so the
-- narrowing has to be restated here. Keep these two blocks in sync if
-- 027 ever changes.
-- ============================================================
REVOKE UPDATE ON notifications FROM authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;

-- notifications rows are created exclusively by the SECURITY DEFINER
-- trigger in 027, never by a client.
REVOKE INSERT, DELETE ON notifications FROM authenticated;

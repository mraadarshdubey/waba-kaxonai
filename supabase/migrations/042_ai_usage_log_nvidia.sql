-- ============================================================
-- FIX: allow 'nvidia' in ai_usage_log.provider
--
-- Migration 041 added 'nvidia' to ai_configs.provider but MISSED the
-- matching CHECK on ai_usage_log — so every NVIDIA draft/auto-reply
-- generated fine but its usage row failed to insert with
-- 23514 "violates check constraint ai_usage_log_provider_check",
-- spamming the logs and silently zeroing NVIDIA usage tracking.
--
-- The two constraints must always list the same providers; keep them
-- in sync if a provider is ever added again.
--
-- Idempotent: drop-and-recreate of a named CHECK constraint.
-- ============================================================

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'nvidia'));

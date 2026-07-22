-- ============================================================
-- AI PROVIDER: NVIDIA (NIM)
--
-- Adds 'nvidia' to the ai_configs provider CHECK. NVIDIA's NIM API
-- (integrate.api.nvidia.com) is OpenAI-compatible and serves open
-- models (Llama, Qwen, DeepSeek…) with a free tier — a BYO key from
-- build.nvidia.com works without a paid plan, which makes it the
-- cheapest way to run the AI assistant.
--
-- Idempotent: drop-and-recreate of a named CHECK constraint.
-- ============================================================

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'nvidia'));

import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// NVIDIA NIM (build.nvidia.com). The endpoint speaks the OpenAI Chat
// Completions dialect, so this adapter mirrors providers/openai.ts —
// different URL, `max_tokens` instead of `max_completion_tokens`
// (NIM predates the rename), and reasoning-trace stripping below.
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'

interface NvidiaResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Some models NIM hosts (DeepSeek-R1, Qwen-thinking variants) prepend
 * their chain of thought in a <think>…</think> block. That must never
 * reach a WhatsApp customer, so strip it — and if the model somehow
 * produced ONLY reasoning, treat it as an empty response rather than
 * sending the customer a wall of deliberation.
 */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/**
 * Call NVIDIA NIM with the caller's own key (nvapi-…). Returns the raw
 * assistant text + token usage (handoff parsing happens in
 * `generateReply`).
 */
export async function generateNvidia(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        // Deterministic-ish customer replies; NIM defaults vary by model.
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('NVIDIA', res)
  }

  const data = (await res.json().catch(() => null)) as NvidiaResponse | null
  const raw = data?.choices?.[0]?.message?.content
  const text = typeof raw === 'string' ? stripReasoning(raw) : ''
  if (!text) {
    throw new AiError('NVIDIA returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
